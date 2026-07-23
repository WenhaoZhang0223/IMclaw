import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BROWSER_LIMIT_MESSAGE,
	BROWSER_POLICY_MESSAGE,
	runTaskWithGuard,
	TASK_TIMEOUT_MESSAGE,
	TaskGuard,
	type TaskGuardEvent,
	TaskLimitError,
	TOOL_LIMIT_MESSAGE,
} from "../src/task-guard.ts";

const workspace = "C:\\workspace\\IMclaw";

function browserCommand(profile: string, headless = true): string {
	return `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ${
		headless ? "--headless=new " : ""
	}--user-data-dir="${profile}" about:blank`;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("TaskGuard", () => {
	it("aborts at ten minutes and preserves the timeout reason", () => {
		vi.useFakeTimers();
		const abort = vi.fn();
		const guard = new TaskGuard({ workspace, abort });

		vi.advanceTimersByTime(599_999);
		expect(abort).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);

		expect(abort).toHaveBeenCalledOnce();
		expect(() => guard.throwIfStopped()).toThrow(TASK_TIMEOUT_MESSAGE);
		guard.dispose();
	});

	it("allows twenty tool calls and aborts before the twenty-first", () => {
		const abort = vi.fn();
		const guard = new TaskGuard({ workspace, abort });

		for (let index = 0; index < 20; index++) {
			guard.handleEvent({ type: "tool_execution_start", toolName: "read", args: {} });
		}
		expect(abort).not.toHaveBeenCalled();

		guard.handleEvent({ type: "tool_execution_start", toolName: "write", args: {} });
		expect(abort).toHaveBeenCalledOnce();
		expect(() => guard.throwIfStopped()).toThrow(TOOL_LIMIT_MESSAGE);
		guard.dispose();
	});

	it("allows two isolated headless launches and aborts before the third", () => {
		const abort = vi.fn();
		const guard = new TaskGuard({ workspace, abort });
		const event = (number: number): TaskGuardEvent => ({
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: browserCommand(join(workspace, `.tmp-edge-profile${number}`)) },
		});

		guard.handleEvent(event(1));
		guard.handleEvent(event(2));
		expect(abort).not.toHaveBeenCalled();

		guard.handleEvent(event(3));
		expect(abort).toHaveBeenCalledOnce();
		expect(() => guard.throwIfStopped()).toThrow(BROWSER_LIMIT_MESSAGE);
		guard.dispose();
	});

	it("rejects visible browsers and profiles outside the workspace", () => {
		for (const command of [
			browserCommand(join(workspace, ".tmp-edge-profile1"), false),
			browserCommand("C:\\outside\\profile"),
		]) {
			const abort = vi.fn();
			const guard = new TaskGuard({ workspace, abort });
			guard.handleEvent({ type: "tool_execution_start", toolName: "bash", args: { command } });
			expect(abort).toHaveBeenCalledOnce();
			expect(() => guard.throwIfStopped()).toThrow(BROWSER_POLICY_MESSAGE);
			guard.dispose();
		}
	});

	it("does not treat ordinary bash commands as browser launches", () => {
		const abort = vi.fn();
		const guard = new TaskGuard({ workspace, abort });

		guard.handleEvent({
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: "node scripts/build-report.js" },
		});

		expect(abort).not.toHaveBeenCalled();
		guard.throwIfStopped();
		guard.dispose();
	});
});

describe("runTaskWithGuard", () => {
	it("unsubscribes, clears the timer, and cleans after success", async () => {
		vi.useFakeTimers();
		const unsubscribe = vi.fn();
		const cleanup = vi.fn(async () => {});

		const result = await runTaskWithGuard({
			workspace,
			abort: vi.fn(),
			subscribe: () => unsubscribe,
			run: async () => "done",
			cleanup,
		});

		expect(result).toBe("done");
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cleans without replacing the original task error", async () => {
		const cleanup = vi.fn(async () => {});
		const originalError = new Error("model failed");

		await expect(
			runTaskWithGuard({
				workspace,
				abort: vi.fn(),
				subscribe: () => vi.fn(),
				run: async () => Promise.reject(originalError),
				cleanup,
			}),
		).rejects.toBe(originalError);
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("throws a stable TaskLimitError after a guard abort", async () => {
		let listener: ((event: TaskGuardEvent) => void) | undefined;
		const cleanup = vi.fn(async () => {});

		await expect(
			runTaskWithGuard({
				workspace,
				abort: vi.fn(),
				subscribe: (nextListener) => {
					listener = nextListener;
					return vi.fn();
				},
				run: async () => {
					for (let index = 0; index < 21; index++) {
						listener?.({ type: "tool_execution_start", toolName: "read", args: {} });
					}
				},
				cleanup,
			}),
		).rejects.toEqual(new TaskLimitError(TOOL_LIMIT_MESSAGE));
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it("preserves the guard reason when the aborted task rejects", async () => {
		let listener: ((event: TaskGuardEvent) => void) | undefined;

		await expect(
			runTaskWithGuard({
				workspace,
				abort: vi.fn(),
				subscribe: (nextListener) => {
					listener = nextListener;
					return vi.fn();
				},
				run: async () => {
					for (let index = 0; index < 21; index++) {
						listener?.({ type: "tool_execution_start", toolName: "read", args: {} });
					}
					throw new Error("aborted");
				},
				cleanup: async () => {},
			}),
		).rejects.toEqual(new TaskLimitError(TOOL_LIMIT_MESSAGE));
	});
});
