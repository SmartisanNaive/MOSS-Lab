# 小智 MCP 桥接

[English](README.md) | 中文

本地 MOSS 启动配置把此 Cordis 插件与已有网页 Agent 一同挂载。配置 `XIAOZHI_WSS_URL` 时建立一条主动 WSS 连接并提供 MCP 工具；地址是凭据，不写入日志。不配置接入点时仍可使用认证后的本地工作台。连接断开后按有上限的指数退避重连，并用 WebSocket ping/pong 检查链路。重连会重新注册工具，不重发已接受的 Agent 任务；任务回执仍只保存在内存中。

语音委派使用名为**实验助手**的 `moss-experiment` 预设，提供实验角色及实验工具，包括用于追问必要条件的 `request_experiment_input`，不载入通用编程模式、Shell 或仓库工程指令。

`moss_delegate(message, newExperiment=false)` 把用户原话交给当前实验会话。补充条件和修改参数复用同一会话；只有明确的新实验才另建。模型不能传入会话 ID。部署者可通过 `sessionId` 指定初始会话；未指定时首条请求使用已有工作区，尚无工作区时使用配置的 `workspacePath` 创建会话。私有 `bindingPath` 文件以原子替换保存当前会话和导航序号。重启后的下一条消息复用该身份；原会话缺失或仍使用旧编程模式时报告错误，不悄悄另建会话；明确开始新实验后采用实验模式，旧对话继续保留。

`moss_task_status(jobId, userQuery=false)` 跟踪已接受的轮次。`completed` 只表示 Agent 已回复，包括追问，绝不表示真机实验完成。新改口立即取代旧语音要求，并引导同一会话继续处理；未被领取的旧语音输入被移除，失效分析不能发布通过记录或预览。超时或提交结果不确定时仍保留跟踪。关闭服务只停止观察，不停止网页 Agent。任务回执仅在内存中保存。绑定会话中从网页发起的工作流也通过同一工作台发布检查通过的预览，此时 `jobId=null`，已有 MCP 任务回执保持不变。确认回调捕获结果归属，迟到结果不能覆盖更新的语音要求。

`moss_experiment_status(id)` 查询当前语音实验会话；尚未委派时回退到部署者指定的初始会话。`moss_status` 返回电脑端服务、委派是否可用及支持的实验任务，不代表设备就绪。桥接不提供真机执行工具。

认证 Connection 提供 `GET /api/xiaozhi-workbench`，返回最新导航序号、会话、任务、状态及答复，以及不含凭据的 `connection` 和 `wakeup` 诊断。`connection.status=ready` 表示接入点已请求并收到工具清单，不表示实体麦克风已经验证。网页只在首次打开、追问必要条件及当前检查通过的预览就绪时跟随 `focusSequence`；普通改口和轮询保留用户选择。准备替代方案时隐藏旧预览，当前精确版本检查通过后可在 Agent 结束答复前显示。`POST /api/xiaozhi-workbench/message` 接受 JSON `{message, newExperiment?}`，作为调用同一委派服务的本地文字入口，要求同源 Origin 头，拒绝任意会话身份及其他来源网页的请求，不增加 Agent 权限。

此功能面向单操作员。小智接入点不提供已验证的人类身份；持有接入凭据者可以网页 Agent 现有的本地权限提交工作。会话归属检查不是用户认证。部署者须保密接入地址并避免重复启动桥接实例。

每个任务周期最多给出三次自动等待确认，偏移为 0、15、45 秒；提前完成不补齐提示。改口共用预算，终态之后的新任务重置预算；达到上限后工具明确要求安静。完成时只保留一句简短提醒，用户主动询问进度另算。实际播报仍由托管模型控制，须通过设备验证。完成提醒通过当前语音对话中的任务状态查询交付，不提供空闲设备主动播报通道。

在项目根目录使用 Node 24.9 或更高版本运行针对性测试：

```sh
node --import tsx/esm --test internal/xiaozhi/*.test.mjs
```

硬件收音识别及托管服务的工具选择必须通过实际设备发话验证。`connection.lastCall.source=xiaozhi-mcp` 可区分来自真实接入点的请求和本地 HTTP 入口。配置的 `diagnosticsPath` 保存连接变化与工具名称，不记录接入令牌或用户消息正文。本地 HTTP/MCP 注入和浏览器验证不代表麦克风能力或机器人就绪。

macOS 默认在首次接受委派时打开工作台（`MOSS_AUTO_WAKE=1`）；`MOSS_BROWSER_APP` 可选 Google Chrome（默认）、Microsoft Edge 或 Safari。服务复用同一本地来源的标签页，恢复最小化窗口；匹配的标签页均已关闭时才新开窗口。服务重启后的首次唤起会重新认证标签页，后续普通改口只检查标签页是否存在，不置前、不刷新；标签页缺失时重新打开。追问条件及当前预览就绪时恢复窗口并置前。macOS 可能要求操作员允许浏览器自动化。授权登录地址通过标准输入交给本地助手，不进入命令参数或日志。唤起失败或关闭自动唤起都不会取消已接受的任务；`wakeup` 保留状态与原因，失败也会留下不含凭据的日志。其他操作系统启用此功能时返回 `unsupported_platform`，可保持网页打开或关闭自动唤起。

部署配置可调整 `transport.reconnectMinMs`、`reconnectMaxMs`、`connectTimeoutMs`、`heartbeatMs`、`feedback.offsetsMs`、`pollWaitMs` 及 `wakeup.enabled`、`browserApp`、`timeoutMs`；这些参数只影响连接维护和可信本地浏览器助手，不增加 Agent 工具权限。
