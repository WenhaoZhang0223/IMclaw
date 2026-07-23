import { describe, expect, it } from "vitest";
import { IMCLAW_IDENTITY_PROMPT } from "../src/pi-backend.ts";

describe("IMCLAW_IDENTITY_PROMPT", () => {
	it("keeps replies and generated files in the current request language unless explicitly overridden", () => {
		expect(IMCLAW_IDENTITY_PROMPT).toContain("current request's primary language");
		expect(IMCLAW_IDENTITY_PROMPT).toContain(
			"file names, titles, headings, table labels, explanatory text, and file contents",
		);
		expect(IMCLAW_IDENTITY_PROMPT).toContain(
			"Do not produce bilingual output unless the user explicitly requests it",
		);
		expect(IMCLAW_IDENTITY_PROMPT).toContain("An explicit language instruction from the user takes priority");
	});

	it("describes the task and isolated browser guardrails", () => {
		expect(IMCLAW_IDENTITY_PROMPT).toContain("10 minutes");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("20 tool calls");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("at most two browser launches");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("headless");
		expect(IMCLAW_IDENTITY_PROMPT).toContain(".tmp-edge-profile");
		expect(IMCLAW_IDENTITY_PROMPT).toContain(
			"Never use the user's normal browser profile, cookies, tabs, or login state",
		);
	});

	it("describes read-only workfile search, ambiguity confirmation, and sending", () => {
		expect(IMCLAW_IDENTITY_PROMPT).toContain("workfile");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("read-only");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("find_workfile");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("send_workfile");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("multiple plausible candidates");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("relative path");
		expect(IMCLAW_IDENTITY_PROMPT).toContain("Never modify, move, rename, or delete");
	});
});
