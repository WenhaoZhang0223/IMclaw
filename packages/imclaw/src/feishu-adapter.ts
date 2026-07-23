import { createReadStream } from "node:fs";
import * as lark from "@larksuiteoapi/node-sdk";
import { FileDeliveryError, type ImAdapter, type InboundMessage } from "./types.ts";

const DEDUPE_TTL_MS = 10 * 60 * 1000;
const UNSUPPORTED_MESSAGE = "IMclaw 目前只支持文本消息。";
const UNAUTHORIZED_MESSAGE = "无权限：IMclaw 仅允许主人使用。";

type FeishuFileType = "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";

interface FeishuFileClient {
	im: {
		v1: {
			file: {
				create(payload: {
					data: { file_type: FeishuFileType; file_name: string; file: ReturnType<typeof createReadStream> };
				}): Promise<{ file_key?: string } | null>;
			};
			message: {
				create(payload: {
					params: { receive_id_type: "chat_id" };
					data: { receive_id: string; msg_type: string; content: string };
				}): Promise<unknown>;
			};
		};
	};
}

export function getFeishuFileType(fileName: string): FeishuFileType {
	const extension = fileName.toLowerCase().match(/\.([^.]+)$/)?.[1];
	if (extension === "pdf" || extension === "mp4" || extension === "opus") return extension;
	if (extension === "doc" || extension === "docx") return "doc";
	if (extension === "xls" || extension === "xlsx") return "xls";
	if (extension === "ppt" || extension === "pptx") return "ppt";
	return "stream";
}

export async function sendFeishuFile(
	client: FeishuFileClient,
	chatId: string,
	filePath: string,
	fileName: string,
): Promise<void> {
	let uploaded: { file_key?: string } | null;
	const file = createReadStream(filePath);
	const fileType = getFeishuFileType(fileName);
	try {
		uploaded = await client.im.v1.file.create({
			data: {
				file_type: fileType,
				file_name: fileName,
				file,
			},
		});
	} catch (error) {
		file.destroy();
		throw new FileDeliveryError("upload", "Feishu file upload failed", { cause: error });
	}
	file.destroy();
	if (!uploaded?.file_key) throw new FileDeliveryError("upload", "Feishu file upload returned no file_key");

	try {
		await client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				msg_type: fileType === "mp4" ? "media" : fileType === "opus" ? "audio" : "file",
				content: JSON.stringify({ file_key: uploaded.file_key }),
			},
		});
	} catch (error) {
		throw new FileDeliveryError("message", "Feishu file message send failed", { cause: error });
	}
}

export class MessageDeduplicator {
	private readonly seen = new Map<string, number>();
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(ttlMs = DEDUPE_TTL_MS, now: () => number = Date.now) {
		this.ttlMs = ttlMs;
		this.now = now;
	}

	isDuplicate(messageId: string): boolean {
		const now = this.now();
		for (const [id, expiresAt] of this.seen) {
			if (expiresAt <= now) this.seen.delete(id);
		}
		if (this.seen.has(messageId)) return true;
		this.seen.set(messageId, now + this.ttlMs);
		return false;
	}
}

interface RawFeishuEvent {
	sender?: {
		sender_id?: { open_id?: string };
		sender_type?: string;
	};
	message?: {
		message_id?: string;
		chat_id?: string;
		chat_type?: string;
		message_type?: string;
		content?: string;
	};
}

export type ParsedFeishuEvent =
	| { type: "ignore" }
	| { type: "unsupported"; chatId: string; messageId: string; senderOpenId: string }
	| { type: "message"; message: InboundMessage };

export function parseFeishuEvent(data: unknown): ParsedFeishuEvent {
	if (!data || typeof data !== "object") return { type: "ignore" };
	const event = data as RawFeishuEvent;
	const message = event.message;
	const senderOpenId = event.sender?.sender_id?.open_id;
	if (
		!message?.message_id ||
		!message.chat_id ||
		message.chat_type !== "p2p" ||
		event.sender?.sender_type === "app" ||
		!senderOpenId
	) {
		return { type: "ignore" };
	}
	if (message.message_type !== "text" || typeof message.content !== "string") {
		return { type: "unsupported", chatId: message.chat_id, messageId: message.message_id, senderOpenId };
	}
	try {
		const content: unknown = JSON.parse(message.content);
		if (!content || typeof content !== "object" || !("text" in content) || typeof content.text !== "string") {
			return { type: "unsupported", chatId: message.chat_id, messageId: message.message_id, senderOpenId };
		}
		return {
			type: "message",
			message: {
				messageId: message.message_id,
				chatId: message.chat_id,
				senderOpenId,
				text: content.text,
			},
		};
	} catch {
		return { type: "unsupported", chatId: message.chat_id, messageId: message.message_id, senderOpenId };
	}
}

export class FeishuAdapter implements ImAdapter {
	private readonly client: lark.Client;
	private readonly wsClient: lark.WSClient;
	private readonly deduplicator = new MessageDeduplicator();
	private readonly ownerOpenId: string;

	constructor(appId: string, appSecret: string, ownerOpenId: string) {
		const options = { appId, appSecret, domain: lark.Domain.Feishu };
		this.client = new lark.Client(options);
		this.wsClient = new lark.WSClient(options);
		this.ownerOpenId = ownerOpenId;
	}

	async start(handler: (message: InboundMessage) => void): Promise<void> {
		const eventDispatcher = new lark.EventDispatcher({}).register({
			"im.message.receive_v1": (data) => {
				const parsed = parseFeishuEvent(data);
				if (
					parsed.type === "ignore" ||
					this.deduplicator.isDuplicate(parsed.type === "message" ? parsed.message.messageId : parsed.messageId)
				) {
					return;
				}
				const senderOpenId = parsed.type === "message" ? parsed.message.senderOpenId : parsed.senderOpenId;
				if (senderOpenId !== this.ownerOpenId) {
					const chatId = parsed.type === "message" ? parsed.message.chatId : parsed.chatId;
					console.warn(`Rejected Feishu sender: ${senderOpenId}`);
					void this.sendText(chatId, UNAUTHORIZED_MESSAGE).catch((error: unknown) => {
						console.error("Failed to send unauthorized reply", error);
					});
					return;
				}
				if (parsed.type === "unsupported") {
					void this.sendText(parsed.chatId, UNSUPPORTED_MESSAGE).catch((error: unknown) => {
						console.error("Failed to send unsupported-message reply", error);
					});
					return;
				}
				handler(parsed.message);
			},
		});
		await this.wsClient.start({ eventDispatcher });
	}

	async sendText(chatId: string, text: string): Promise<void> {
		await this.client.im.v1.message.create({
			params: { receive_id_type: "chat_id" },
			data: {
				receive_id: chatId,
				msg_type: "text",
				content: JSON.stringify({ text }),
			},
		});
	}

	async sendFile(chatId: string, filePath: string, fileName: string): Promise<void> {
		await sendFeishuFile(this.client, chatId, filePath, fileName);
	}

	async stop(): Promise<void> {
		this.wsClient.close();
	}
}
