# Internal experiment storage

English | [中文](README.zh.md)

This internal Node module stores experiment snapshots and check results in an explicitly selected SQLite file. The local launcher mounts its Cordis services, authenticated preview route, and read-only device status route; device control is not connected.

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

The internal service also offers `createForSession(sessionId, input)`, `getForSession(sessionId, id, revision)`, `updateForSession(sessionId, input)`, and `getChecksForSession(sessionId, id, revision)`. The host must supply a trusted, non-empty session identity. Creation inserts that identity into the snapshot, rejects a conflicting supplied `sessionId`, and isolates idempotency keys per session; updates must include the same `sessionId`. Reads and updates reject ownerless initial snapshots, different owners, and revisions with a different `sessionId` with `SESSION_MISMATCH`. Update checks ownership and commits in one transaction. Opening a schema 1 database migrates it transactionally to schema 2 and adds an auxiliary creation-key table; existing global keys are separate and are not adopted as session keys.

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

Run the declaration and tool tests with `node --import tsx/esm --test internal/experiment/tests/workflow.test.mjs internal/experiment/tests/agent-tools.test.mjs`.

## Preview components

`buildPreview` requests portable documents from the pinned plugin through `protocol_artifacts` only after checking the session, revision, protocol hash, and latest analysis digest. MOSS verifies API/version/digests and copies only resulting HTML into its own private preview directory. It never imports plugin Python or rewrites viewer JavaScript. Animation and setup availability are independent; setup represents declared initial liquids, not inferred final contents.

`PreviewResources` rechecks the current owner and task before serving fixed `animation` / `setup` resources or manifest-listed download files. `runtime-plugin.mjs` calls only `simulate_protocol` and `protocol_artifacts` through the MCP SDK; the entire plugin process is confined to a private invocation directory by the DSH sandbox. The sandbox restricts writes, not reads or network access. Failed or interrupted MCP invocations retain their private files because child-process termination is uncertain; inspect them under the configured plugin data directory before cleanup. Plugin code and dependencies are external and version-locked; see [MOSS setup](../../MOSS-LAB.md).

A passed `protocol-analysis` check stores the full analysis bytes (`analysisBase64`) next to its SHA-256. `get_experiment` omits those bytes from its check results; they remain available internally for preview recovery. Published previews and per-session selection live only in process memory; when a session's status is polled after a restart and no preview is selected, the status route rebuilds the scene from the persisted analysis of the latest passed check for that session's newest experiment, verifies its digest, and reports `checking` until the rebuild finishes. Each process attempts recovery at most once per completed check; polling before a check passes does not consume that attempt. A stored check recorded before analysis persistence began cannot recover.

The authenticated `/api/robot-status` route reads `OPENTRONS_URL` at startup and queries only the robot's health and instruments endpoints on demand. It returns available model, health status, instruments and query time; an unconfigured, unreachable or partially responding robot is reported separately. This snapshot is not a device-readiness or safety assessment.

## Known limitations

- The local host plugin provides Agent tools for model-generated protocols. Plugin operations use the local-only MCP adapter. Preview selection is in memory; after a restart the status route rebuilds it from the persisted analysis (see above), and a rebuild re-runs scene generation only, not the analysis.
- Protocol and animation support depends on Opentrons and Flex3D. Comprehensive validation, report storage, device operations, and export are not provided. A stored `passed` result is only a caller-supplied record and must not authorize a device run.
- Late results are rejected and are not logged. Running checks are not resumed automatically after restart.
- Session-constrained methods are storage primitives, not authentication or complete authorization. The host must authenticate and authorize the session and keep unrestricted methods and check writers on trusted internal paths. There is no backup scheduler, external-disk monitoring, or data-directory configuration integration. File identity checks detect many loss and replacement cases but cannot guarantee detection of every filesystem or storage failure or remove all time-of-check races. SQLite and filesystem errors must be surfaced by the eventual host.
- The plugin loads from its source file. A Web profile with an overlay reached readiness without a reported plugin error; an application consumer and packaged deployment remain unverified.
