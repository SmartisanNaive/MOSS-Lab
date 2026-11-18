# MOSS Windows 发行包

[English](README.md) | 中文

安装包包含 MOSS 网页、实验与小智插件、JavaScript 生产依赖、校验锁定的完整 Node（含 npm）和 uv。电脑只需预装 Python 3.10 以上，推荐 3.12。首次启动联网准备锁定版本的 OT 依赖。

新安装执行 `py -m moss_lab config`，填写模型地址、名称和密钥，再执行 `py -m moss_lab start`。已有 MOSS 时先停止旧服务，将配置步骤换成 `py -m moss_lab import "C:\原目录\MOSS-Lab" --stopped`。导入会复制 `.env` 和 `.dsh-local`，保留原目录；新目录已有数据时拒绝覆盖。

配置和实验记录放在 `%LOCALAPPDATA%\MOSS-Lab`，与 Python 安装目录分开。可用 `MOSS_HOME` 或全局参数 `--home` 指定其他私有目录。不同应用版本按清单摘要解压到 `releases/`，pip 不直接替换运行中的应用文件。

升级前停止 MOSS，再运行 `py -m moss_lab update`。它下载 GitHub 正式 `moss-v*` 版本，验证校验值，保留旧安装包和数据快照，安装新包并检查启动。新应用启动失败时，确认进程树停止后恢复旧包和对应数据。如果不能确认进程已退出，就保留恢复记录，拒绝覆盖数据。pip 写入过程单独持锁，安装器退出不会让仍在写入的 pip 失去保护。

`py -m moss_lab rollback` 恢复上一次成功应用及其对应数据快照。升级后新增的数据会另存到私有备份目录，不直接删除。失败或回退的版本不会被 `start` 自动重试。备份暂不自动清理；检查后可人工管理。

如果升级中断，先停止所有 MOSS 进程。在 PowerShell 执行 `py "$env:LOCALAPPDATA\MOSS-Lab\recover-install.py" --stopped`；自定义数据目录使用升级前打印的脚本地址。恢复脚本和经过校验的旧包放在 Python 包外，因此模块或 pip 安装记录受损后仍可恢复。请用原来安装时的同一个 Python；备份不完整、校验失败或 pip 仍在写入时会拒绝恢复。包正常时也可执行 `py -m moss_lab recover --stopped`。直接 `pip install --upgrade` 会保留独立数据目录，但不提供整套包回退，请用 `update` 升级。

程序依赖缓存和可丢弃的示例预览放在 `runtime-cache/`，不混入 `.dsh-local` 实验数据快照。Windows 解压应用时使用扩展路径，不修改系统的路径长度设置；对外的配置和版本路径仍保持普通格式。导入与备份会拒绝嵌套符号链接和 Windows 目录联接；先将所需数据整理成普通文件，再导入。

`check` 要求实验、预览、机器人控制和会话服务就绪，并核对认证响应中的本次启动标识及版本。一个普通网页响应不能使检查通过。安装检查不操作实体机器人；真机仍需现场核对设备与台面并由操作员确认。原生 Windows CI 对已安装网页执行真实模型调用、Flex/OT-2 本地仿真和安装升级恢复测试。

开发者先安装仓库依赖并构建，再运行 `node --import tsx/esm scripts/build-moss-wheel.mjs`。构建器必须运行在目标系统；公开 Windows wheel 使用 `py3-none-win_amd64`，macOS 包用于开发验证。安装包不得含真实 `.env`、实验记录或开发者的已安装环境。
