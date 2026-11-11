---
kind: upgrade-guide
description: 小智任务状态调用方必须遵守 speech 决策，不再朗读任务结果。
---
# 小智任务状态播报决策

[English](guide.md) | 中文

## 变更

此前 `moss_task_status` 返回机器状态和 `result`，没有播报策略。现在还返回 `speech: { speak, text }`，语音调用方必须遵守该决策。每个任务在运行和超时状态合计允许三次等待回复，随后静默，完成时只返回一次固定短句。每次查询仍保留机器状态和原有完整 `result`。所有调用方的查询共享并消费播报机会；响应丢失后不重播，也没有硬件播放确认。

此前任务活跃时再次调用 `moss_delegate` 会被拒绝。现在会更新同一任务和会话，递增 `generation`，使此前结果失效，并引导 Agent 采用最新完整要求。原有超时和三次回复预算继续有效。被替代请求的完成结果不会成为当前查询结果。已执行中的工具和旧网页预览不会被回滚或移除。

## 迁移

1. 更新 `internal/xiaozhi/bridge.mjs` 提供的 `moss_task_status` 的调用方：仅在 `speech.speak` 为 true 时原样播报 `speech.text`，否则保持静默。不得朗读或概述 `result`，也不得追加等待提示。
2. 通过 `moss_delegate` 向活跃任务发送完整改口要求；不要把回复视为独立新任务。利用提交回复中的 `generation` 和 `currentGeneration` 避免显示被替代的确认。保留 `status`、`sessionId`、`generation` 和 `result` 供机器处理和网页核查。任务结果未知时，先查看网页会话，再决定是否重新委派。
3. 运行 `node --import tsx/esm --test internal/xiaozhi/bridge.test.mjs internal/xiaozhi/delegation.test.mjs`。确认重复等待查询转为静默，完成只返回一次一句话。实际 TTS 须由实体设备旁的操作员另行验证；本地测试不验证实体播放。
