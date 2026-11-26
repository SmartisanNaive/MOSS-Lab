# Internal experiment storage

English | [中文](README.zh.md)

This module stores experiment snapshots and check results in SQLite. The local launcher mounts authenticated preview and device status routes and offers opt-in Flex and OT-2 control through LabscriptAI OT.

To opt in, add a row to a local profile patch or `--patch` overlay, replacing both paths with absolute paths on the host:

```yaml
- insert:
    - id: experiment-store
      name: file:///absolute/path/to/internal/experiment/plugin.mjs
      config:
        path: /absolute/path/to/experiments.sqlite
        create: false
```

Set `create: true` only to exclusively create a new database; change it to `false` before the next startup. The `experimentStore` service exposes `create`, `get`, `update`, `startCheck`, `finishCheck`, `getChecks`, and `backup` with the store's arguments and results described below. Inject it into a host plugin to use it. Unloading withdraws the service, waits for in-flight backups, then closes the database. Calls through retained service references fail with `STORE_CLOSED` after service withdrawal. The plugin does not mount itself in any shipped profile.

Construct `ExperimentStore` with an absolute `path` and an explicit `create` boolean. `create: true` exclusively creates a new database file in an existing directory; `create: false` opens an existing database and rejects an absent file or unsupported schema. The constructor runs SQLite `integrity_check` before accepting the database. Close each instance with `close()`.

`create({ creationKey, snapshot })` records revision 1. Repeating the key with the same JSON snapshot returns that initial revision; a different snapshot returns `IDEMPOTENCY_CONFLICT`. A snapshot is a complete JSON object and must contain `protocol` as a string or null. It can contain requirements, conversation details, parameters, device configuration, and artifact references. Protocol hashes are SHA-256 of the UTF-8 protocol string. JSON object key order does not affect idempotency.

`update({ id, expectedRevision, snapshot })` commits a complete new snapshot or throws `REVISION_CONFLICT` with the current revision. When the initial snapshot has a non-empty string `sessionId`, every update must preserve it. `get(id, revision)` reads a historical revision; omit the revision to read the latest. Revision rows cannot be updated or deleted through SQLite. All changes in requirements, parameters, protocol, and device configuration require a new revision, so checks never carry forward.

The internal service also offers `createForSession(sessionId, input)`, `getForSession(sessionId, id, revision)`, `updateForSession(sessionId, input)`, and `getChecksForSession(sessionId, id, revision)`. The host must supply a trusted, non-empty session identity. Creation inserts that identity into the snapshot, rejects a conflicting supplied `sessionId`, and isolates idempotency keys per session; updates must include the same `sessionId`. Reads and updates reject ownerless initial snapshots, different owners, and revisions with a different `sessionId` with `SESSION_MISMATCH`. Update checks ownership and commits in one transaction. Opening a schema 1 or 2 database migrates it transactionally to schema 3 and adds session-scoped robot run receipts. Schema 1 also gains an auxiliary creation-key table; existing global keys are separate and are not adopted as session keys.

`startCheck({ id, revision, protocolHash, name })` returns a task identifier and marks the named check running. `finishCheck` requires the returned fields, a terminal `status` of `passed`, `failed`, `error`, or `blocked`, and a JSON `result`. Only the latest task for the current revision and its exact protocol hash may finish. Old or duplicate results fail with `STALE_TASK`; an incorrect hash fails with `PROTOCOL_MISMATCH`. `getChecks(id, revision)` reads attempts in creation order. Starting another check of the same name marks any running attempt as `superseded` and retains earlier results.

`await store.backup({ directory, retain })` creates an online SQLite snapshot in an explicitly selected existing absolute directory, verifies it with `integrity_check`, and returns the verified backup path. `retain` is a required positive integer; after publishing, the operation keeps the new backup and the newest matching backups for the same canonical source path, up to that count. It never prunes other source paths, nonmatching files, symlinks, or the source file. Backups use a private staging directory and owner-only file permissions. The backup directory should be trusted and protected from other writers; filesystem identity checks cannot eliminate concurrent replacement races. Restore by opening a selected backup with `create: false` or copying it to a separate storage location while it is closed.

Backups are caller-triggered; no scheduler is started. Await each backup before closing the store; `close()` throws `BACKUP_IN_PROGRESS` while any backup is running. A per-source lock in the destination prevents overlapping backups and retention from separate instances; an overlap fails with `EEXIST`. If a process crashes, inspect and remove its stale `experiment-backup-<source hash>-lock` directory before retrying. A failure before publication does not prune backups; a failure after publication or during retention can leave a verified backup and partially applied retention. Cleanup failures can leave staging or lock directories and are reported to the caller. The caller owns retries, scheduling, error reporting, and stale-file cleanup.

Expected failures expose `ExperimentError.code` and `details`. SQLite and operating system failures can also propagate. Transactions roll back on errors before commit; if rollback fails, close the instance and inspect the database before further work. The caller owns error reporting and recovery. Every operation checks the configured file and parent directory identity; an absent or replaced path returns `STORAGE_UNAVAILABLE` and disables this instance even if the path returns. Reopen after resolving storage problems, which reruns the integrity check.

Run the focused tests with Node 24.9 or later from the `LabScriptAI-OT-V3` application directory:

