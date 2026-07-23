import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ImclawConfig } from "./config.ts";
import { createDeliverFileTool } from "./deliver-file.ts";
import { createFindWorkfileTool } from "./find-workfile.ts";
import { createSendWorkfileTool } from "./send-workfile.ts";
import { runTaskWithGuard } from "./task-guard.ts";
import { cleanupTemporaryArtifacts } from "./temporary-artifacts.ts";
import type { AgentBackend, FileSender } from "./types.ts";

export const IMCLAW_IDENTITY_PROMPT = `You are IMclaw, a private coding agent controlled through Feishu.
Work only inside the configured workspace. Be concise in chat, explain material file changes, and never expose credentials.
Use the current request's primary language for every user-facing reply and generated deliverable, including file names, titles, headings, table labels, explanatory text, and file contents. For mixed-language requests, use the predominant natural language while preserving technical terms, product names, and code identifiers when appropriate. Do not produce bilingual output unless the user explicitly requests it. An explicit language instruction from the user takes priority over inferred language and conversation history.
When the user asks to download or receive a file, create the final file in the workspace and call deliver_file after it is complete. Do not deliver internal intermediate files. A successful deliver_file call means the file was already sent to the user; do not tell them to find it at a local path.
The workspace workfile directory is the user's read-only long-term file library. When the user asks for an existing file, call find_workfile first using concise identifying keywords. If there is one clear strong match, call send_workfile with the returned relative path. If there are multiple plausible candidates or confidence is low, list numbered relative-path candidates and wait for confirmation; never guess or default to the first result. Never expose absolute local paths. Never modify, move, rename, or delete anything in workfile. Do not use shell tools to bypass these boundaries. A successful send_workfile call means the existing file was sent and preserved.
Each task is limited to 10 minutes, 20 tool calls, and at most two browser launches. Browser automation must be headless and use a new workspace-root .tmp-edge-profile directory. Never use the user's normal browser profile, cookies, tabs, or login state, and never connect to an existing browser debugging endpoint.`;

export class PiAgentBackend implements AgentBackend {
	private readonly runtimes = new Map<string, AgentSessionRuntime>();
	private readonly config: ImclawConfig;
	private readonly fileSender: FileSender;

	constructor(config: ImclawConfig, fileSender: FileSender) {
		this.config = config;
		this.fileSender = fileSender;
	}

	async prompt(chatId: string, text: string): Promise<string> {
		const runtime = await this.getRuntime(chatId);
		return runTaskWithGuard({
			workspace: this.config.workspace,
			abort: () => {
				void runtime.session.abort();
			},
			subscribe: (listener) => runtime.session.subscribe((event) => listener(event)),
			run: async () => {
				await runtime.session.prompt(text);
				return runtime.session.getLastAssistantText() ?? "任务已完成，但模型没有返回文本。";
			},
			cleanup: async () => {
				await cleanupTemporaryArtifacts(this.config.workspace);
			},
		});
	}

	async newSession(chatId: string): Promise<void> {
		const runtime = await this.getRuntime(chatId);
		await runtime.newSession();
	}

	async abort(chatId: string): Promise<void> {
		const runtime = this.runtimes.get(chatId);
		if (runtime) await runtime.session.abort();
		await cleanupTemporaryArtifacts(this.config.workspace);
	}

	async status(chatId: string): Promise<string> {
		const runtime = this.runtimes.get(chatId);
		if (!runtime) return "状态：尚未创建会话";
		const model = runtime.session.model;
		return [
			`状态：${runtime.session.isStreaming ? "处理中" : "空闲"}`,
			`模型：${model ? `${model.provider}/${model.id}` : "未配置"}`,
			`会话：${runtime.session.sessionId}`,
			`工作目录：${runtime.cwd}`,
		].join("\n");
	}

	async dispose(): Promise<void> {
		await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
		this.runtimes.clear();
		await cleanupTemporaryArtifacts(this.config.workspace);
	}

	private async getRuntime(chatId: string): Promise<AgentSessionRuntime> {
		const existing = this.runtimes.get(chatId);
		if (existing) return existing;

		const sessionDir = join(
			this.config.agentDir,
			"imclaw-sessions",
			createHash("sha256").update(chatId).digest("hex"),
		);
		mkdirSync(sessionDir, { recursive: true });
		const sessionManager = SessionManager.continueRecent(this.config.workspace, sessionDir);
		const deliverFileTool = createDeliverFileTool({
			workspace: this.config.workspace,
			chatId,
			fileSender: this.fileSender,
		});
		const findWorkfileTool = createFindWorkfileTool({ workspace: this.config.workspace });
		const sendWorkfileTool = createSendWorkfileTool({
			workspace: this.config.workspace,
			chatId,
			fileSender: this.fileSender,
		});
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			const services = await createAgentSessionServices({
				cwd: options.cwd,
				agentDir: options.agentDir,
				resourceLoaderOptions: { appendSystemPrompt: [IMCLAW_IDENTITY_PROMPT] },
			});
			const model =
				this.config.provider && this.config.model
					? services.modelRuntime.getModel(this.config.provider, this.config.model)
					: undefined;
			if (this.config.provider && this.config.model && !model) {
				throw new Error(`Configured model not found: ${this.config.provider}/${this.config.model}`);
			}
			const errors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error");
			if (errors.length > 0) throw new Error(errors.map((error) => error.message).join("\n"));
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model,
				tools: ["read", "bash", "edit", "write", "deliver_file", "find_workfile", "send_workfile"],
				customTools: [deliverFileTool, findWorkfileTool, sendWorkfileTool],
			});
			if (!created.session.model) {
				created.session.dispose();
				throw new Error("No usable model or authentication found. Configure pi login/auth before starting IMclaw.");
			}
			return { ...created, services, diagnostics: services.diagnostics };
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: this.config.workspace,
			agentDir: this.config.agentDir,
			sessionManager,
		});
		this.runtimes.set(chatId, runtime);
		return runtime;
	}
}
