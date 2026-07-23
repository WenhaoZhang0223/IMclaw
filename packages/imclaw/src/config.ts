import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ImclawConfig {
	feishuAppId: string;
	feishuAppSecret: string;
	ownerOpenId: string;
	workspace: string;
	agentDir: string;
	provider?: string;
	model?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ImclawConfig {
	const defaultWorkspace = fileURLToPath(new URL("../../..", import.meta.url));
	const workspace = resolve(env.IMCLAW_WORKSPACE?.trim() || defaultWorkspace);
	if (!existsSync(workspace)) throw new Error(`IMCLAW_WORKSPACE does not exist: ${workspace}`);

	const provider = env.IMCLAW_PROVIDER?.trim() || undefined;
	const model = env.IMCLAW_MODEL?.trim() || undefined;
	if ((provider && !model) || (!provider && model)) {
		throw new Error("IMCLAW_PROVIDER and IMCLAW_MODEL must be configured together");
	}

	return {
		feishuAppId: required(env, "FEISHU_APP_ID"),
		feishuAppSecret: required(env, "FEISHU_APP_SECRET"),
		ownerOpenId: required(env, "IMCLAW_OWNER_OPEN_ID"),
		workspace,
		agentDir: resolve(env.IMCLAW_AGENT_DIR?.trim() || resolve(homedir(), ".pi", "agent")),
		provider,
		model,
	};
}
