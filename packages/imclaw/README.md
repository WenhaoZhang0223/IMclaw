# IMclaw 本机运行指南

## 1. 飞书后台配置

创建企业自建应用并开启机器人能力。添加应用身份权限：

- `im:message.p2p_msg:readonly`：接收发给机器人的单聊消息。
- `im:message:send_as_bot`：以机器人身份回复。

在“事件与回调”中选择长连接，并订阅 `im.message.receive_v1`。发布应用版本，然后把机器人添加到你的飞书工作台或联系人。

首次配置时可以先把 `IMCLAW_OWNER_OPEN_ID` 设为 `placeholder`，给机器人发送一条文本消息，然后在 PM2 日志的 `Rejected Feishu sender` 行读取你自己的 `open_id`。用该值更新环境变量并重启。只有这个账号能调用 Agent；群聊被静默忽略。

## 2. 配置模型

IMclaw 默认复用 `%USERPROFILE%\.pi\agent` 下的 pi 模型配置和鉴权。先在仓库里运行 Pi 并完成模型登录：

```powershell
npm run build
node packages/coding-agent/dist/cli.js
```

也可以设置 `IMCLAW_PROVIDER` 和 `IMCLAW_MODEL` 固定模型，两者必须同时设置。

## 3. 设置环境变量并构建

在 PowerShell 中运行：

```powershell
$env:FEISHU_APP_ID = "cli_xxx"
$env:FEISHU_APP_SECRET = "你的 App Secret"
$env:IMCLAW_OWNER_OPEN_ID = "ou_xxx"
$env:IMCLAW_WORKSPACE = "C:\Users\你的用户名\Projects\IMclaw"

npm install --ignore-scripts
npm run build
```

可选变量：

- `IMCLAW_AGENT_DIR`：默认 `%USERPROFILE%\.pi\agent`。
- `IMCLAW_PROVIDER`、`IMCLAW_MODEL`：固定模型。

## 4. 使用 PM2

```powershell
npx pm2 start ecosystem.config.cjs
npx pm2 logs IMclaw
npx pm2 save
```

环境变量必须存在于启动 PM2 的终端或 Windows 用户环境中。修改代码后重新构建并执行 `npx pm2 restart IMclaw --update-env`。

Windows 登录后自动恢复可使用“任务计划程序”运行：

```powershell
Set-Location "C:\Users\你的用户名\Projects\IMclaw"
npx pm2 resurrect
```

电脑必须保持开机且不能进入会中断网络的睡眠状态。

## 飞书命令

- `/help`：显示命令。
- `/new`：开启新会话。
- `/status`：显示模型、会话和运行状态。
- `/abort`：立即中止当前任务并清空该聊天的等待队列。

其他文本会交给 coding-agent。需要回传文件时，Agent 会在 `IMCLAW_WORKSPACE` 内生成最终文件并通过 `deliver_file` 发送到当前私聊。支持最大 30 MB 的非空普通文件；发送成功后删除该本地文件，上传或发送失败时保留文件以便重试。

## workfile 长期文件库

把自行维护的文件放在 `IMCLAW_WORKSPACE/workfile/` 中，可以使用任意层级的子目录。在飞书中用自然语言要求“把某个文件发给我”时，IMclaw 会根据文件名、相对目录、扩展名和修改时间实时检索，不会读取文件正文。

唯一强匹配会直接发送；存在多个相近结果时，IMclaw 会列出候选并等待确认。发送文件最大为 30 MB，`workfile/` 中的原文件无论成功或失败都不会被修改、移动或删除。

部署功能代码后需要重新构建并重启 IMclaw。此后向 `workfile/` 添加或替换文件不需要重启，下一次请求会立即检索到最新目录状态。

会话按聊天 ID 的 SHA-256 目录保存到 `IMCLAW_AGENT_DIR/imclaw-sessions`，重启后自动继续最近会话。
