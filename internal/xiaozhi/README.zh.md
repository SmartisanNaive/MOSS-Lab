# 小智 MCP 桥接

[English](README.md) | 中文

此内部 Cordis 插件由本地启动配置启用。插件读取项目根目录 `.env` 中的 `XIAOZHI_WSS_URL`，主动建立一条 WSS 连接，地址和凭据不会写入日志。只支持 `wss:`；连接关闭后不自动重连，卸载插件时关闭连接。

桥接以 WebSocket 文本消息交换 MCP JSON-RPC。已连接配置的接入点观察到 `initialize`、`notifications/initialized` 和 `tools/list` 请求并收到工具清单。硬件语音调用和断线恢复尚未验证。没有主动通知或语音播报能力。

插件注入 `experimentStore`、`sessionController` 和 `workspaceRegistry`。`sessionId` 选定初始委派会话，也是实验状态查询读取的会话。启动配置将其设为 null，因此首次委派会创建会话，之后的实验查询读取当前委派会话；小智请求仍不能选择会话。可信部署者可将其改为一个明确允许的会话：

```yaml
- insert:
    - id: xiaozhi-readonly
      name: file:///absolute/path/to/internal/xiaozhi/plugin.mjs
      config:
        sessionId: REPLACE_WITH_AUTHORIZED_SESSION_ID
```

`sessionId` 必须由受信任的部署者选定，并与小智端的使用者及其允许访问的网页会话对应。存储的会话检查不是身份认证；当前没有自动绑定或验证小智用户身份的机制，不适合共享或多用户部署。地址相当于访问凭据，应只由受信任的部署者持有。单个插件实例创建一个连接，部署者负责避免重复加载实例。

工具包含 `moss_status`、`moss_experiment_status`、`moss_delegate` 和 `moss_task_status`。`moss_experiment_status` 要求调用方提供实验 ID，仅查询所选会话内当前版本和最多 20 项最新检查状态，不返回协议、会话内容或检查结果。检查记录是存储数据，不证明设备就绪或运行安全。`moss_delegate(message, newTask=false)` 以不超过 8000 字节的文字委派到本地网页 Agent。首次调用在第一个工作区新建带时间戳的小智委派实验会话；后续调用默认继续同一会话，因此补充条件、修改参数和对确认的回答都在当前实验中进行。请求运行或超时期间再次调用 `moss_delegate` 会把完整最新要求以更高 generation 和 steer 送入同一任务与会话，最新要求生效，旧请求的迟到答复不能完成任务。Agent 阻塞在 `ask_user_question` 时，下一次委派会取消被阻塞的轮次，并把该消息作为回答送入同一会话。`newTask=true` 仅用于明确的新实验：另建会话、停止跟踪旧的运行任务并取消其轮次。实验助手等待确认时，若原话没有明确的新实验措辞，即使 `newTask` 为 true 也会作为回答继续同一会话。内存中最多保留 100 条任务回执。`moss_task_status` 按任务 ID 返回 `running`、`completed`、`error` 或 `timeout`、generation、完整 result（最多 4000 字符）、`awaitingConfirmation`、待确认的 `question`、`followJobId` 以及 `speech: { speak, text, reason }`。语音调用方仅在 `speak` 为 true 时原样播报 `speech.text` 一次，否则保持静默，不得朗读或概述 `result`。运行中的任务最多给出三次等待回复；待确认或最终确认问题只播报一次；没有确认问题的完成任务只给一句完成提醒。用户明确询问进度（`userQuery=true`）时给一次简短状态回复，不消耗等待预算。后续语音要求继续同一会话时，旧回执返回 `followJobId` 并保持静默；应改查该任务获取当前结果。`completed` 只表示 Agent 已回复；`awaitingConfirmation=true` 表示它在等待用户回答，下一次 `moss_delegate` 会继续同一会话。`timeout` 表示五分钟等待已超时，任务仍被跟踪。提交报错时任务是否已入队可能无法确定；返回的任务会继续保持活跃并被跟踪，使用者应查看网页会话。关闭桥接会停止观察，但不会停止网页任务。任务回执和当前会话身份保存在内存中，重启后丢失；重启后的首条消息会新建会话。

委派内容以网页 Agent 的全部本地权限在委派的工作区会话中执行；小智不提供已验证的用户身份，因此委派仅限运行网页应用的同一受信任使用者。此插件不公开真机控制。

本地测试不建立外部连接，在 `LabScriptAI-OT-V3` 应用目录运行：

```sh
node --import tsx/esm --test internal/xiaozhi/bridge.test.mjs internal/xiaozhi/delegation.test.mjs
```

还需要验证小智硬件的工具调用、会话身份绑定和重连行为；如需主动播报，还须确认平台提供的通知接口并单独实现验证。
