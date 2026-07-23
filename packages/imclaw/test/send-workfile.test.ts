import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSendWorkfileTool } from "../src/send-workfile.ts";
import { FileDeliveryError, type FileSender } from "../src/types.ts";
import { isPathInside, resolveWorkfileRoot } from "../src/workfile-path.ts";

class FakeFileSender implements FileSender {
	readonly calls: Array<{ chatId: string; filePath: string; fileName: string }> = [];
	error: Error | undefined;

	async sendFile(chatId: string, filePath: string, fileName: string): Promise<void> {
		this.calls.push({ chatId, filePath, fileName });
		if (this.error) throw this.error;
	}
}

async function createWorkspace(): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "imclaw-send-workfile-"));
	await mkdir(join(workspace, "workfile"), { recursive: true });
	return workspace;
}

async function execute(workspace: string, sender: FileSender, path: string) {
	return createSendWorkfileTool({ workspace, chatId: "chat-1", fileSender: sender }).execute(
		"call-1",
		{ path },
		undefined,
		undefined,
		undefined as never,
	);
}

describe("workfile path boundary", () => {
	it("resolves the existing workfile directory and recognizes only descendants", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "imclaw-workfile-path-"));
		const root = join(workspace, "workfile");
		await mkdir(root);

		const resolvedRoot = await resolveWorkfileRoot(workspace);

		expect(resolvedRoot).toBe(await realpath(root));
		expect(isPathInside(resolvedRoot, join(resolvedRoot, "nested", "file.txt"))).toBe(true);
		expect(isPathInside(resolvedRoot, resolvedRoot)).toBe(false);
		expect(isPathInside(resolvedRoot, join(resolvedRoot, "..", "secret.txt"))).toBe(false);
	});

	it("does not treat a sibling with a shared prefix as inside", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "imclaw-workfile-prefix-"));
		const root = join(workspace, "workfile");
		await mkdir(root);

		expect(isPathInside(await realpath(root), join(workspace, "workfile-private", "secret.txt"))).toBe(false);
	});
});

describe("send_workfile", () => {
	it("sends a nested file to the current chat and preserves its contents", async () => {
		const workspace = await createWorkspace();
		const filePath = join(workspace, "workfile", "合同", "2025-客户A合同.pdf");
		await mkdir(join(workspace, "workfile", "合同"));
		await writeFile(filePath, "contract");
		const sender = new FakeFileSender();

		const result = await execute(workspace, sender, "合同/2025-客户A合同.pdf");

		expect(result.details).toEqual({
			fileName: "2025-客户A合同.pdf",
			path: "合同/2025-客户A合同.pdf",
			delivered: true,
			preserved: true,
		});
		expect(sender.calls).toEqual([
			{ chatId: "chat-1", filePath: await realpath(filePath), fileName: "2025-客户A合同.pdf" },
		]);
		await expect(readFile(filePath, "utf8")).resolves.toBe("contract");
	});

	it("rejects absolute paths, traversal, and escaped real paths", async () => {
		const workspace = await createWorkspace();
		const outside = join(workspace, "outside.txt");
		await writeFile(outside, "secret");
		const sender = new FakeFileSender();

		await expect(execute(workspace, sender, outside)).rejects.toThrow("只接受 workfile 内的相对路径");
		await expect(execute(workspace, sender, "../outside.txt")).rejects.toThrow("文件不在 workfile 文件库内");

		const tool = createSendWorkfileTool({
			workspace,
			chatId: "chat-1",
			fileSender: sender,
			fileSystem: {
				realpath: async (path) => (path.endsWith("workfile") ? join(workspace, "workfile") : outside),
				stat,
			},
		});
		await expect(
			tool.execute("call", { path: "link.txt" }, undefined, undefined, undefined as never),
		).rejects.toThrow("文件不在 workfile 文件库内");
		expect(sender.calls).toEqual([]);
	});

	it("rejects missing, directory, empty, and oversized targets", async () => {
		const workspace = await createWorkspace();
		const sender = new FakeFileSender();
		await writeFile(join(workspace, "workfile", "empty.txt"), "");

		await expect(execute(workspace, sender, "missing.txt")).rejects.toThrow("文件不存在");
		await expect(execute(workspace, sender, ".")).rejects.toThrow("只接受 workfile 内的文件相对路径");
		await expect(execute(workspace, sender, "empty.txt")).rejects.toThrow("文件为空");

		const largePath = join(workspace, "workfile", "large.bin");
		const tool = createSendWorkfileTool({
			workspace,
			chatId: "chat-1",
			fileSender: sender,
			fileSystem: {
				realpath: async (path) => (path.endsWith("workfile") ? join(workspace, "workfile") : largePath),
				stat: async () => ({ isFile: () => true, size: 30 * 1024 * 1024 + 1 }),
			},
		});
		await expect(
			tool.execute("call", { path: "large.bin" }, undefined, undefined, undefined as never),
		).rejects.toThrow("文件超过 30 MB");
		expect(sender.calls).toEqual([]);
	});

	it("preserves the file and distinguishes upload from message failures", async () => {
		for (const stage of ["upload", "message"] as const) {
			const workspace = await createWorkspace();
			const filePath = join(workspace, "workfile", "result.txt");
			await writeFile(filePath, "result");
			const sender = new FakeFileSender();
			sender.error = new FileDeliveryError(stage, "failed");

			await expect(execute(workspace, sender, "result.txt")).rejects.toThrow(
				stage === "upload" ? "上传失败" : "消息发送失败",
			);
			await expect(readFile(filePath, "utf8")).resolves.toBe("result");
		}
	});
});
