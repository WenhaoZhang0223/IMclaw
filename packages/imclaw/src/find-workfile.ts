import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isPathInside, resolveWorkfileRoot } from "./workfile-path.ts";

const RESULT_LIMIT = 10;
const INTENT_WORDS = /(?:请|麻烦|帮我|把|那个|这个|文件|发给我|发送给我|给我|发一下|发送|一下)/giu;

export interface WorkfileCandidate {
	path: string;
	fileName: string;
	extension: string;
	size: number;
	modifiedAt: string;
	score: number;
}

export interface WorkfileSearchFileSystem {
	realpath(path: string): Promise<string>;
	readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
	stat(path: string): Promise<Stats>;
}

export interface FindWorkfilesOptions {
	workspace: string;
	fileSystem?: WorkfileSearchFileSystem;
}

function normalize(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase()
		.replace(/[\s\-_./\\]+/gu, "");
}

function queryTerms(query: string): string[] {
	return query
		.replace(INTENT_WORDS, " ")
		.split(/[^\p{Letter}\p{Number}]+/u)
		.map(normalize)
		.filter(Boolean);
}

function scoreCandidate(query: string, relativePath: string, modifiedMs: number): number {
	const queryWithoutIntent = query.replace(INTENT_WORDS, "");
	const normalizedQuery = normalize(queryWithoutIntent);
	const normalizedPath = normalize(relativePath);
	const normalizedName = normalize(basename(relativePath));
	const normalizedStem = normalize(basename(relativePath, extname(relativePath)));
	let score = normalizedName === normalizedQuery || normalizedStem === normalizedQuery ? 1000 : 0;
	if (normalizedQuery && (normalizedName.includes(normalizedQuery) || normalizedStem.includes(normalizedQuery))) {
		score += 500;
	}
	if (normalizedQuery && normalizedPath.includes(normalizedQuery)) score += 300;
	for (const term of queryTerms(query)) {
		if (normalizedName.includes(term) || normalizedStem.includes(term)) score += 120;
		else if (normalizedPath.includes(term)) score += 60;
	}
	if (score > 0 && /(?:最新|最近)/u.test(query)) score += modifiedMs / 1_000_000_000_000;
	return score;
}

export async function findWorkfiles(options: FindWorkfilesOptions, query: string): Promise<WorkfileCandidate[]> {
	const fileSystem: WorkfileSearchFileSystem = options.fileSystem ?? { realpath, readdir, stat };
	let rootPath: string;
	try {
		rootPath = await resolveWorkfileRoot(options.workspace, fileSystem.realpath);
		await fileSystem.readdir(rootPath, { withFileTypes: true });
	} catch {
		throw new Error("workfile 文件库不存在或无法读取。");
	}

	const directories = [rootPath];
	const candidates: Array<WorkfileCandidate & { modifiedMs: number }> = [];
	while (directories.length > 0) {
		const directory = directories.shift();
		if (!directory) break;
		let entries: Dirent[];
		try {
			entries = await fileSystem.readdir(directory, { withFileTypes: true });
		} catch (error) {
			console.error(`Unable to scan workfile directory: ${directory}`, error);
			continue;
		}
		for (const entry of entries) {
			const entryPath = join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				directories.push(entryPath);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const filePath = await fileSystem.realpath(entryPath);
				if (!isPathInside(rootPath, filePath)) continue;
				const fileStat = await fileSystem.stat(filePath);
				if (!fileStat.isFile()) continue;
				const relativePath = relative(rootPath, filePath).split(sep).join("/");
				candidates.push({
					path: relativePath,
					fileName: basename(filePath),
					extension: extname(filePath).toLocaleLowerCase(),
					size: fileStat.size,
					modifiedAt: fileStat.mtime.toISOString(),
					modifiedMs: fileStat.mtimeMs,
					score: scoreCandidate(query, relativePath, fileStat.mtimeMs),
				});
			} catch (error) {
				console.error(`Unable to inspect workfile entry: ${entryPath}`, error);
			}
		}
	}

	return candidates
		.filter((candidate) => candidate.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score || right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path),
		)
		.slice(0, RESULT_LIMIT)
		.map(({ modifiedMs: _modifiedMs, ...candidate }) => candidate);
}

export function createFindWorkfileTool(options: FindWorkfilesOptions) {
	return defineTool({
		name: "find_workfile",
		label: "Find Workfile",
		description: "Search the read-only workfile library by file and directory metadata",
		promptSnippet: "Find an existing user-owned file in the read-only workfile library",
		promptGuidelines: [
			"Use find_workfile before sending an existing file from workfile.",
			"Use concise identifying keywords from the user's request.",
		],
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				description: "Natural-language file description or identifying keywords",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("workfile 检索已中止。");
			const candidates = await findWorkfiles(options, params.query);
			return {
				content: [
					{
						type: "text" as const,
						text:
							candidates.length === 0
								? "未找到匹配文件，请补充文件名、目录、类型或时间信息。"
								: JSON.stringify(candidates),
					},
				],
				details: { candidates },
			};
		},
	});
}
