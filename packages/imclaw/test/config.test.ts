import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const validEnv = {
	FEISHU_APP_ID: "cli_test",
	FEISHU_APP_SECRET: "secret-value",
	IMCLAW_OWNER_OPEN_ID: "ou_owner",
	IMCLAW_WORKSPACE: process.cwd(),
};

describe("loadConfig", () => {
	it("loads required values without exposing secrets in validation errors", () => {
		const config = loadConfig(validEnv);
		expect(config.feishuAppSecret).toBe("secret-value");
		expect(() => loadConfig({ ...validEnv, FEISHU_APP_ID: "" })).toThrow("FEISHU_APP_ID");
		expect(() => loadConfig({ ...validEnv, FEISHU_APP_ID: "" })).not.toThrow("secret-value");
	});

	it("requires provider and model together", () => {
		expect(() => loadConfig({ ...validEnv, IMCLAW_PROVIDER: "anthropic" })).toThrow(
			"IMCLAW_PROVIDER and IMCLAW_MODEL",
		);
	});
});
