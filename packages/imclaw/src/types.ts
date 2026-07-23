export interface InboundMessage {
	messageId: string;
	chatId: string;
	senderOpenId: string;
	text: string;
}

export interface FileSender {
	sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
}

export class FileDeliveryError extends Error {
	readonly stage: "upload" | "message";

	constructor(stage: "upload" | "message", message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "FileDeliveryError";
		this.stage = stage;
	}
}

export interface ImAdapter extends FileSender {
	start(handler: (message: InboundMessage) => void): Promise<void>;
	sendText(chatId: string, text: string): Promise<void>;
	stop(): Promise<void>;
}

export interface AgentBackend {
	prompt(chatId: string, text: string): Promise<string>;
	newSession(chatId: string): Promise<void>;
	abort(chatId: string): Promise<void>;
	status(chatId: string): Promise<string>;
	dispose(): Promise<void>;
}
