import type { ReadStream } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getFeishuFileType, MessageDeduplicator, parseFeishuEvent, sendFeishuFile } from "../src/feishu-adapter.ts";

function event(overrides: Record<string, unknown> = {}): unknown {
	return {
		sender: { sender_id: { open_id: "ou_owner" }, sender_type: "user" },
		message: {
			message_id: "m1",
			chat_id: "c1",
			chat_type: "p2p",
			message_type: "text",
			content: JSON.stringify({ text: "hello" }),
			...overrides,
		},
	};
}

describe("parseFeishuEvent", () => {
	it("parses private text messages", () => {
		expect(parseFeishuEvent(event())).toEqual({
			type: "message",
			message: { messageId: "m1", chatId: "c1", senderOpenId: "ou_owner", text: "hello" },
		});
	});

	it("ignores groups and app messages", () => {
		expect(parseFeishuEvent(event({ chat_type: "group" }))).toEqual({ type: "ignore" });
		expect(
			parseFeishuEvent({
				sender: { sender_id: { open_id: "bot" }, sender_type: "app" },
				message: { ...eventMessage(), message_id: "m2" },
			}),
		).toEqual({ type: "ignore" });
	});

	it("classifies non-text messages", () => {
		expect(parseFeishuEvent(event({ message_type: "image", content: "{}" }))).toEqual({
			type: "unsupported",
			chatId: "c1",
			messageId: "m1",
			senderOpenId: "ou_owner",
		});
	});
});

describe("MessageDeduplicator", () => {
	it("drops duplicate IDs until the TTL expires", () => {
		let now = 100;
		const deduplicator = new MessageDeduplicator(10, () => now);
		expect(deduplicator.isDuplicate("m1")).toBe(false);
		expect(deduplicator.isDuplicate("m1")).toBe(true);
		now = 111;
		expect(deduplicator.isDuplicate("m1")).toBe(false);
	});
});

async function temporaryFile(fileName: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "imclaw-feishu-"));
	const filePath = join(directory, fileName);
	await writeFile(filePath, "content");
	return filePath;
}

describe("sendFeishuFile", () => {
	it("maps known document extensions and defaults other files to stream", () => {
		expect(getFeishuFileType("report.PDF")).toBe("pdf");
		expect(getFeishuFileType("report.docx")).toBe("doc");
		expect(getFeishuFileType("report.xlsx")).toBe("xls");
		expect(getFeishuFileType("slides.pptx")).toBe("ppt");
		expect(getFeishuFileType("video.mp4")).toBe("mp4");
		expect(getFeishuFileType("archive.zip")).toBe("stream");
	});

	it("uploads a stream and sends the returned file key as a file message", async () => {
		let uploadData:
			| { file_type: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream"; file_name: string; file: ReadStream }
			| undefined;
		const upload = vi.fn(async (payload: { data: NonNullable<typeof uploadData> }) => {
			uploadData = payload.data;
			return { file_key: "file-key" };
		});
		const send = vi.fn(async () => ({}));
		const client = { im: { v1: { file: { create: upload }, message: { create: send } } } };
		const filePath = await temporaryFile("report.pdf");

		await sendFeishuFile(client, "chat-1", filePath, "report.pdf");

		expect(upload).toHaveBeenCalledOnce();
		expect(uploadData?.file_type).toBe("pdf");
		expect(uploadData?.file_name).toBe("report.pdf");
		expect(uploadData?.file.path).toBe(filePath);
		expect(send).toHaveBeenCalledWith({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: "chat-1", msg_type: "file", content: JSON.stringify({ file_key: "file-key" }) },
		});
	});

	it("sends uploaded video and audio files with matching message types", async () => {
		for (const [extension, messageType] of [
			["mp4", "media"],
			["opus", "audio"],
		] as const) {
			const upload = vi.fn(async () => ({ file_key: `${extension}-key` }));
			const send = vi.fn(async () => ({}));
			const client = { im: { v1: { file: { create: upload }, message: { create: send } } } };
			const filePath = await temporaryFile(`recording.${extension}`);

			await sendFeishuFile(client, "chat-1", filePath, `recording.${extension}`);

			expect(send).toHaveBeenCalledWith({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: "chat-1",
					msg_type: messageType,
					content: JSON.stringify({ file_key: `${extension}-key` }),
				},
			});
		}
	});

	it("does not send when upload returns no file key", async () => {
		const send = vi.fn(async () => ({}));
		const client = {
			im: { v1: { file: { create: vi.fn(async () => ({})) }, message: { create: send } } },
		};
		const filePath = await temporaryFile("result.bin");

		await expect(sendFeishuFile(client, "chat-1", filePath, "result.bin")).rejects.toMatchObject({
			stage: "upload",
		});
		expect(send).not.toHaveBeenCalled();
	});

	it("classifies upload and message API failures", async () => {
		const filePath = await temporaryFile("result.bin");
		const uploadFailure = {
			im: {
				v1: {
					file: { create: vi.fn(async () => Promise.reject(new Error("upload"))) },
					message: { create: vi.fn(async () => ({})) },
				},
			},
		};
		await expect(sendFeishuFile(uploadFailure, "chat-1", filePath, "result.bin")).rejects.toMatchObject({
			stage: "upload",
		});

		const messageFailure = {
			im: {
				v1: {
					file: { create: vi.fn(async () => ({ file_key: "key" })) },
					message: { create: vi.fn(async () => Promise.reject(new Error("send"))) },
				},
			},
		};
		await expect(sendFeishuFile(messageFailure, "chat-1", filePath, "result.bin")).rejects.toMatchObject({
			stage: "message",
		});
	});
});

function eventMessage(): Record<string, unknown> {
	return {
		message_id: "m1",
		chat_id: "c1",
		chat_type: "p2p",
		message_type: "text",
		content: JSON.stringify({ text: "hello" }),
	};
}
