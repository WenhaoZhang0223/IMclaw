import { describe, expect, it, vi } from "vitest";
import { ImclawController } from "../src/controller.ts";
import { TaskLimitError, TOOL_LIMIT_MESSAGE } from "../src/task-guard.ts";
import type { AgentBackend, ImAdapter, InboundMessage } from "../src/types.ts";

class FakeAdapter implements ImAdapter {
	readonly sent: Array<{ chatId: string; text: string }> = [];

	async start(_handler: (message: InboundMessage) => void): Promise<void> {}

	async sendText(chatId: string, text: string): Promise<void> {
		this.sent.push({ chatId, text });
	}

	async sendFile(_chatId: string, _filePath: string, _fileName: string): Promise<void> {}

	async stop(): Promise<void> {}
}

class FakeBackend implements AgentBackend {
	readonly calls: string[] = [];
	promptImplementation: (chatId: string, text: string) => Promise<string> = async (_chatId, text) => `reply:${text}`;

	async prompt(chatId: string, text: string): Promise<string> {
		this.calls.push(`${chatId}:${text}`);
		return this.promptImplementation(chatId, text);
	}

	async newSession(chatId: string): Promise<void> {
		this.calls.push(`${chatId}:/new`);
	}

	async abort(chatId: string): Promise<void> {
		this.calls.push(`${chatId}:/abort`);
	}

	async status(chatId: string): Promise<string> {
		return `status:${chatId}`;
	}

	async dispose(): Promise<void> {}
}

function inbound(text: string, chatId = "chat-1", senderOpenId = "owner"): InboundMessage {
	return { messageId: `${chatId}:${text}`, chatId, senderOpenId, text };
}

describe("ImclawController", () => {
	it("blocks non-owner messages before the backend", async () => {
		const adapter = new FakeAdapter();
		const backend = new FakeBackend();
		const controller = new ImclawController(adapter, backend, "owner");

		await controller.handle(inbound("hello", "chat-1", "stranger"));

		expect(backend.calls).toEqual([]);
		expect(adapter.sent[0]?.text).toContain("无权限");
	});

	it("runs prompts FIFO per chat and keeps chats isolated", async () => {
		const adapter = new FakeAdapter();
		const backend = new FakeBackend();
		let releaseFirst: (() => void) | undefined;
		const firstFinished = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		backend.promptImplementation = async (_chatId, text) => {
			if (text === "first") await firstFinished;
			return `reply:${text}`;
		};
		const controller = new ImclawController(adapter, backend, "owner");

		await controller.handle(inbound("first"));
		await controller.handle(inbound("second"));
		await controller.handle(inbound("other", "chat-2"));
		await vi.waitFor(() => expect(backend.calls).toContain("chat-2:other"));
		expect(backend.calls).not.toContain("chat-1:second");
		releaseFirst?.();
		await vi.waitFor(() => expect(backend.calls).toEqual(["chat-1:first", "chat-2:other", "chat-1:second"]));
	});

	it("aborts immediately and clears queued prompts", async () => {
		const adapter = new FakeAdapter();
		const backend = new FakeBackend();
		let release: (() => void) | undefined;
		const running = new Promise<void>((resolve) => {
			release = resolve;
		});
		backend.promptImplementation = async (_chatId, text) => {
			if (text === "running") await running;
			return text;
		};
		const controller = new ImclawController(adapter, backend, "owner");

		await controller.handle(inbound("running"));
		await controller.handle(inbound("queued"));
		await controller.handle(inbound("/abort"));
		expect(backend.calls).toContain("chat-1:/abort");
		release?.();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(backend.calls).not.toContain("chat-1:queued");
	});

	it("chunks long replies", async () => {
		const adapter = new FakeAdapter();
		const backend = new FakeBackend();
		backend.promptImplementation = async () => "x".repeat(7_001);
		const controller = new ImclawController(adapter, backend, "owner");

		await controller.handle(inbound("long"));
		await vi.waitFor(() => expect(adapter.sent).toHaveLength(4));
		expect(adapter.sent.slice(1).map((message) => message.text.length)).toEqual([3_500, 3_500, 1]);
	});

	it("sends task-limit explanations without a generic error ID", async () => {
		const adapter = new FakeAdapter();
		const backend = new FakeBackend();
		backend.promptImplementation = async () => Promise.reject(new TaskLimitError(TOOL_LIMIT_MESSAGE));
		const controller = new ImclawController(adapter, backend, "owner");

		await controller.handle(inbound("long task"));
		await vi.waitFor(() => expect(adapter.sent.some((message) => message.text === TOOL_LIMIT_MESSAGE)).toBe(true));
		expect(adapter.sent.some((message) => message.text.includes("错误编号"))).toBe(false);
	});
});
