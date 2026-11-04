# 内部实验存储

[English](README.md) | 中文

此内部 Node 模块将实验快照和检查结果存入明确指定的 SQLite 文件。本地启动器挂载其 Cordis 服务、认证预览路由和只读设备状态路由；设备控制尚未接入。

启用时，在本地 profile 补丁或 `--patch` 覆盖文件中添加以下条目，并将两个路径替换为主机上的绝对路径：

```yaml
- insert:
    - id: experiment-store
      name: file:///absolute/path/to/internal/experiment/plugin.mjs
      config:
        path: /absolute/path/to/experiments.sqlite
        create: false
```

仅在需要独占创建新数据库时设置 `create: true`；下次启动前将其改为 `false`。`experimentStore` 服务提供 `create`、`get`、`update`、`startCheck`、`finishCheck`、`getChecks` 和 `backup`，其参数与结果见下文。将服务注入 host 插件后即可使用。卸载时服务先撤销，等待进行中的备份，再关闭数据库。撤销后通过已保留的服务引用调用会以 `STORE_CLOSED` 失败。插件不会自动挂载到任何随附 profile。

构造 `ExperimentStore` 时必须指定绝对路径 `path` 和布尔值 `create`。`create: true` 在现有目录中独占创建数据库文件；`create: false` 打开现有数据库，并拒绝不存在的文件或不支持的 schema。构造时先执行 SQLite `integrity_check`。每个实例使用完毕后调用 `close()`。

`create({ creationKey, snapshot })` 记录修订版本 1。以相同键和 JSON 快照重复调用会返回初始版本；快照不同时返回 `IDEMPOTENCY_CONFLICT`。快照是完整的 JSON 对象，必须包含字符串或 null 类型的 `protocol`。快照可包含需求、会话细节、参数、设备配置和产物引用。协议哈希是 UTF-8 协议字符串的 SHA-256 值。JSON 对象键顺序不影响幂等判断。

`update({ id, expectedRevision, snapshot })` 提交完整的新快照，或者抛出包含当前版本的 `REVISION_CONFLICT`。初始快照包含非空字符串 `sessionId` 时，每次更新都必须保留该值。`get(id, revision)` 读取历史版本；省略版本则读取最新版本。SQLite 中的修订行不能更新或删除。需求、参数、协议和设备配置变更均须创建新版本，检查结果不会继承。

内部服务还提供 `createForSession(sessionId, input)`、`getForSession(sessionId, id, revision)`、`updateForSession(sessionId, input)` 和 `getChecksForSession(sessionId, id, revision)`。主机必须提供可信的非空会话身份。创建时会将该身份写入快照，拒绝冲突的传入 `sessionId`，并按会话隔离幂等键；更新时必须包含相同的 `sessionId`。读取和更新会以 `SESSION_MISMATCH` 拒绝初始快照无所有者、所有者不同以及 `sessionId` 不同的修订。更新在同一事务内检查归属并提交。打开 schema 1 数据库时会通过事务迁移至 schema 2 并添加辅助创建键表；已有全局键与会话键分开，不会自动采用。

`startCheck({ id, revision, protocolHash, name })` 返回任务标识并将该检查标记为运行中。`finishCheck` 必须提供返回的字段、终态 `status`（`passed`、`failed`、`error` 或 `blocked`）及 JSON `result`。只有当前版本、准确协议哈希和该名称的最新任务可以完成；旧任务或重复结果以 `STALE_TASK` 失败，错误哈希以 `PROTOCOL_MISMATCH` 失败。`getChecks(id, revision)` 按创建顺序读取尝试记录。再次启动同名检查会将运行中的尝试标记为 `superseded`，并保留之前的结果。

`await store.backup({ directory, retain })` 在明确指定的现有绝对目录中创建在线 SQLite 快照，使用 `integrity_check` 验证，并返回已验证的备份路径。`retain` 必须为正整数；发布后保留新备份及同一规范源路径的最新匹配备份，总数不超过该值。它不会清理其他源路径、不匹配文件、符号链接或源文件。备份使用私有暂存目录和仅所有者可访问的文件权限。备份目录应可信并阻止其他写入者；文件系统身份检查无法排除并发替换竞争。恢复时可用 `create: false` 打开选定的备份，或在备份关闭时复制到独立存储位置。

备份由调用方触发，不会启动调度器。关闭存储前必须等待每个备份完成；存在进行中的备份时 `close()` 抛出 `BACKUP_IN_PROGRESS`。目标目录中按源路径设置的锁阻止不同实例的备份及清理重叠；重叠操作以 `EEXIST` 失败。进程崩溃后，重试前应检查并删除遗留的 `experiment-backup-<source hash>-lock` 目录。发布前失败不会清理备份；发布后或清理期间失败可能留下已验证备份和部分完成的清理。清理失败可能留下暂存或锁目录，并报告给调用方。调用方负责重试、调度、错误报告和遗留文件清理。

