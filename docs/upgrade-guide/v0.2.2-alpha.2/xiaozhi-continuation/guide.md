---
kind: upgrade-guide
description: "Xiaozhi follow-ups continue the active experiment, and confirmation questions are surfaced and answered in the same session."
---

# Xiaozhi experiment continuity

English | [中文](guide.zh.md)

## Change

`moss_delegate` no longer creates a session for every message. The first call opens a workspace session; later calls continue it, including after a completed turn. Supplementary conditions, parameter changes, and answers to a confirmation remain in the same experiment. A running request accepts amendments with a higher `generation`; the latest requirement wins. `newTask=true` is reserved for an explicit new experiment. While the agent waits in `ask_user_question`, `moss_task_status` reports `awaitingConfirmation`, `question`, and one `speech` decision; the next `moss_delegate` cancels the blocked turn and submits the answer in the same session. Older receipts return `followJobId`; `userQuery=true` answers an explicit progress question without consuming the waiting budget.

## Migration

1. Update the Xiaozhi caller to speak only `speech.text` once when `speech.speak` is true and to remain silent otherwise.
2. When `awaitingConfirmation` is true, ask the user the `question`; send the answer with `moss_delegate` and `newTask=false`.
3. Set `newTask=true` only when the user explicitly starts a new experiment; ordinary amendments and confirmation answers keep it false.
4. When a status reply carries `followJobId`, query that job for the current result.
5. Restart MOSS with `node moss-start.mjs` so the bridge reconnects. Job receipts and the active session are in memory; a restart starts a new conversation on the next message.
6. Run `node --import tsx/esm --test internal/xiaozhi/bridge.test.mjs internal/xiaozhi/delegation.test.mjs`. Hardware tool selection and physical speech still require an operator test on the voice device.
