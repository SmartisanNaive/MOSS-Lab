# MOSS Lab

[English](#english) | [中文](#中文)

## 中文

MOSS 负责定制的 DeepSeek Harness 网页、会话、MOS / 小智桥接和只读机器人状态；LabscriptAI 插件负责协议模拟、动画和配置图。两者通过公开 MCP 接口连接。实验助手支持 Flex 和 OT-2 的本地仿真与预览。

Windows 10/11 x64 推荐先安装 Python 3.12，然后在 PowerShell 执行（首次需要联网）：

```powershell
py -m pip install "https://github.com/SmartisanNaive/MOSS-Lab/releases/download/moss-v0.1.0/moss_lab-0.1.0-py3-none-win_amd64.whl"
py -m moss_lab config
py -m moss_lab start
```

已有数据时先停止旧 MOSS，将 `config` 换成 `py -m moss_lab import "C:\原来的目录\MOSS-Lab" --stopped`，再启动。导入会保留原目录；已有新安装数据时会拒绝覆盖。日常升级先停止 MOSS，再运行 `py -m moss_lab update`；回退用 `py -m moss_lab rollback`。数据保留与中断恢复见 [Windows 安装说明](python/moss-lab/README.md)。

源码开发方式：准备 Node.js 24.9+、pnpm 11.28.5 和 uv。在根目录执行：

```sh
pnpm install
pnpm run build
cp .env.example .env
node moss-start.mjs
```

新任务默认使用「实验助手」，也可以在模式菜单中选择。已有会话保留原模式；可以在新会话开始前选择实验助手。启动前填写 `.env` 模型配置，保持凭据私有。首次启动按 `labscriptai-ot.lock.json` 下载并校验外部插件，再由插件自己的安装器准备依赖。网络或校验失败会停止启动，不会临时换版本。版本与每日升级 PR 流程见 [README](README.zh.md#插件更新)。

`.dsh-local/` 保存网页会话、实验数据库、插件安装和产物。升级前停止旧服务并备份此目录与 `.env`；保留已有数据库，不要用空目录覆盖。旧 `labscriptai-ot/.venv` 不再使用，确认没有独立用途后可自行删除。模拟及动画不代表机器人就绪；状态查询不会执行机器人动作。

「实验助手」读取 LabscriptAI 发布的工具和实验指引。在网页打开小智当前的实验会话，即可继续同一个实验。说“看台面”可按需调用插件拍照和识别。若识别缺依赖，可用 `MOSS_VISION_PYTHON` 指向装有插件视觉依赖的 Python。照片通过工作台的通用图片附件显示，取决于当前模型是否支持图片输入。

要在真机运行，在 `.env` 中配置 `OPENTRONS_URL` 和 `MOSS_ALLOW_LIVE_ROBOT=1`。分析当前协议，明确要求运行，再在网页核对设备、实验版本和实体台面。一次确认覆盖本次运行及 LabscriptAI 支持的小故障自动恢复。暂停和继续需要网页确认。可以直接停止当前会话的运行。断线后先查询原运行状态，再决定是否继续。

网页 CI 使用 `MOSS web` 工作流检查构建、类型、实验存储与预览资源，以及网页客户端启动。该工作流不部署网站或操作真实机器人；Windows 安装任务使用受限模型凭据验证已安装程序与两机型本地仿真。

## English

MOSS owns the customized DeepSeek Harness web client, sessions, MOS / Xiaozhi bridge, and read-only robot status. The LabscriptAI plugin owns protocol simulation, animation, and setup figures. They connect through public MCP tools. The experiment assistant supports local simulation and previews for Flex and OT-2.

On Windows 10/11 x64, install Python 3.12, then use PowerShell (first start needs network access):

```powershell
py -m pip install "https://github.com/SmartisanNaive/MOSS-Lab/releases/download/moss-v0.1.0/moss_lab-0.1.0-py3-none-win_amd64.whl"
py -m moss_lab config
py -m moss_lab start
```

For an existing installation, stop the old MOSS service and replace `config` with `py -m moss_lab import "C:\old-directory\MOSS-Lab" --stopped`, then start. Import preserves the source and refuses to overwrite an existing managed home. Stop MOSS before `py -m moss_lab update`; use `py -m moss_lab rollback` to restore the preceding application and data. See [Windows installation](python/moss-lab/README.md) for data retention and interrupted-update recovery.

For source development, install Node.js 24.9+, pnpm 11.28.5, and uv. Run from the root:

```sh
pnpm install
pnpm run build
cp .env.example .env
node moss-start.mjs
```

New tasks default to the experiment assistant, which is also available in the mode menu. Existing conversations keep their mode. Choose the experiment assistant before starting a new conversation. Fill in the model configuration before startup and keep `.env` private. The first start downloads and verifies the plugin specified in `labscriptai-ot.lock.json`, then runs the plugin's own dependency installer. Network or checksum errors stop startup instead of selecting another version. See [README](README.md#plugin-updates) for version management and daily upgrade PRs.

`.dsh-local/` stores web sessions, experiments, plugin installations, and artifacts. Stop the old service and back up this directory and `.env` before upgrading; preserve the existing database. The old `labscriptai-ot/.venv` is no longer used; remove it only after checking for independent uses. Simulation and animation do not establish robot readiness; status queries do not move the robot.

The experiment assistant discovers the tools and instructions published by LabscriptAI. Open the active Xiaozhi conversation in the workbench to continue its experiment by text. Ask to see the deck to invoke the plugin's camera and recognition on demand. If recognition dependencies are missing, set `MOSS_VISION_PYTHON` to a Python interpreter with the plugin's vision dependencies. The workbench uses its shared image attachment path when the selected model supports image input.

For physical operation, set `OPENTRONS_URL` and `MOSS_ALLOW_LIVE_ROBOT=1` in `.env`. Analyze the current protocol, request a live run, and confirm the device, revision, and physical deck in the workbench. This approval covers the run and LabscriptAI automatic recovery for supported minor faults. Pause and resume require confirmation. Stop is available for a run owned by the current conversation. Read the original run status after a lost connection before sending further actions.

The `MOSS web` workflow checks the build, types, experiment storage and preview resources, and web client boot. It does not deploy the site or operate a physical robot. The Windows installer job uses bounded model credentials to verify the installed workbench and both local robot simulations.

## License and citation / 许可和引用

DeepSeek Harness uses [MIT](LICENSE). The external plugin retains the [LabscriptAI Research Citation License v1.0](https://github.com/KRATSZ/labscriptai-ot/blob/main/LICENSE) and [citation requirements](https://github.com/KRATSZ/labscriptai-ot/blob/main/CITATION.cff). Public use must cite the following; commercial use requires written permission from the rights holder:

Gao, Yuan et al. “Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering.” bioRxiv, 2025. [DOI: 10.1101/2025.09.30.679666](https://doi.org/10.1101/2025.09.30.679666).