预期失败通过 `ExperimentError.code` 和 `details` 提供信息。SQLite 和操作系统错误也可能向外传播。提交前发生错误时事务回滚；若回滚失败，应关闭实例并检查数据库后再继续操作。调用方负责报告错误和恢复。每次操作都会检查配置的文件与父目录身份；路径缺失或被替换时返回 `STORAGE_UNAVAILABLE`，即使路径恢复，该实例也会保持禁用。解决存储问题后重新打开，重新执行完整性检查。

从 `LabScriptAI-OT-V3` 应用目录使用 Node 24.9 或更高版本运行针对性测试：

```sh
node --import tsx/esm --test internal/experiment/tests/experiment.test.mjs internal/experiment/tests/plugin.test.mjs
```

## 预览组件

`buildPreview` 仅在最新 `protocol-analysis` 检查与当前会话、版本、协议哈希和分析结果的 SHA-256 一致时，从分析数据构建临时 Flex3D 场景。调用方必须从可信检查执行器获取分析数据；存储接受调用方提供的结果，本身不建立这一信任。调用方负责返回目录及其清理。场景生成以受限环境和超时运行本地 Python 播放器库，但不隔离进程，也不执行协议 Python。场景构建测试已从最小分析数据生成 Flex 视图；测试没有运行协议，也不表明实验安全。

`PreviewResources` 将已发布的预览映射到固定的播放器、脚本、数据和图片资源，并在每次请求时重新检查当前版本和最新分析。在应用目录运行 `node moss-start.mjs` 启动本地工作台。启动器将 `labscriptai-ot/.venv/bin` 放在网页进程及其子进程的 `PATH` 首位并设置 `VIRTUAL_ENV`；Agent 指引要求 Python 工作使用该环境，并通过 `analyze_experiment` 分析协议。显式指定解释器路径或覆盖环境变量仍可选择其他环境。工作流通过 DSH 沙箱调用 Opentrons，并在有结构化协议错误时报告其详情。沙箱限制写入，但不阻止读取或网络访问，协议代码因此可能连接设备。演示分析内置示例。本地集成测试已分析修改过的示例协议并发布当前会话预览；模拟不能证明设备就绪或实验安全。播放器使用 LabscriptAI Research Citation License v1.0；引用和商业使用条款见项目实施记录。

通过的 `protocol-analysis` 检查在 SHA-256 之外保存完整分析数据（`analysisBase64`）。`get_experiment` 的检查结果不返回这些数据；内部仍可使用它们恢复预览。已发布预览和会话内选择仅保存在进程内存中；重启后轮询某会话状态且没有已选预览时，状态路由会用该会话最新实验的最新通过检查所保存的分析数据重建场景，校验其摘要，并在重建完成前返回 `checking`。每个进程对每项已完成检查最多尝试一次恢复；检查通过前的轮询不会消耗这次尝试。分析持久化开始之前记录的检查无法恢复。

认证路由 `/api/robot-status` 在启动时读取 `OPENTRONS_URL`，仅在用户请求时查询机器人的健康及移液器接口。结果包含可用的型号、健康状态、移液器和查询时间；未配置、不可达或部分响应分别报告。此快照不代表设备已就绪或实验安全。

工作流在分析前捕获当前要求，并在检查或预览发布前再次核对。发布后通过捕获的确认回调直接更新工作台；新要求会抑制旧流程的确认。重启恢复只重建已保存的场景，不宣告新任务完成。

## 已知限制

- 本地主机插件提供模型生成协议的 Agent 工具；MCP 实验操作尚未接入。预览选择保存在内存中；重启后状态路由会按上文用保存的分析数据重建，重建只重新生成场景，不重新运行分析。
- 协议和动画支持取决于 Opentrons 和 Flex3D。尚不提供完整校验、报告存储、设备操作或导出。存储的 `passed` 结果仅由调用方提供，不得用于授权设备运行。
- 迟到结果被拒绝且不记录。重启后不会自动恢复运行中的检查。
- 会话约束方法是存储基础，不提供身份认证或完整授权。主机必须认证会话并执行授权，且仅在可信的内部路径使用无限制方法和检查写入方法。尚无备份调度器、外部磁盘监测或数据目录配置接入。文件身份检查能检测许多丢失和替换情况，但不能保证检测所有文件系统或存储故障，也不能消除所有检查与使用之间的竞争。最终 host 必须展示 SQLite 和文件系统错误。
- 插件从源文件加载。带覆盖配置的 Web profile 已启动并达到就绪状态，没有报告插件错误；应用消费者和打包部署尚未验证。
