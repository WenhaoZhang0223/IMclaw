import { mkdir, mkdtemp, readdir, realpath, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findWorkfiles } from "../src/find-workfile.ts";

async function createWorkspace(): Promise<string> {
	const workspace = await mkdtemp(join(tmpdir(), "imclaw-find-workfile-"));
	await mkdir(join(workspace, "workfile"), { recursive: true });
	return workspace;
}

describe("findWorkfiles", () => {
	it("recursively ranks Chinese names, normalized separators, and metadata", async () => {
		const workspace = await createWorkspace();
		await mkdir(join(workspace, "workfile", "合同"), { recursive: true });
		await mkdir(join(workspace, "workfile", "reports"), { recursive: true });
		await writeFile(join(workspace, "workfile", "合同", "2025-客户A合同.pdf"), "a");
		await writeFile(join(workspace, "workfile", "合同", "2024-客户B合同.pdf"), "b");
		await writeFile(join(workspace, "workfile", "reports", "monthly_report.xlsx"), "report");

		const chinese = await findWorkfiles({ workspace }, "请把 2025 客户A 合同发给我");
		const normalized = await findWorkfiles({ workspace }, "monthly report");

		expect(chinese[0]?.path).toBe("合同/2025-客户A合同.pdf");
		expect(normalized[0]?.path).toBe("reports/monthly_report.xlsx");
		expect(chinese[0]).toMatchObject({
			fileName: "2025-客户A合同.pdf",
			extension: ".pdf",
			size: 1,
		});
		expect(chinese[0]?.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
		expect(chinese[0]?.score).toBeGreaterThan(0);
	});

	it("uses modification time for latest intent and limits results to ten", async () => {
		const workspace = await createWorkspace();
		const oldPath = join(workspace, "workfile", "报销表-旧.xlsx");
		const newPath = join(workspace, "workfile", "报销表-新.xlsx");
		await writeFile(oldPath, "old");
		await writeFile(newPath, "new");
		await utimes(oldPath, new Date("2025-01-01"), new Date("2025-01-01"));
		await utimes(newPath, new Date("2026-01-01"), new Date("2026-01-01"));
		for (let index = 0; index < 11; index += 1) {
			const numberedPath = join(workspace, "workfile", `报销表-${index}.xlsx`);
			await writeFile(numberedPath, String(index));
			await utimes(numberedPath, new Date("2024-01-01"), new Date("2024-01-01"));
		}

		const results = await findWorkfiles({ workspace }, "最新 报销表");

		expect(results).toHaveLength(10);
		expect(results[0]?.path).toBe("报销表-新.xlsx");
	});

	it("reports a missing workfile library", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "imclaw-find-missing-"));

		await expect(findWorkfiles({ workspace }, "合同")).rejects.toThrow("workfile 文件库不存在或无法读取");
	});

	it("returns no candidates when file metadata does not match the query", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, "workfile", "季度报告.pdf"), "report");

		await expect(findWorkfiles({ workspace }, "家庭照片")).resolves.toEqual([]);
	});

	it("continues when one nested directory cannot be read", async () => {
		const workspace = await createWorkspace();
		const root = join(workspace, "workfile");
		const blocked = join(root, "blocked");
		await mkdir(blocked);
		await writeFile(join(root, "visible.pdf"), "visible");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const results = await findWorkfiles(
			{
				workspace,
				fileSystem: {
					realpath,
					readdir: async (path, options) => {
						if (path === blocked) throw new Error("denied");
						return readdir(path, options);
					},
					stat,
				},
			},
			"visible",
		);

		expect(results.map((candidate) => candidate.path)).toEqual(["visible.pdf"]);
		expect(errorSpy).toHaveBeenCalledOnce();
		errorSpy.mockRestore();
	});
});
