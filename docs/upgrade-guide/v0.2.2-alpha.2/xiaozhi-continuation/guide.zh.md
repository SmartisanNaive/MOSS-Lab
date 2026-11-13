---
kind: upgrade-guide
description: "小智的后续语音继续当前实验，确认问题会在同一会话中显示并得到回答。"
---

# 小智实验连续性

[English](guide.md) | 中文

## 变更

`moss_delegate` 不再为每条消息新建会话。首次调用打开工作区会话，后续调用继续该会话，包括在一轮完成后。补充条件、修改参数和对确认的回答都留在同一实验。运行中的请求接受带更高 `generation` 的改口，以最新要求为准。`newTask=true` 仅保留给明确的新实验。Agent 阻塞在 `ask_user_question` 时，`moss_task_status` 返回 `awaitingConfirmation`、`question` 和一次 `speech` 决策；下一次 `moss_delegate` 会取消被阻塞的轮次，并在同一会话中提交回答。旧任务回执返回 `followJobId`；`userQuery=true` 回答用户的明确进度询问，不消耗等待播报预算。

## 迁移

1. 更新小智调用方：仅在 `speech.speak` 为 true 时原样播报 `speech.text` 一次，否则保持静默。
2. `awaitingConfirmation=true` 时向用户提出 `question`；把回答用 `moss_delegate` 和 `newTask=false` 送回。
3. 只有用户明确开始新实验时才设 `newTask=true`；普通补充和确认回答保持 false。
4. 状态回复带 `followJobId` 时，改查该任务获取当前结果。
5. 用 `node moss-start.mjs` 重启 MOSS，使桥接重新连接。任务回执和当前会话保存在内存中；重启后的首条消息会新建会话。
6. 运行 `node --import tsx/esm --test internal/xiaozhi/bridge.test.mjs internal/xiaozhi/delegation.test.mjs`。硬件工具选择和实体播报仍需在语音设备上由操作员验证。
