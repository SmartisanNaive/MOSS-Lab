"""Immutable application versions and recoverable, exclusive data upgrades."""
from __future__ import annotations

import contextlib
import hashlib
import http.cookiejar
import json
import os
import queue
import re
import shutil
import stat
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser
import zipfile
from pathlib import Path, PurePosixPath

from .process import ApplicationProcess, StopUncertain


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(chunk)
    return checksum.hexdigest()


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def manifest_id(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def require_regular_tree(root: Path) -> None:
    """Persistent data cannot alias unbacked-up files through links or junctions."""
    information = root.lstat()
    if root.is_symlink() or getattr(information, "st_file_attributes", 0) & 0x400:
        raise RuntimeError("Linked experiment data is not supported; original files were not changed")
    if stat.S_ISDIR(information.st_mode):
        for child in root.iterdir():
            require_regular_tree(child)
    elif not stat.S_ISREG(information.st_mode):
        raise RuntimeError("Experiment data must contain regular files and directories")


def atomic_json(path: Path, value) -> None:
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def exclusive(home: Path):
    """The OS releases the advisory lock even if an installer crashes."""
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = home / "operation.lock"
    with path.open("a+b") as stream:
        os.chmod(path, 0o600)
        stream.seek(0)
        if path.stat().st_size == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise RuntimeError("MOSS is running or another upgrade is active; stop it first") from error
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def extract(archive: Path, destination: Path) -> None:
    """Extract a bounded, regular-file application archive without path aliases."""
    seen = set()
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        if len(entries) > 100000 or sum(e.file_size for e in entries) > 3 * 1024**3:
            raise RuntimeError("MOSS archive exceeds its size limit")
        for entry in entries:
            path = PurePosixPath(entry.filename)
            mode = entry.external_attr >> 16
            identity = entry.filename.rstrip("/").casefold()
            if (entry.orig_filename != entry.filename or path.is_absolute() or not path.parts or ".." in path.parts
                    or "\\" in entry.filename or ":" in entry.filename
                    or identity in seen or stat.S_ISLNK(mode)
                    or (stat.S_IFMT(mode) not in {0, stat.S_IFREG, stat.S_IFDIR})):
                raise RuntimeError("Unsafe MOSS archive entry")
            seen.add(identity)
        for entry in entries:
            target = destination.joinpath(*PurePosixPath(entry.filename).parts)
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.open(entry) as incoming, target.open("xb") as outgoing:
                shutil.copyfileobj(incoming, outgoing)
            os.chmod(target, (entry.external_attr >> 16) & 0o777 or 0o644)


class Bundle:
    def __init__(self, directory: Path):
        self.directory = directory
        self.manifest = read_json(directory / "manifest.json")
        value = self.manifest
        if (value.get("schema") != 1 or value.get("manager_api") != 1
                or not re.fullmatch(r"\d+\.\d+\.\d+", value.get("version", ""))
                or not re.fullmatch(r"[a-f0-9]{64}", value.get("sha256", ""))
                or value.get("platform") != sys.platform):
            raise RuntimeError("Unsupported MOSS application manifest or platform")
        self.archive = directory / "application.zip"
        self.id = manifest_id(value)
        if digest(self.archive) != value["sha256"]:
            raise RuntimeError("MOSS application checksum mismatch")

    def install(self, home: Path) -> Path:
        releases = home / "releases"
        releases.mkdir(exist_ok=True, mode=0o700)
        destination = releases / self.id
        if destination.exists():
            if read_json(destination / "manifest.json") != self.manifest:
                raise RuntimeError("Installed MOSS version metadata differs")
            return destination
        staging = Path(tempfile.mkdtemp(prefix=".prepare-", dir=releases))
        try:
            extract(self.archive, staging)
            for key in ["node", "entry"]:
                path = PurePosixPath(self.manifest[key])
                if path.is_absolute() or ".." in path.parts or not staging.joinpath(*path.parts).is_file():
                    raise RuntimeError("MOSS application is incomplete")
            atomic_json(staging / "manifest.json", self.manifest)
            os.replace(staging, destination)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
        return destination


def default_home() -> Path:
    if os.environ.get("MOSS_HOME"):
        return Path(os.environ["MOSS_HOME"]).expanduser().resolve()
    root = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share"))
    return root / "MOSS-Lab"


class Manager:
    """A home owns its version selection, backup journal and application process."""

    def __init__(self, home: Path, bundle: Bundle):
        self.home, self.bundle = home.resolve(), bundle
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_path = self.home / "installation.json"
        self.journal_path = self.home / "upgrade.json"

    def state(self):
        value = read_json(self.state_path) if self.state_path.exists() else {"schema": 1, "current": None, "previous": None, "blocked": None}
        if value.get("schema") != 1:
            raise RuntimeError("Unknown installation data version")
        for name in ["current", "blocked"]:
            if value.get(name) is not None and not re.fullmatch(r"[a-f0-9]{64}", value[name]):
                raise RuntimeError("Invalid installation version reference")
        return value

    def snapshot(self) -> Path:
        backups = self.home / "backups"
        backups.mkdir(exist_ok=True, mode=0o700)
        destination = Path(tempfile.mkdtemp(prefix="snapshot-", dir=backups))
        for name in [".env", ".dsh-local", "installation.json"]:
            source = self.home / name
            if source.exists() or source.is_symlink():
                require_regular_tree(source)
            if source.is_dir():
                shutil.copytree(source, destination / name, symlinks=True)
            elif source.exists():
                shutil.copy2(source, destination / name)
        atomic_json(destination / "complete.json", {"schema": 1})
        return destination

    def restore(self, snapshot: Path) -> Path:
        snapshot = snapshot.resolve()
        if not snapshot.is_relative_to((self.home / "backups").resolve()) or not (snapshot / "complete.json").is_file():
            raise RuntimeError("Backup is incomplete or outside this installation")
        require_regular_tree(snapshot)
        retained = self.home / "backups" / ("retained-" + uuid.uuid4().hex)
        retained.mkdir(mode=0o700)
        for name in [".env", ".dsh-local", "installation.json"]:
            target = self.home / name
            if target.exists() or target.is_symlink():
                os.replace(target, retained / name)
            source = snapshot / name
            if source.is_dir():
                shutil.copytree(source, target, symlinks=True)
            elif source.is_file():
                shutil.copy2(source, target)
        return retained

    def recover(self, *, stopped: bool) -> None:
        if (self.home / "package-update.json").exists():
            if not stopped:
                raise RuntimeError(f'pip 升级未完成。先停止 MOSS，再运行：py "{self.home / "recover-install.py"}" --stopped')
            from .recovery import recover_home
            recover_home(self.home)
        importing = self.home / "import.json"
        if importing.exists():
            if not stopped:
                raise RuntimeError("A legacy import was interrupted; run recover --stopped before starting MOSS")
            self.finish_import()
        if not self.journal_path.exists():
            return
        if not stopped:
            raise RuntimeError("An upgrade was interrupted. Confirm MOSS is stopped, then run: py -m moss_lab recover --stopped")
        journal = read_json(self.journal_path)
        if (journal.get("schema") != 1 or Path(journal.get("backup", "")).name != journal.get("backup")
                or not re.fullmatch(r"[a-f0-9]{64}", journal.get("candidate", ""))):
            raise RuntimeError("Invalid interrupted-upgrade journal; data was not changed")
        self.restore(self.home / "backups" / journal["backup"])
        state = self.state()
        state["blocked"] = journal["candidate"]
        atomic_json(self.state_path, state)
        self.journal_path.unlink()

    def import_legacy(self, root: Path, *, stopped: bool) -> None:
        if not stopped:
            raise RuntimeError("Stop the old MOSS service and add --stopped")
        if (self.home / ".dsh-local").exists() or (self.home / ".env").exists() or self.state_path.exists():
            raise RuntimeError("This MOSS home already has data; existing data was not overwritten")
        root = root.resolve()
        if root == self.home or not (root / ".dsh-local").is_dir() or not (root / ".env").is_file():
            raise RuntimeError("Select the old MOSS directory containing .env and .dsh-local")
        if (root / ".env").is_symlink() or (root / ".dsh-local").is_symlink():
            raise RuntimeError("Legacy data roots must not be symbolic links")
        require_regular_tree(root / ".env")
        require_regular_tree(root / ".dsh-local")
        staging = Path(tempfile.mkdtemp(prefix=".import-", dir=self.home))
        try:
            shutil.copy2(root / ".env", staging / ".env")
            os.chmod(staging / ".env", 0o600)
            shutil.copytree(root / ".dsh-local", staging / ".dsh-local", symlinks=True)
            atomic_json(self.home / "import.json", {"schema": 1, "staging": staging.name})
            self.finish_import()
        finally:
            if staging.exists() and not (self.home / "import.json").exists():
                shutil.rmtree(staging)

    def finish_import(self):
        journal = self.home / "import.json"
        value = read_json(journal)
        name = value.get("staging", "")
        if value.get("schema") != 1 or not name.startswith(".import-") or Path(name).name != name:
            raise RuntimeError("Invalid legacy-import journal; existing data was not changed")
        staging = self.home / name
        if staging.is_symlink():
            raise RuntimeError("Invalid legacy-import staging directory")
        for name in [".dsh-local", ".env"]:
            source, target = staging / name, self.home / name
            if source.exists() and not target.exists():
                os.replace(source, target)
            elif source.exists() or not target.exists():
                raise RuntimeError("Legacy import requires recovery; neither data generation was overwritten")
        journal.unlink()
        shutil.rmtree(staging)

    def release(self, identity: str) -> tuple[Path, dict]:
        if not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise RuntimeError("Invalid release identity")
        directory = self.home / "releases" / identity
        value = read_json(directory / "manifest.json")
        if manifest_id(value) != identity or value["manager_api"] != 1:
            raise RuntimeError("MOSS release identity mismatch")
        return directory, value

    def run_release(self, identity: str, *, port: int, verify: bool, no_open: bool, timeout: float) -> None:
        directory, manifest = self.release(identity)
        if not (self.home / ".env").is_file():
            raise RuntimeError("Model configuration is missing; run: py -m moss_lab config")
        env = {key: value for key, value in os.environ.items()
               if not any(word in key.upper() for word in ["KEY", "TOKEN", "SECRET", "PASSWORD"])
               and key not in {"NODE_OPTIONS", "MOSS_PLUGIN_ROOT", "LABSCRIPTAI_OT_ROOT", "DSH_HOME"}}
        env.update(MOSS_HOME=str(self.home), MOSS_PACKAGED="1", DSH_TELEMETRY_DISABLED="1",
                   MOSS_PLUGIN_CACHE=str(self.home / "runtime-cache"))
        nonce = uuid.uuid4().hex
        env.update(MOSS_RUN_NONCE=nonce, MOSS_RELEASE_ID=identity)
        env["PATH"] = os.pathsep.join([str((directory / manifest["node"]).parent), str(directory / "tools"), env.get("PATH", "")])
        command = [str(directory / manifest["node"]), str(directory / manifest["entry"]),
                   "--no-open", "--port", str(port)]
        logs = self.home / "logs"
        logs.mkdir(exist_ok=True, mode=0o700)
        log_path = logs / ("start-" + uuid.uuid4().hex + ".log")
        messages = queue.Queue()
        print("正在准备 OT 依赖并启动网页；首次启动需要联网下载。", flush=True)
        with log_path.open("x", encoding="utf-8") as log:
            os.chmod(log_path, 0o600)

            def read_output():
                for line in application.child.stdout:
                    log.write(line)
                    log.flush()
                    messages.put(line)
                messages.put(None)

            reader = None
            application = ApplicationProcess(command, cwd=directory, env=env)
            try:
                reader = threading.Thread(target=read_output, daemon=True)
                reader.start()
                deadline = time.monotonic() + timeout
                progress = time.monotonic() + 20
                url = None
                while time.monotonic() < deadline:
                    try:
                        line = messages.get(timeout=0.2)
                    except queue.Empty:
                        if time.monotonic() >= progress:
                            print("仍在准备依赖或启动网页，请稍候。", flush=True)
                            progress = time.monotonic() + 20
                        continue
                    if line is None:
                        raise RuntimeError(f"MOSS exited before readiness; private log: {log_path}")
                    if "failed to import:" in line:
                        raise RuntimeError(f"MOSS plugin loading failed; private log: {log_path}")
                    match = re.search(r"dsh web: (http://[^\s]+)", line)
                    if match:
                        parsed = urllib.parse.urlsplit(match[1])
                        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
                            raise RuntimeError("MOSS readiness URL must use loopback")
                        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                        with opener.open(match[1], timeout=10) as response:
                            if response.status != 200 or b"<html" not in response.read(1024 * 1024).lower():
                                raise RuntimeError("MOSS frontend readiness check failed")
                        readiness = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "/api/moss-install-ready", "", ""))
                        with opener.open(readiness, timeout=10) as response:
                            actual = json.loads(response.read(16384))
                        if actual != {"ready": True, "nonce": nonce, "identity": identity} or application.child.poll() is not None:
                            raise RuntimeError("MOSS readiness identity does not belong to this running application")
                        url = match[1]
                        break
                if url is None:
                    raise RuntimeError(f"MOSS startup timed out; private log: {log_path}")
                if verify:
                    return
                print(f"MOSS {manifest['version']} ready. {url}", flush=True)
                if not no_open:
                    webbrowser.open(url)
                application.child.wait()
                if application.child.returncode:
                    raise RuntimeError(f"MOSS stopped unexpectedly; private log: {log_path}")
            finally:
                try:
                    application.stop()
                except BaseException as error:
                    raise StopUncertain("Process-tree shutdown failed; the backup was retained without restoring data") from error
                if reader is not None and reader.ident is not None:
                    reader.join(timeout=15)
                    if reader.is_alive():
                        raise StopUncertain("Application output has not closed; data recovery was not attempted")
                application.child.stdout.close()

    def activate(self, bundle: Bundle, *, port: int, timeout: float) -> str:
        identity = bundle.id
        state = self.state()
        bundle.install(self.home)
        if state["current"] == identity:
            return identity
        if state.get("blocked") == identity:
            if state["current"]:
                return state["current"]
            raise RuntimeError("This application failed its startup check; use a tested release")
        backup = self.snapshot()
        atomic_json(self.journal_path, {"schema": 1, "backup": backup.name, "candidate": identity})
        try:
            self.run_release(identity, port=port, verify=True, no_open=True, timeout=timeout)
        except StopUncertain:
            raise
        except BaseException:
            # run_release returns/raises only after its owned process tree stops.
            self.restore(backup)
            state["blocked"] = identity if state["current"] else None
            atomic_json(self.state_path, state)
            self.journal_path.unlink()
            raise
        state.update(current=identity, previous={"release": state["current"], "backup": backup.name} if state["current"] else None, blocked=None)
        atomic_json(self.state_path, state)
        self.journal_path.unlink()
        return identity

    def start(self, *, port=8765, verify=False, no_open=False, timeout=1800):
        self.recover(stopped=False)
        if not (self.home / ".env").is_file():
            raise RuntimeError("请先配置模型：py -m moss_lab config")
        try:
            identity = self.activate(self.bundle, port=port, timeout=timeout)
        except Exception:
            if self.journal_path.exists():
                raise
            previous = self.state()["current"]
            if not previous:
                raise
            print("New version failed its startup check; old application and data were restored.", flush=True)
            identity = previous
        self.run_release(identity, port=port, verify=verify, no_open=no_open, timeout=timeout)

    def rollback(self):
        self.recover(stopped=False)
        state = self.state()
        previous = state.get("previous")
        if not previous:
            raise RuntimeError("No earlier successful application version is available")
        atomic_json(self.journal_path, {"schema": 1, "backup": previous["backup"], "candidate": state["current"]})
        retained = self.restore(self.home / "backups" / previous["backup"])
        restored = self.state()
        restored.update(current=previous["release"], previous=None, blocked=state["current"])
        atomic_json(self.state_path, restored)
        self.journal_path.unlink()
        print(f"Previous application/data restored. Newer data retained privately in: {retained}")
