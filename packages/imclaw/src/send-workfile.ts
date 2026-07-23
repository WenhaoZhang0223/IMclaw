import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FileDeliveryError, type FileSender } from "./types.ts";
import { isPathInside, resolveWorkfileRoot, WORKFILE_DIRECTORY_NAME } from "./workfile-path.ts";

const MAX_FILE_SIZE = 30 * 1024 * 1024;

interface WorkfileSendFileSystem {
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<{ isFile(): boolean; size: number }>;
}

export interface SendWorkfileToolOptions {
	workspace: string;
	chatId: string;
	fileSender: FileSender;
	fileSystem?: WorkfileSendFileSystem;
}

function toolError(message: string): Error {
	return new Error(`workfile 文件发送失败：${message}`);
}

export function createSendWorkfileTool(options: SendWorkfileToolOptions) {
	const fileSystem: WorkfileSendFileSystem = options.fileSystem ?? { realpath, stat };

	return defineTool({
		name: "send_workfile",
		label: "Send Workfile",
		description: "Send one previously found file from the read-only workfile library to the current Feishu chat",
		promptSnippet: "Send a selected file from the read-only workfile library",
		promptGuidelines: [
			"Only pass a workfile-relative path returned by find_workfile.",
			"Never modify or delete a workfile file after sending it.",
		],
		parameters: Type.Object({
			path: Type.String({
				minLength: 1,
				description: "workfile-relative path returned by find_workfile",
			}),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw toolError("操作已中止，原文件已保留。");
			if (isAbsolute(params.path)) throw toolError("只接受 workfile 内的相对路径。");
			if (!params.path.trim() || params.path === ".") {
				throw toolError("只接受 workfile 内的文件相对路径。");
			}

			let rootPath: string;
			try {
				rootPath = await resolveWorkfileRoot(options.workspace, fileSystem.realpath);
			} catch {
				throw toolError("workfile 文件库不存在或无法读取。");
			}

			let filePath: string;
			try {
				filePath = await fileSystem.realpath(join(options.workspace, WORKFILE_DIRECTORY_NAME, params.path));
			} catch {
				throw toolError("文件不存在。");
			}
			if (!isPathInside(rootPath, filePath)) throw toolError("文件不在 workfile 文件库内。");

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
					throw toolError("飞书文件消息发送失败，原文件已保留，可再次尝试。");
				}
				throw toolError("飞书文件上传失败，原文件已保留，可再次尝试。");
			}

			const relativePath = relative(rootPath, filePath).split(sep).join("/");
			return {
				content: [
					{
						type: "text" as const,
						text: `文件 ${fileName} 已发送，workfile 中的原文件已保留。`,
					},
				],
				details: { fileName, path: relativePath, delivered: true, preserved: true },
			};
		},
	});
}
