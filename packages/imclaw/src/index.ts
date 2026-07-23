import { loadConfig } from "./config.ts";
import { ImclawController } from "./controller.ts";
import { FeishuAdapter } from "./feishu-adapter.ts";
import { PiAgentBackend } from "./pi-backend.ts";

const config = loadConfig();
const adapter = new FeishuAdapter(config.feishuAppId, config.feishuAppSecret, config.ownerOpenId);
const backend = new PiAgentBackend(config, adapter);
const controller = new ImclawController(adapter, backend, config.ownerOpenId);
let stopping = false;

async function shutdown(signal: string): Promise<void> {
	if (stopping) return;
	stopping = true;
	console.log(`IMclaw stopping (${signal})`);
	await adapter.stop();
	await controller.dispose();
	process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await adapter.start((message) => {
	void controller.handle(message).catch((error: unknown) => {
		console.error("IMclaw message dispatch failed", error);
	});
});
console.log(`IMclaw connected. Workspace: ${config.workspace}`);
