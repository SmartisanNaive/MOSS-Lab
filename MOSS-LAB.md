# MOSS Lab

[English](#english) | [中文](#中文)

## 中文

MOSS Lab 在同一个项目中提供网页 Agent、本地 Opentrons 协议模拟和 Flex3D 动画。机器人相关源码位于 `labscriptai-ot/`；网页启动器不依赖同级的机器人项目。

准备 Node.js 24.9 或更高版本、pnpm 和 uv。在项目根目录安装 Node 依赖和构建产物，并在机器人源码目录按锁文件创建 Python 环境：

```sh
pnpm install
pnpm run build
uv sync --project labscriptai-ot --locked
```

将项目根目录的 `.env.example` 复制为 `.env`，填写模型和小智配置。`OPENTRONS_URL` 仅用于可选的只读状态查询。`.env` 包含凭据，不要上传。随后从项目根目录启动：

```sh
node moss-start.mjs
```

网页会话和实验数据库保存在项目根目录 `.dsh-local/`；该目录、`.env`、Python 虚拟环境和 Node 依赖都不应上传。若从旧布局迁移，请先停止旧网页服务，保留原始数据，再将原外层目录的 `.dsh-local/` 复制到本项目根目录。不要覆盖已有的数据目录。原外层 `.env` 中的配置也需要迁移到本项目根目录的 `.env`；请安全处理凭据。

本地模拟和动画不证明设备就绪或实验安全。机器人状态查询不会执行设备动作；机器人连接需要可访问且兼容的服务。

## English

MOSS Lab combines the web agent, local Opentrons protocol simulation, and Flex3D animation in one project. Robot-related source is in `labscriptai-ot/`; the web launcher does not depend on a sibling robot project.

Install Node.js 24.9 or later, pnpm, and uv. From the project root, install Node dependencies and build artifacts, then create the Python environment from the robot project's lockfile:

```sh
pnpm install
pnpm run build
uv sync --project labscriptai-ot --locked
```

Copy `.env.example` in the project root to `.env` and fill in the model and Xiaozhi configuration. `OPENTRONS_URL` is optional and used for read-only status queries. Keep `.env` private. Start from the project root:

```sh
node moss-start.mjs
```

Web sessions and the experiment database are stored in `.dsh-local/` at the project root. Do not upload that directory, `.env`, the Python environment, or Node dependencies. To migrate from the previous layout, stop the old web service, preserve the original data, then copy the old outer directory's `.dsh-local/` into this project root. Do not overwrite an existing data directory. Migrate the old outer `.env` configuration to this project root as well, handling credentials securely.

Local simulation and animation do not establish device readiness or experimental safety. Status queries do not move the robot; a reachable compatible service is required.

## License and citation / 许可和引用

DeepSeek Harness is distributed under its [MIT license](LICENSE). The included `labscriptai-ot/` code and resources retain the [LabscriptAI Research Citation License v1.0](labscriptai-ot/LICENSE) and [citation requirements](labscriptai-ot/CITATION.cff). Public use, including a public repository, requires this citation; commercial use requires written permission from the rights holder:

Gao, Yuan et al., “Autonomous Liquid-handling Robotics Scripting for Accessible and Responsible Protein Engineering,” bioRxiv, 2025. DOI: [10.1101/2025.09.30.679666](https://doi.org/10.1101/2025.09.30.679666).

The included robot source snapshot is based on commit `a3182eb5befc8ce535c33a225ae80b287e87c211`, with local Flex3D viewer changes. Its individual third-party notices remain in the source tree. Inclusion does not automatically install its separate MCP plugin or validate every optional plugin feature.
