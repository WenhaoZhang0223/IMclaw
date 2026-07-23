import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeliverFileTool } from "../src/deliver-file.ts";
import { FileDeliveryError, type FileSender } from "../src/types.ts";

class FakeFileSender implements FileSender {
	readonly calls: Array<{ chatId: string; filePath: string; fileName: string }> = [];
	error: Error | undefined;

	async sendFile(chatId: string, filePath: string, fileName: string): Promise<void> {
		this.calls.push({ chatId, filePath, fileName });
		if (this.error) throw this.error;
	}
}

async function createWorkspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "imclaw-deliver-"));
}

async function execute(workspace: string, sender: FileSender, path: string) {
	return createDeliverFileTool({ workspace, chatId: "chat-1", fileSender: sender }).execute(
		"call-1",
		{ path },
		undefined,
		undefined,
		undefined as never,
	);
}

describe("deliver_file", () => {
	it("sends relative and absolute workspace files, then deletes only the delivered file", async () => {
		for (const useAbsolutePath of [false, true]) {
			const workspace = await createWorkspace();
			const deliveredPath = join(workspace, "result.txt");
			const otherPath = join(workspace, "other.txt");
			await writeFile(deliveredPath, "result");
			await writeFile(otherPath, "keep");
			const sender = new FakeFileSender();
			const deliveredRealPath = await realpath(deliveredPath);

			const result = await execute(workspace, sender, useAbsolutePath ? deliveredPath : "result.txt");

			expect(result.details).toEqual({ fileName: "result.txt", delivered: true, cleanedUp: true });
			expect(sender.calls).toEqual([{ chatId: "chat-1", filePath: deliveredRealPath, fileName: "result.txt" }]);
			await expect(stat(deliveredPath)).rejects.toThrow();
			await expect(readFile(otherPath, "utf8")).resolves.toBe("keep");
		}
	});

	it("rejects paths outside the workspace, including traversal and symlink resolution", async () => {
		const workspace = await createWorkspace();
		const outside = join(workspace, "..", "outside.txt");
		await writeFile(outside, "secret");
		const sender = new FakeFileSender();

		await expect(execute(workspace, sender, outside)).rejects.toThrow("文件不在工作目录内");
		await expect(execute(workspace, sender, "../outside.txt")).rejects.toThrow("文件不在工作目录内");

		const workspaceRealPath = await realpath(workspace);
		const tool = createDeliverFileTool({
			workspace,
			chatId: "chat-1",
			fileSender: sender,
			fileSystem: {
				realpath: vi.fn(async (path: string) => (path === workspace ? workspaceRealPath : outside)),
				stat,
				unlink: vi.fn(),
			},
		});
		await expect(
			tool.execute("call", { path: "link.txt" }, undefined, undefined, undefined as never),
		).rejects.toThrow("文件不在工作目录内");
		expect(sender.calls).toEqual([]);
	});

	it("rejects missing files, directories, empty files, and files over 30 MB", async () => {
		const workspace = await createWorkspace();
		const sender = new FakeFileSender();
		await writeFile(join(workspace, "empty.txt"), "");

		await expect(execute(workspace, sender, "missing.txt")).rejects.toThrow("文件不存在");
		await expect(execute(workspace, sender, ".")).rejects.toThrow("目标不是普通文件");
		await expect(execute(workspace, sender, "empty.txt")).rejects.toThrow("文件为空");

		const largePath = join(workspace, "large.bin");
		const tool = createDeliverFileTool({
			workspace,
			chatId: "chat-1",
			fileSender: sender,
			fileSystem: {
				realpath: async (path) => (path === workspace ? workspace : largePath),
				stat: async () => ({ isFile: () => true, size: 30 * 1024 * 1024 + 1 }),
				unlink: vi.fn(),
			},
		});
		await expect(
			tool.execute("call", { path: "large.bin" }, undefined, undefined, undefined as never),
		).rejects.toThrow("文件超过 30 MB");
		expect(sender.calls).toEqual([]);
	});

	it("preserves the file when upload or message sending fails", async () => {
		for (const stage of ["upload", "message"] as const) {
			const workspace = await createWorkspace();
			const filePath = join(workspace, "result.txt");
			await writeFile(filePath, "result");
			const sender = new FakeFileSender();
			sender.error = new FileDeliveryError(stage, "failed");

			await expect(execute(workspace, sender, filePath)).rejects.toThrow(
				stage === "upload" ? "上传失败" : "消息发送失败",
			);
			await expect(readFile(filePath, "utf8")).resolves.toBe("result");
		}
	});

	it("reports partial success when local cleanup fails", async () => {
		const workspace = await createWorkspace();
		const filePath = join(workspace, "result.txt");
		await writeFile(filePath, "result");
		const sender = new FakeFileSender();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const tool = createDeliverFileTool({
			workspace,
			chatId: "chat-1",
			fileSender: sender,
			fileSystem: { realpath, stat, unlink: async () => Promise.reject(new Error("locked")) },
		});

		const result = await tool.execute("call", { path: filePath }, undefined, undefined, undefined as never);

		expect(result.details).toEqual({ fileName: "result.txt", delivered: true, cleanedUp: false });
		await expect(readFile(filePath, "utf8")).resolves.toBe("result");
		errorSpy.mockRestore();
	});
});
