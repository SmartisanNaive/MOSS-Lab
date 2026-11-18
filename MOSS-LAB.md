# MOSS Lab

[English](#english) | [中文](#中文)

## 中文

MOSS 负责定制的 DeepSeek Harness 网页、会话、MOS / 小智桥接和只读机器人状态；LabscriptAI 插件负责协议模拟、动画和配置图。两者通过公开 MCP 接口连接。实验助手支持 Flex 和 OT-2 的本地仿真与预览。

准备 Node.js 24.9+、pnpm 11.28.5 和 uv。在根目录执行：

```sh
pnpm install
pnpm run build
cp .env.example .env
node moss-start.mjs
```

新任务默认使用「实验助手」，也可以在模式菜单中选择。已有会话保留原模式；可以在新会话开始前选择实验助手。启动前填写 `.env` 模型配置，保持凭据私有。首次启动按 `labscriptai-ot.lock.json` 下载并校验外部插件，再由插件自己的安装器准备依赖。网络或校验失败会停止启动，不会临时换版本。版本与每日升级 PR 流程见 [README](README.zh.md#插件更新)。

`.dsh-local/` 保存网页会话、实验数据库、插件安装和产物。升级前停止旧服务并备份此目录与 `.env`；保留已有数据库，不要用空目录覆盖。旧 `labscriptai-ot/.venv` 不再使用，确认没有独立用途后可自行删除。模拟及动画不代表机器人就绪；状态查询不会执行机器人动作。

要在真机运行，在 `.env` 中配置 `OPENTRONS_URL` 和 `MOSS_ALLOW_LIVE_ROBOT=1`。在「实验助手」中分析当前协议后，明确要求运行，再在网页核对设备、实验版本和实体台面并确认。暂停和继续需要网页确认。可以直接停止当前会话的运行。断线后先查询原运行状态，再决定是否继续。

网页 CI 使用 `MOSS web` 工作流检查构建、类型、实验存储与预览资源，以及网页客户端启动。该工作流不部署网站，也不运行需要真实机器人或模型凭据的测试。

## English

MOSS owns the customized DeepSeek Harness web client, sessions, MOS / Xiaozhi bridge, and read-only robot status. The LabscriptAI plugin owns protocol simulation, animation, and setup figures. They connect through public MCP tools. The experiment assistant supports local simulation and previews for Flex and OT-2.

Install Node.js 24.9+, pnpm 11.28.5, and uv. Run from the root:

```sh
pnpm install
pnpm run build
cp .env.example .env
node moss-start.mjs
```

New tasks default to the experiment assistant, which is also available in the mode menu. Existing conversations keep their mode. Choose the experiment assistant before starting a new conversation. Fill in the model configuration before startup and keep `.env` private. The first start downloads and verifies the plugin specified in `labscriptai-ot.lock.json`, then runs the plugin's own dependency installer. Network or checksum errors stop startup instead of selecting another version. See [README](README.md#plugin-updates) for version management and daily upgrade PRs.

`.dsh-local/` stores web sessions, experiments, plugin installations, and artifacts. Stop the old service and back up this directory and `.env` before upgrading; preserve the existing database. The old `labscriptai-ot/.venv` is no longer used; remove it only after checking for independent uses. Simulation and animation do not establish robot readiness; status queries do not move the robot.

For physical operation, set `OPENTRONS_URL` and `MOSS_ALLOW_LIVE_ROBOT=1` in `.env`. Analyze the current protocol in the experiment assistant, explicitly request a live run, then confirm the device, revision, and physical deck in the workbench. Pause and resume require confirmation. Stop is available for a run owned by the current conversation. Read the original run status after a lost connection before sending further actions.

The `MOSS web` workflow checks the build, types, experiment storage and preview resources, and web client boot. It does not deploy the site or run tests that require a real robot or model credentials.

## License and citation / 许可和引用

DeepSeek Harness uses [MIT](LICENSE). The external plugin retains the [LabscriptAI Research Citation License v1.0](https://github.com/KRATSZ/labscriptai-ot/blob/main/LICENSE) and [citation requirements](https://github.com/KRATSZ/labscriptai-ot/blob/main/CITATION.cff). Public use must cite the following; commercial use requires written permission from the rights holder:

Gao, Yuan et al. “Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering.” bioRxiv, 2025. [DOI: 10.1101/2025.09.30.679666](https://doi.org/10.1101/2025.09.30.679666).
