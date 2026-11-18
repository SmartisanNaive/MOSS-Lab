# MOSS Windows distribution

English | [中文](README.zh.md)

The wheel contains the MOSS web workbench, its experiment and Xiaozhi plugins, the production JavaScript dependency closure, a checksum-pinned Node distribution including npm, and uv. Python 3.10+ is the only preinstalled interpreter required. OT dependencies are prepared on first start using the included version lock.

Run `py -m moss_lab config` once, then `py -m moss_lab start`. Existing installations can copy `.env` and `.dsh-local` with `py -m moss_lab import "C:\path\to\MOSS-Lab" --stopped` after stopping the old service. Import refuses to overwrite an existing managed home and leaves the source directory unchanged.

Configuration and experiment data live in `%LOCALAPPDATA%\MOSS-Lab`, independently of the Python installation. `MOSS_HOME` or `--home` selects a different private directory. Application versions are extracted into immutable, manifest-digest-named release directories. A pip upgrade does not replace the files of a running application.

Pip executes while owning a separate writer lock, so standalone recovery refuses a still-running pip writer even if its coordinator was terminated. Stop MOSS before running `py -m moss_lab update`. The updater selects a stable `moss-v*` GitHub release, verifies its wheel checksum, retains the installed wheel, installs the new package and checks application startup. An activation snapshots configuration and all experiment data before starting a different version. Failed startup restores that snapshot after the owned processes exit. An uncertain shutdown retains the journal and backup instead of restoring data over a possible live writer. `py -m moss_lab recover --stopped` resumes recovery after the operator confirms that all MOSS processes stopped.

`py -m moss_lab rollback` restores the preceding successful application and its matching data snapshot. Data created after that upgrade are retained in a separate private backup. A failed or rolled-back version is not automatically retried by `start`.

Build with `node --import tsx/esm scripts/build-moss-wheel.mjs` after installing workspace dependencies and running the repository build. The builder runs on the target platform. The public Windows package is a `py3-none-win_amd64` wheel; the macOS build exists for development verification. Never include a real `.env`, experiment data or developer installation in a wheel.

The plugin dependency cache lives in `runtime-cache/`, outside `.dsh-local` data snapshots. Import and backups refuse nested symbolic links or Windows junctions; resolve linked data into regular files before importing. No import changes the source. Backups are retained for manual inspection and are not automatically pruned.

Before replacing pip files, `update` saves a verified recovery wheel, a data snapshot, and `recover-install.py` outside the Python package. If pip is interrupted or the module stops importing, stop all MOSS processes and run `py "%LOCALAPPDATA%\MOSS-Lab\recover-install.py" --stopped` in Command Prompt, or `py "$env:LOCALAPPDATA\MOSS-Lab\recover-install.py" --stopped` in PowerShell. A custom home uses its own script path printed before the upgrade. Recovery works even when pip's installation record is missing. The cached package and snapshot must remain intact; recovery refuses incomplete or checksum-invalid inputs. Use the same Python interpreter that performed the installation. Direct `pip install --upgrade` preserves the separate data home but does not provide the transactional package rollback; use `py -m moss_lab update` for upgrades.

`check` requires an authenticated readiness response identifying the current release and launch, after the experiment, preview, robot-control and session services are available. A generic HTTP page cannot activate a version. Startup verification does not operate a robot or prove a particular physical deck is ready. Native Windows CI checks installed-browser use, real model requests and pinned Flex/OT-2 simulations; on-site physical operation remains a separate operator test.
