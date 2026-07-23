import { randomUUID } from "node:crypto";
import { TaskLimitError } from "./task-guard.ts";
import type { AgentBackend, ImAdapter, InboundMessage } from "./types.ts";

const MAX_INPUT_LENGTH = 8_000;
const MAX_REPLY_LENGTH = 3_500;
const UNAUTHORIZED_MESSAGE = "无权限：IMclaw 仅允许主人使用。";
const HELP_MESSAGE = [
	"IMclaw 命令：",
	"/help 查看帮助",
	"/new 创建新会话",
	"/status 查看状态",
	"/abort 中止当前任务并清空队列",
].join("\n");

type WorkItem = { type: "prompt"; text: string } | { type: "new" };

interface ChatQueue {
	items: WorkItem[];
	running: boolean;
	abortEpoch: number;
}

export class ImclawController {
	private readonly adapter: ImAdapter;
	private readonly backend: AgentBackend;
	private readonly ownerOpenId: string;
	private readonly queues = new Map<string, ChatQueue>();

	constructor(adapter: ImAdapter, backend: AgentBackend, ownerOpenId: string) {
		this.adapter = adapter;
		this.backend = backend;
		this.ownerOpenId = ownerOpenId;
	}

	async handle(message: InboundMessage): Promise<void> {
		if (message.senderOpenId !== this.ownerOpenId) {
			await this.adapter.sendText(message.chatId, UNAUTHORIZED_MESSAGE);
			return;
		}
		const text = message.text.trim();
		if (!text) {
			await this.adapter.sendText(message.chatId, "请输入文本内容。");
			return;
		}
		if (text.length > MAX_INPUT_LENGTH) {
			await this.adapter.sendText(message.chatId, `消息过长，最多允许 ${MAX_INPUT_LENGTH} 个字符。`);
			return;
		}
		if (text === "/help") {
			await this.adapter.sendText(message.chatId, HELP_MESSAGE);
			return;
		}
		if (text === "/status") {
			await this.sendChunked(message.chatId, await this.backend.status(message.chatId));
			return;
		}
		if (text === "/abort") {
			const queue = this.queues.get(message.chatId);
			if (queue) {
				queue.items.length = 0;
				queue.abortEpoch++;
			}
			await this.backend.abort(message.chatId);
			await this.adapter.sendText(message.chatId, "已中止当前任务并清空等待队列。");
			return;
		}

		const item: WorkItem = text === "/new" ? { type: "new" } : { type: "prompt", text };
		if (item.type === "prompt") await this.adapter.sendText(message.chatId, "已收到，正在处理。");
		this.enqueue(message.chatId, item);
	}

	async dispose(): Promise<void> {
		for (const queue of this.queues.values()) queue.items.length = 0;
		await this.backend.dispose();
	}

	private enqueue(chatId: string, item: WorkItem): void {
		const queue = this.queues.get(chatId) ?? { items: [], running: false, abortEpoch: 0 };
		queue.items.push(item);
		this.queues.set(chatId, queue);
		if (!queue.running) void this.runQueue(chatId, queue);
	}

	private async runQueue(chatId: string, queue: ChatQueue): Promise<void> {
		queue.running = true;
		while (queue.items.length > 0) {
			const item = queue.items.shift();
			if (!item) break;
			const itemEpoch = queue.abortEpoch;
			try {
				if (item.type === "new") {
					await this.backend.newSession(chatId);
					if (itemEpoch === queue.abortEpoch) await this.adapter.sendText(chatId, "已创建新会话。");
				} else {
					const reply = await this.backend.prompt(chatId, item.text);
					if (itemEpoch === queue.abortEpoch) await this.sendChunked(chatId, reply);
				}
			} catch (error) {
				if (itemEpoch !== queue.abortEpoch) continue;
				if (error instanceof TaskLimitError) {
					await this.adapter.sendText(chatId, error.message);
					continue;
				}
				const errorId = randomUUID().slice(0, 8);
				console.error(`[${errorId}] IMclaw task failed`, error);
				await this.adapter.sendText(chatId, `处理失败，请查看 PM2 日志。错误编号：${errorId}`);
			}
		}
		queue.running = false;
	}

	private async sendChunked(chatId: string, text: string): Promise<void> {
		for (let offset = 0; offset < text.length; offset += MAX_REPLY_LENGTH) {
			await this.adapter.sendText(chatId, text.slice(offset, offset + MAX_REPLY_LENGTH));
		}
	}
}
