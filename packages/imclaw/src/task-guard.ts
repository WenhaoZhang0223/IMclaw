import { basename, dirname, resolve, win32 } from "node:path";

export const TASK_TIMEOUT_MS = 600_000;
export const MAX_TOOL_CALLS = 20;
export const MAX_BROWSER_STARTS = 2;

export const TASK_TIMEOUT_MESSAGE = "任务已达到 10 分钟运行限制，已中止并清理临时文件。";
export const TOOL_LIMIT_MESSAGE = "任务已达到 20 次工具调用限制，已中止并清理临时文件。";
export const BROWSER_LIMIT_MESSAGE = "任务已达到 2 次后台浏览器启动限制，已中止并清理临时文件。";
export const BROWSER_POLICY_MESSAGE = "浏览器启动不符合后台隔离规则，任务已中止并清理临时文件。";

const BROWSER_EXECUTABLE_PATTERN = /(?:^|[\s"'\\/])(?:msedge|chrome|chromium|google-chrome)(?:\.exe)?(?=$|[\s"'])/gi;
const HEADLESS_PATTERN = /(?:^|\s)--headless(?:=new)?(?=$|\s)/i;
const USER_DATA_DIR_PATTERN = /--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i;

export interface TaskGuardEvent {
	type: string;
	toolName?: string;
	args?: unknown;
}

interface TaskGuardOptions {
	workspace: string;
	abort: () => void;
	timeoutMs?: number;
}

interface RunTaskWithGuardOptions<T> {
	workspace: string;
	abort: () => void;
	subscribe: (listener: (event: TaskGuardEvent) => void) => () => void;
	run: () => Promise<T>;
	cleanup: () => Promise<void>;
}

export class TaskLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskLimitError";
	}
}

export class TaskGuard {
	private readonly workspace: string;
	private readonly abortTask: () => void;
	private readonly timeout: ReturnType<typeof setTimeout>;
	private toolCalls = 0;
	private browserStarts = 0;
	private stopMessage: string | undefined;

	constructor(options: TaskGuardOptions) {
		this.workspace = resolve(options.workspace);
		this.abortTask = options.abort;
		this.timeout = setTimeout(() => {
			this.stop(TASK_TIMEOUT_MESSAGE);
		}, options.timeoutMs ?? TASK_TIMEOUT_MS);
	}

	handleEvent(event: TaskGuardEvent): void {
		if (this.stopMessage || event.type !== "tool_execution_start") return;

		this.toolCalls++;
		if (this.toolCalls > MAX_TOOL_CALLS) {
			this.stop(TOOL_LIMIT_MESSAGE);
			return;
		}

		const command = event.toolName === "bash" ? getCommand(event.args) : undefined;
		if (!command) return;
		const browserStarts = [...command.matchAll(BROWSER_EXECUTABLE_PATTERN)].length;
		BROWSER_EXECUTABLE_PATTERN.lastIndex = 0;
		if (browserStarts === 0) return;

		if (!HEADLESS_PATTERN.test(command) || !this.usesIsolatedProfile(command)) {
			this.stop(BROWSER_POLICY_MESSAGE);
			return;
		}
		if (this.browserStarts + browserStarts > MAX_BROWSER_STARTS) {
			this.stop(BROWSER_LIMIT_MESSAGE);
			return;
		}
		this.browserStarts += browserStarts;
	}

	throwIfStopped(): void {
		if (this.stopMessage) throw new TaskLimitError(this.stopMessage);
	}

	dispose(): void {
		clearTimeout(this.timeout);
	}

	private stop(message: string): void {
		if (this.stopMessage) return;
		this.stopMessage = message;
		this.abortTask();
	}

	private usesIsolatedProfile(command: string): boolean {
		const match = USER_DATA_DIR_PATTERN.exec(command);
		const rawPath = match?.[1] ?? match?.[2] ?? match?.[3];
		if (!rawPath) return false;
		const profilePath = resolveShellPath(rawPath, this.workspace);
		return (
			dirname(profilePath).toLowerCase() === this.workspace.toLowerCase() &&
			basename(profilePath).toLowerCase().startsWith(".tmp-edge-profile")
		);
	}
}

export async function runTaskWithGuard<T>(options: RunTaskWithGuardOptions<T>): Promise<T> {
	const guard = new TaskGuard({ workspace: options.workspace, abort: options.abort });
	const unsubscribe = options.subscribe((event) => guard.handleEvent(event));
	try {
		const result = await options.run();
		guard.throwIfStopped();
		return result;
	} catch (error) {
		guard.throwIfStopped();
		throw error;
	} finally {
		unsubscribe();
		guard.dispose();
		await options.cleanup();
	}
}

function getCommand(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || !("command" in args)) return undefined;
	const command = args.command;
	return typeof command === "string" ? command : undefined;
}

function resolveShellPath(path: string, workspace: string): string {
	const wslMatch = /^\/mnt\/([a-z])\/(.*)$/i.exec(path);
	if (wslMatch) return win32.resolve(`${wslMatch[1]}:\\${wslMatch[2].replaceAll("/", "\\")}`);
	if (win32.isAbsolute(path)) return win32.resolve(path);
	return process.platform === "win32" ? win32.resolve(workspace, path) : resolve(workspace, path);
}
