import { execFile } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const RESERVED_TEMPORARY_NAME_PATTERNS = [
	/^\.tmp-edge-profile/i,
	/^\.tmp-cdp-/i,
	/^\.tmp-edge.*\.(?:out|err)$/i,
	/^\.tmp-reply-urls\.json$/i,
	/^\.tmp-video-body\.txt$/i,
];

interface CleanupDependencies {
	stopTemporaryBrowsers?: (workspace: string) => Promise<void>;
	remove?: (path: string) => Promise<void>;
	listNames?: (workspace: string) => Promise<string[]>;
	logError?: (message: string, error: unknown) => void;
}

export interface CleanupReport {
	removed: string[];
	errors: Array<{ path: string; message: string }>;
}

export async function cleanupTemporaryArtifacts(
	workspace: string,
	dependencies: CleanupDependencies = {},
): Promise<CleanupReport> {
	const resolvedWorkspace = resolve(workspace);
	const stopTemporaryBrowsers = dependencies.stopTemporaryBrowsers ?? stopWindowsTemporaryBrowsers;
	const listNames = dependencies.listNames ?? (async (path) => readdir(path));
	const remove = dependencies.remove ?? (async (path) => rm(path, { recursive: true, force: true, maxRetries: 2 }));
	const logError = dependencies.logError ?? ((message, error) => console.error(message, error));
	const report: CleanupReport = { removed: [], errors: [] };

	try {
		await stopTemporaryBrowsers(resolvedWorkspace);
	} catch (error) {
		recordError(report, "<temporary-browser-processes>", error, logError);
	}

	let names: string[];
	try {
		names = await listNames(resolvedWorkspace);
	} catch (error) {
		recordError(report, resolvedWorkspace, error, logError);
		return report;
	}

	for (const name of names) {
		if (!RESERVED_TEMPORARY_NAME_PATTERNS.some((pattern) => pattern.test(name))) continue;
		const target = join(resolvedWorkspace, name);
		try {
			await remove(target);
			report.removed.push(target);
		} catch (error) {
			recordError(report, target, error, logError);
		}
	}
	return report;
}

async function stopWindowsTemporaryBrowsers(workspace: string): Promise<void> {
	if (process.platform !== "win32") return;
	const marker = join(workspace, ".tmp-edge-profile");
	const script = [
		"$marker = $env:IMCLAW_TEMP_PROFILE_MARKER",
		"$processes = Get-CimInstance Win32_Process | Where-Object {",
		"  $_.Name -in @('msedge.exe', 'chrome.exe', 'chromium.exe') -and",
		"  $_.CommandLine -and $_.CommandLine.Contains($marker)",
		"}",
		"$processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
	].join("\n");

	await new Promise<void>((resolvePromise, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{
				windowsHide: true,
				env: { ...process.env, IMCLAW_TEMP_PROFILE_MARKER: marker },
			},
			(error) => {
				if (error) reject(error);
				else resolvePromise();
			},
		);
	});
}

function recordError(
	report: CleanupReport,
	path: string,
	error: unknown,
	logError: (message: string, error: unknown) => void,
): void {
	const message = error instanceof Error ? error.message : String(error);
	report.errors.push({ path, message });
	logError(`Failed to clean IMclaw temporary resource: ${path}`, error);
}
