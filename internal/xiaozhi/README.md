# Xiaozhi MCP bridge

English | [中文](README.zh.md)

This internal Cordis plugin is enabled by the local launch configuration. It reads `XIAOZHI_WSS_URL` from the project root `.env`, opens one outbound WSS connection, and never logs the address or credential. Only `wss:` is accepted; the connection does not reconnect after closing, and unloading the plugin closes it.

The bridge exchanges MCP JSON-RPC over WebSocket text messages. A connected endpoint has been observed sending `initialize`, `notifications/initialized`, and `tools/list`, and receives the tool list. Voice calls from the hardware and disconnect recovery are not yet verified. There are no proactive notifications or voice announcements.

The plugin injects `experimentStore`, `sessionController`, and `workspaceRegistry`. `sessionId` selects the initial delegated conversation and the session experiment queries read. The launch configuration leaves it null, so the first delegation creates a conversation and later experiment queries read that current conversation; Xiaozhi still cannot choose a session. A trusted deployer may bind one explicitly allowed session:

```yaml
- insert:
    - id: xiaozhi-readonly
      name: file:///absolute/path/to/internal/xiaozhi/plugin.mjs
      config:
        sessionId: REPLACE_WITH_AUTHORIZED_SESSION_ID
```

`sessionId` must be chosen by a trusted deployer and correspond to the Xiaozhi-side user and the web session that user may see. Stored session checks are not authentication; there is no mechanism to bind or verify a Xiaozhi user identity, so this is not suitable for shared or multi-user deployment. The address is an access credential and must be held only by the trusted deployer. One plugin instance creates one connection; the deployer avoids loading duplicate instances.

The tools are `moss_status`, `moss_experiment_status`, `moss_delegate`, and `moss_task_status`. `moss_experiment_status` requires an experiment id and reads only the current revision and the latest twenty check statuses of that session; it never returns protocols, conversation content, or check results. Check records are stored data, not proof of device readiness or run safety. `moss_delegate(message, newTask=false)` submits up to 8000 bytes to the local web agent. The first call creates a workspace session titled 小智委派实验 with a timestamp; later calls default to that same session, so supplements, parameter changes, and answers to a confirmation continue the current experiment. While a request is running or timed out, another delegate sends the complete latest requirement into the same job and session with a higher generation and steering, so the newest requirement wins; an older answer cannot complete the revised job. When the agent is blocked in `ask_user_question`, the next delegate cancels that blocked turn and submits the message as the answer in the same session. `newTask=true` is only for an explicit new experiment: it creates another session, stops tracking the previous running job, and cancels its turn. While the agent is awaiting confirmation, a `newTask` flag without explicit new-experiment wording is treated as the answer and continues the same session. Up to 100 job receipts are retained in memory. `moss_task_status` reports `running`, `completed`, `error`, or `timeout` by job id, its generation, the full result (at most 4000 characters), `awaitingConfirmation`, the pending `question`, `followJobId`, and `speech: { speak, text, reason }`. Voice callers speak only `speech.text` once when `speak` is true, stay silent otherwise, and never read or summarize `result`. A running job emits at most three waiting replies; a pending or final confirmation question is emitted once; a completed job without a question gets one short completion line. An explicit progress question (`userQuery=true`) gets one short status reply without consuming the waiting budget. When a later follow-up continues the conversation, an older receipt returns `followJobId` and stays silent; query that id for the current result. `completed` only means the agent replied; `awaitingConfirmation=true` means it is waiting for the user, and the next `moss_delegate` continues the same conversation. `timeout` means the five-minute wait elapsed; the job remains tracked. A prompt submission error can leave admission uncertain; the returned job remains active for tracking, and the operator should inspect its web session. Closing the bridge stops observation but does not stop the web task. Job receipts and the current session identity are in memory and do not survive a restart; after a restart the first message creates a new session.

A delegated message runs with the web agent's full local authority in the delegated workspace session; Xiaozhi supplies no verified user identity, so delegation is limited to the same single trusted operator that runs the web app. The plugin exposes no real-device control.

Local tests build no external connection; run them from the `LabScriptAI-OT-V3` application directory:

```sh
node --import tsx/esm --test internal/xiaozhi/bridge.test.mjs internal/xiaozhi/delegation.test.mjs
```

Tool calls from the Xiaozhi hardware, session identity binding, and reconnection behavior still need verification; proactive announcements would require confirming a platform notification interface and implementing it separately.
