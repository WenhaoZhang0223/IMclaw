# pi-mono 核心架构与 IMclaw 接入点

IMclaw 基于 pi-mono，核心包保持原样：

- `packages/ai`：统一模型、鉴权、消息和流式响应。
- `packages/agent`：执行模型调用、工具调用和结果回填循环。
- `packages/coding-agent`：提供文件工具、`AgentSession`、JSONL 会话持久化和 SDK。
- `packages/imclaw`：IMclaw 新增的飞书适配、消息队列和 PM2 入口。

```mermaid
flowchart LR
    Feishu["飞书私聊"] --> Adapter["FeishuAdapter<br/>长连接、过滤、去重"]
    Adapter --> Controller["ImclawController<br/>鉴权、命令、FIFO 队列"]
    Controller --> Backend["PiAgentBackend<br/>每个 chat 一个持久化会话"]
    Backend --> Coding["pi-coding-agent<br/>AgentSession + 文件工具"]
    Coding --> Core["pi-agent-core<br/>Agent 工具循环"]
    Core --> AI["pi-ai<br/>模型与 Provider"]
    AI --> Provider["外部模型 API"]
```

```mermaid
sequenceDiagram
    participant U as 飞书主人
    participant F as FeishuAdapter
    participant C as ImclawController
    participant P as PiAgentBackend
    participant A as AgentSession

    U->>F: 文本消息
    F->>F: 仅私聊、主人校验、10 分钟去重
    F-->>C: 3 秒内入队并返回
    C-->>U: 已收到，正在处理
    C->>P: 按 chat FIFO 调用 prompt
    P->>A: 恢复或创建 JSONL 会话
    A->>A: 模型调用与 read/bash/edit/write 工具循环
    A-->>P: 最终 assistant 文本
    P-->>C: 回复
    C-->>U: 按 3500 字符分段发送
```

IMclaw 不修改三个核心包。上游更新时可从 `upstream` 拉取；冲突主要局限于根配置和新增 package。Agent 以启动 PM2 的 Windows 用户权限运行，因此应把 `IMCLAW_WORKSPACE` 指向专用目录，并保护飞书密钥和 pi 的鉴权文件。
