module.exports = {
	apps: [
		{
			name: "IMclaw",
			script: "packages/imclaw/dist/index.js",
			cwd: __dirname,
			interpreter: "node",
			exec_mode: "fork",
			instances: 1,
			autorestart: true,
			restart_delay: 3000,
			max_memory_restart: "1G",
			time: true,
		},
	],
};
