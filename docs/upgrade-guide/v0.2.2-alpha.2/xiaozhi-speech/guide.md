---
kind: upgrade-guide
description: Xiaozhi task-status consumers must follow speech decisions instead of reading task results aloud.
---
# Xiaozhi task-status speech decisions

English | [中文](guide.zh.md)

## Change

Previously, `moss_task_status` returned machine status and `result` without a speech policy. It now also returns `speech: { speak, text }`, and voice consumers must obey that decision. Each job allows three waiting replies across running and timeout states, then silence, and one fixed completion sentence. Machine status and the existing complete `result` remain available on every query. Queries consume speech decisions across all callers; lost responses are not replayed and hardware playback is not acknowledged.

Previously, another `moss_delegate` during an active task was rejected. It now revises that same job and session, increments `generation`, invalidates the previous result, and steers the agent toward the latest complete requirements. The original timeout and three-reply budget remain in force. Superseded request completions cannot become the current query result. Already executing tools and previous web previews are not rolled back or removed.

## Migration

1. Update the consumer of `moss_task_status` exposed by `internal/xiaozhi/bridge.mjs`: speak exactly `speech.text` only when `speech.speak` is true; otherwise stay silent. Do not read or summarize `result` or add waiting reminders.
2. Send complete revised requirements through `moss_delegate` for active tasks; do not interpret its reply as a separate new task. Use `generation` and `currentGeneration` in submit replies to avoid displaying superseded acknowledgements. Keep `status`, `sessionId`, `generation`, and `result` for machine processing and web inspection. Inspect the web session before resubmitting tasks whose outcome is unknown.
3. Run `node --import tsx/esm --test internal/xiaozhi/bridge.test.mjs internal/xiaozhi/delegation.test.mjs`. Confirm repeated waiting queries become silent and completion gives one sentence once. An operator beside the physical device must verify actual TTS separately; local tests do not verify it.
