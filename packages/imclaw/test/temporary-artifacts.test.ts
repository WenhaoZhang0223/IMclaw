import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTemporaryArtifacts } from "../src/temporary-artifacts.ts";

async function createWorkspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "imclaw-cleanup-"));
}

describe("cleanupTemporaryArtifacts", () => {
	it("removes only reserved root-level temporary resources", async () => {
		const workspace = await createWorkspace();
		await mkdir(join(workspace, ".tmp-edge-profile1"));
		await writeFile(join(workspace, ".tmp-cdp-script.cjs"), "temporary");
		await writeFile(join(workspace, ".tmp-edge1.out"), "temporary");
		await writeFile(join(workspace, ".tmp-reply-urls.json"), "temporary");
		await mkdir(join(workspace, "deliverables"));
		await writeFile(join(workspace, "deliverables", "report.xlsx"), "keep");
		await mkdir(join(workspace, "workfile"));
		await writeFile(join(workspace, "workfile", "source.pdf"), "keep");
		await writeFile(join(workspace, "normal.txt"), "keep");
		const stopTemporaryBrowsers = vi.fn(async () => {});

		const report = await cleanupTemporaryArtifacts(workspace, { stopTemporaryBrowsers });

		expect(stopTemporaryBrowsers).toHaveBeenCalledWith(workspace);
		expect(report.errors).toEqual([]);
		expect((await readdir(workspace)).sort()).toEqual(["deliverables", "normal.txt", "workfile"]);
		await expect(stat(join(workspace, "deliverables", "report.xlsx"))).resolves.toBeDefined();
		await expect(stat(join(workspace, "workfile", "source.pdf"))).resolves.toBeDefined();
	});

	it("continues after one removal fails and reports the failure", async () => {
		const workspace = await createWorkspace();
		const first = join(workspace, ".tmp-cdp-first.cjs");
		const second = join(workspace, ".tmp-cdp-second.cjs");
		await writeFile(first, "first");
		await writeFile(second, "second");
		const remove = vi.fn(async (path: string) => {
			if (path === first) throw new Error("locked");
		});

		const report = await cleanupTemporaryArtifacts(workspace, {
			stopTemporaryBrowsers: async () => {},
			remove,
			logError: vi.fn(),
		});

		expect(remove).toHaveBeenCalledTimes(2);
		expect(report.errors).toEqual([{ path: first, message: "locked" }]);
	});

	it("does not throw when temporary browser shutdown fails", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, ".tmp-video-body.txt"), "temporary");

		const report = await cleanupTemporaryArtifacts(workspace, {
			stopTemporaryBrowsers: async () => Promise.reject(new Error("process query failed")),
			logError: vi.fn(),
		});

		expect(report.errors[0]?.path).toBe("<temporary-browser-processes>");
		expect(await readdir(workspace)).toEqual([]);
	});
});
