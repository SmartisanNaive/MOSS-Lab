---
description: "Open the experiment animation entry in the right sidebar and see its current availability."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-experiment

English | [中文](README.zh.md)

## Summary

The current session opens **Experiment animation** automatically when a checked preview becomes available and starts playback. Open it from the right sidebar guide or select **View demo** to explore clearly marked demo data.

## Table of Contents

- [Implementation](#implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="implementation"></a>
## Implementation

The client watches the current session's same-origin preview status every one second, opens each new checked task once, and checks again when the user selects **Check again**. Demo mode uses `/api/experiment-demo` and the fixed session `demo`; real experiments use `/api/experiment-preview`. Both fetch bounded resources for the selected revision and task and render them in a sandboxed frame after rechecking the status. **Check robot status** makes one separate read-only request and displays the available device information and query time.

<a id="model-experience"></a>
## Voice workbench

The local Xiaozhi bridge selects the conversation and opens the experiment panel on first opening, essential-condition questions and current-preview completion. Ordinary amendments and repeated polls preserve the user’s selection. During amendments the old animation is hidden; only the exact current checked preview is displayed, even if the Agent reply is still running. Missing conditions appear directly in the panel. The authenticated bridge endpoint must be mounted by the local MOSS launch configuration.

Once the current checked preview is playing, completion of the Agent reply does not reload its player. A failed voice request shows one error with the next action. If the same request already published a current checked preview, it remains visible when the final reply is stopped; unavailable or mismatched previews stay hidden. Demo playback is independent of voice-task state and keeps its explicit demo label.

## Model Experience

None, as this package only displays a sidebar entry and registers nothing model-facing.

#### KV Cache effect

None; the page assembles no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Experiment integration.** Playback requires an available checked preview; device operation and Xiaozhi are not connected to this page.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
