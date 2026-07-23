import { realpath, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FileDeliveryError, type FileSender } from "./types.ts";

const MAX_FILE_SIZE = 30 * 1024 * 1024;

interface DeliveryFileSystem {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<{ isFile(): boolean; size: number }>;
	unlink(path: string): Promise<void>;
}

export interface DeliverFileToolOptions {
	workspace: string;
	chatId: string;
	fileSender: FileSender;
	fileSystem?: DeliveryFileSystem;
}

function toolError(message: string): Error {
	return new Error(`文件回传失败：${message}`);
}

export function createDeliverFileTool(options: DeliverFileToolOptions) {
	const fileSystem: DeliveryFileSystem = options.fileSystem ?? { realpath, stat, unlink };

	return defineTool({
		name: "deliver_file",
		label: "Deliver File",
		description: "Upload and send one non-empty file from the configured workspace to the current Feishu chat",
		promptSnippet: "Send a completed workspace file to the current Feishu chat",
		promptGuidelines: [
			"Use deliver_file when the user asks to download or receive a completed file.",
			"Only use deliver_file for final user-facing files, not internal intermediate files.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the completed file inside the workspace" }),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw toolError("操作已中止，文件已保留。");

			const inputPath = params.path.startsWith("@") ? params.path.slice(1) : params.path;
			const unresolvedFilePath = resolve(options.workspace, inputPath);
			return withFileMutationQueue(unresolvedFilePath, async () => {
				let workspacePath: string;
				let filePath: string;
				try {
					workspacePath = await fileSystem.realpath(options.workspace);
					filePath = await fileSystem.realpath(resolve(options.workspace, inputPath));
				} catch {
					throw toolError("文件不存在。");
				}

				const pathFromWorkspace = relative(workspacePath, filePath);
				if (
					pathFromWorkspace === ".." ||
					pathFromWorkspace.startsWith(`..${sep}`) ||
					isAbsolute(pathFromWorkspace)
				) {
					throw toolError("文件不在工作目录内。");
				}

				let fileStat: { isFile(): boolean; size: number };
				try {
					fileStat = await fileSystem.stat(filePath);
				} catch {
					throw toolError("文件不存在。");
				}
				if (!fileStat.isFile()) throw toolError("目标不是普通文件。");
				if (fileStat.size === 0) throw toolError("文件为空。");
				if (fileStat.size > MAX_FILE_SIZE) throw toolError("文件超过 30 MB。");

				const fileName = basename(filePath);
				try {
					await options.fileSender.sendFile(options.chatId, filePath, fileName);
				} catch (error) {
					if (error instanceof FileDeliveryError && error.stage === "message") {
						throw toolError("飞书文件消息发送失败，文件已保留，可再次尝试。");
					}
					throw toolError("飞书文件上传失败，文件已保留，可再次尝试。");
				}

				try {
					await fileSystem.unlink(filePath);
				} catch (error) {
					console.error(`File delivered but local cleanup failed: ${filePath}`, error);
					return {
						content: [
							{ type: "text" as const, text: `文件 ${fileName} 已发送，但本地清理失败。请明确告知用户。` },
						],
						details: { fileName, delivered: true, cleanedUp: false },
					};
				}

				return {
					content: [{ type: "text" as const, text: `文件 ${fileName} 已发送并已清理本地副本。` }],
					details: { fileName, delivered: true, cleanedUp: true },
				};
			});
		},
	});
}