```sh
node --import tsx/esm --test internal/experiment/tests/experiment.test.mjs internal/experiment/tests/plugin.test.mjs
```

## Initial liquid declarations

When `createWorkflow.create` or `update` omits `protocol`, the transfer template requires exactly `{ source: "A1", destinations: ["A1", "A2"], volumeUl: 50, initialVolumeUl: 1000 }`. `initialVolumeUl` is the caller-declared starting source volume in µL, independently supplied rather than inferred from the transfer total. It must be finite, cover `volumeUl * destinations.length`, and not exceed the reservoir well capacity of 15000 µL; invalid or missing values return `INVALID_INPUT`. The generated protocol calls `define_liquid` and the selected source well's `load_liquid` before transfers. This arithmetic check does not establish sufficient dead volume or physical readiness; the caller must account for applicable dead volume and confirm actual loading.

Agent tools require complete Python source. Their optional `parameters.initialVolumeUl` records a known single-source starting volume that must match the protocol declaration; omission means unknown and must be stated as unknown in `parameters.assumptions`. Custom protocols must declare known initial liquids with `define_liquid` / `load_liquid`; an unknown volume must not be invented from transfer totals. `example_transfer.py` explicitly assumes 1000 µL of water for its 200 µL transfer total; this is an example assumption, not a measured loading.

Protocol parameter descriptions include common Flex and OT-2 simulation load names, their trash API differences, and explicit zero-volume declarations for confirmed empty wells. These tool descriptions remain visible when the experiment persona replaces the complete system prompt. After an analysis error, the model is directed to revise the same experiment and analyze its new revision, then stop and explain repeated or uncertain errors.

Run the declaration and tool tests with `node --import tsx/esm --test internal/experiment/tests/workflow.test.mjs internal/experiment/tests/agent-tools.test.mjs`.

## Preview components

`buildPreview` requests portable documents from the pinned plugin through `protocol_artifacts` only after checking the session, revision, protocol hash, and latest analysis digest. MOSS verifies API/version/digests and copies only resulting HTML into its own private preview directory. It never imports plugin Python or rewrites viewer JavaScript. Animation and setup availability are independent; setup represents declared initial liquids, not inferred final contents. Rejected manifests retain bounded plugin and document failure reasons in `ExperimentError.details`; rejected output is never published. Windows confined calls request inherited capability ACLs only under their private invocation directory.

`PreviewResources` rechecks the owner and current task before serving `animation`, `setup`, or manifest-listed downloads. The version-locked MCP adapter confines each plugin process's writes to a private directory. Interrupted invocations retain that directory because child-process termination is uncertain. See [MOSS setup](../../MOSS-LAB.md).

The experiment preset registers the pinned server's published MCP schemas and loads the plugin's experiment instructions. The adapter binds requests to the executing conversation and configured robot, keeps the plugin's conversation data across calls, and publishes returned camera images through the shared MCP attachment adapter. Physical actions outside an approved run require a device confirmation. LabscriptAI `runtime_watch` can send recovery actions even when passed `self_fix_mode=observe`, so the preset reserves that tool for an active run with recorded recovery approval. Read-only run status uses history or the recovery monitor with execution disabled.

A passed `protocol-analysis` check stores the full analysis bytes (`analysisBase64`) next to its SHA-256. `get_experiment` omits those bytes from its check results; they remain available internally for preview recovery. Published previews and per-session selection live only in process memory; when a session's status is polled after a restart and no preview is selected, the status route rebuilds the scene from the persisted analysis of the latest passed check for that session's newest experiment, verifies its digest, and reports `checking` until the rebuild finishes. Each process attempts recovery at most once per completed check; polling before a check passes does not consume that attempt. A stored check recorded before analysis persistence began cannot recover.

The authenticated `/api/robot-status` route reads `OPENTRONS_URL` at startup and queries only the robot's health and instruments endpoints on demand. It returns available model, health status, instruments and query time; an unconfigured, unreachable or partially responding robot is reported separately. This snapshot is not a device-readiness or safety assessment.

## Known limitations

- The local host plugin provides Agent tools for model-generated protocols. Plugin operations use the local-only MCP adapter. Preview selection is in memory; after a restart the status route rebuilds it from the persisted analysis (see above), and a rebuild re-runs scene generation only, not the analysis.
- Protocol and animation support depends on Opentrons and Flex3D. A stored analysis pass is one prerequisite for live operation, which also requires device checks and operator approval.
- Late results are rejected and are not logged. Running checks are not resumed automatically after restart.
- Session-constrained methods are storage primitives, not authentication or complete authorization. The host must authenticate and authorize the session and keep unrestricted methods and check writers on trusted internal paths. There is no backup scheduler, external-disk monitoring, or data-directory configuration integration. File identity checks detect many loss and replacement cases but cannot guarantee detection of every filesystem or storage failure or remove all time-of-check races. SQLite and filesystem errors must be surfaced by the eventual host.
- Packaged launches expose an authenticated `/api/moss-install-ready` response containing the installer launch nonce and release identity after required MOSS services activate. Source launches leave this route disabled. Installation and cache/data locations are documented in the [Windows distribution](../../python/moss-lab/README.md).
