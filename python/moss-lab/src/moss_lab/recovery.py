"""Standalone recovery retained outside site-packages before a pip replacement."""
from __future__ import annotations

import argparse
import contextlib
import runpy
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import sysconfig
import site
import tempfile
import uuid
import zipfile


def install_wheel(wheel: Path, home: Path):
    """Do not start recovery while an interrupted pip process is still writing."""
    transaction = json.loads((home / "package-update.json").read_text(encoding="utf-8"))
    child = subprocess.Popen([sys.executable, str(home / "recover-install.py"), "--home", str(home),
                              "--install-wheel", str(wheel), "--writer-token", transaction["writer"]])
    try:
        result = child.wait()
    except BaseException:
        child.terminate()
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=15)
        raise
    if result:
        raise subprocess.CalledProcessError(result, child.args)


@contextlib.contextmanager
def file_lock(path: Path):
    """Pip itself owns this lock; a dead coordinator cannot release a live writer."""
    with path.open("a+b") as stream:
        if path.stat().st_size == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def pip_writer(home: Path, wheel: Path, token: str):
    with file_lock(home / "pip-writer.lock"):
        journal = home / "package-update.json"
        if not journal.is_file() or json.loads(journal.read_text(encoding="utf-8")).get("writer") != token:
            raise RuntimeError("This pip transaction was already recovered; no package files were changed")
        sys.argv = ["pip", "install", "--no-deps", "--force-reinstall", str(wheel)]
        # The lock stays in the process executing pip, not its replaceable parent.
        runpy.run_module("pip", run_name="__main__")


def checked_path(home: Path, relative: str, directory: str) -> Path:
    root = (home / directory).resolve()
    value = (home / relative).resolve()
    if not value.is_relative_to(root) or value == root:
        raise RuntimeError("Invalid recovery path; data was not changed")
    return value


def regular_tree(root: Path):
    value = root.lstat()
    if root.is_symlink() or getattr(value, "st_file_attributes", 0) & 0x400:
        raise RuntimeError("Recovery backup contains linked data")
    if stat.S_ISDIR(value.st_mode):
        for child in root.iterdir():
            regular_tree(child)
    elif not stat.S_ISREG(value.st_mode):
        raise RuntimeError("Recovery backup contains a special file")


def verify_recovery_wheel(wheel: Path):
    """An empty or incomplete installed RECORD must never become a recovery package."""
    with zipfile.ZipFile(wheel) as archive:
        required = {"moss_lab/" + name + ".py" for name in
                    ["__init__", "__main__", "cli", "install", "process", "update", "recovery"]}
        required.update(["moss_lab/_payload/manifest.json", "moss_lab/_payload/application.zip"])
        names = set(archive.namelist())
        if not required.issubset(names):
            raise RuntimeError("Recovery wheel is incomplete; installed files were not changed")
        manifest = json.loads(archive.read("moss_lab/_payload/manifest.json"))
        metadata = "moss_lab-" + manifest["version"] + ".dist-info/"
        if manifest.get("manager_api") != 1 or not {metadata + n for n in ["WHEEL", "METADATA", "RECORD"]}.issubset(names):
            raise RuntimeError("Recovery wheel metadata is incomplete")
        checksum = hashlib.sha256()
        with archive.open("moss_lab/_payload/application.zip") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                checksum.update(block)
        if checksum.hexdigest() != manifest.get("sha256"):
            raise RuntimeError("Recovery application checksum mismatch")


def restore_package(wheel: Path, directory: Path):
    """Restore this dependency-free namespace even if pip's RECORD was removed."""
    verify_recovery_wheel(wheel)
    supported = {Path(sysconfig.get_path("purelib")).resolve(), Path(sysconfig.get_path("platlib")).resolve(),
                 Path(site.getusersitepackages()).resolve()}
    if directory.resolve() not in supported:
        raise RuntimeError("Recovery target is not this Python installation's package directory")
    staging = Path(tempfile.mkdtemp(prefix=".moss-repair-", dir=directory))
    old = staging / "old"
    new = staging / "new"
    old.mkdir()
    new.mkdir()
    installed = []
    moved = []
    try:
        with zipfile.ZipFile(wheel) as archive:
            for item in archive.infolist():
                parts = Path(item.filename).parts
                if (not parts or Path(item.filename).is_absolute() or any(p in {"..", "."} for p in parts) or ":" in item.filename or "\\" in item.filename
                        or not (parts[0] == "moss_lab" or (parts[0].startswith("moss_lab-") and parts[0].endswith(".dist-info")))):
                    raise RuntimeError("Recovery wheel contains files outside MOSS")
                if not item.is_dir():
                    destination = new.joinpath(*parts)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as incoming, destination.open("xb") as outgoing:
                        shutil.copyfileobj(incoming, outgoing)
        for existing in [directory / "moss_lab", *directory.glob("moss_lab-*.dist-info")]:
            if existing.exists():
                os.replace(existing, old / existing.name)
                moved.append(existing.name)
        for replacement in new.iterdir():
            os.replace(replacement, directory / replacement.name)
            installed.append(replacement.name)
    except BaseException:
        try:
            for name in installed:
                os.replace(directory / name, new / name)
            for name in moved:
                os.replace(old / name, directory / name)
        except BaseException as error:
            raise RuntimeError(f"Package repair interrupted; retained files: {staging}. Run recovery again") from error
        shutil.rmtree(staging)
        raise
    shutil.rmtree(staging)


def restore_home(home: Path):
    """The caller must hold operation.lock and establish that MOSS stopped."""
    journal = home / "package-update.json"
    transaction = json.loads(journal.read_text(encoding="utf-8"))
    if transaction.get("schema") != 1:
        raise RuntimeError("Unsupported package recovery journal")
    wheel = checked_path(home, transaction["wheel"], "packages")
    backup = checked_path(home, transaction["backup"], "backups")
    if not (backup / "complete.json").is_file():
        raise RuntimeError("Package recovery data snapshot is incomplete")
    regular_tree(backup)
    checksum = hashlib.sha256()
    with wheel.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    if checksum.hexdigest() != transaction["wheel_sha256"]:
        raise RuntimeError("Recovery wheel checksum mismatch; data was not changed")
    restore_package(wheel, Path(transaction["site_packages"]))
    retained = home / "backups" / ("retained-pip-" + uuid.uuid4().hex)
    retained.mkdir(mode=0o700)
    for name in [".env", ".dsh-local", "installation.json"]:
        destination = home / name
        if destination.exists() or destination.is_symlink():
            os.replace(destination, retained / name)
        source = backup / name
        if source.is_dir():
            shutil.copytree(source, destination)
        elif source.is_file():
            shutil.copy2(source, destination)
    (home / "upgrade.json").unlink(missing_ok=True)
    journal.unlink()
    print(f"Previous pip package and matching data restored. Newer data retained privately: {retained}")


def recover_home(home: Path):
    with file_lock(home / "pip-writer.lock"):
        restore_home(home)


def main():
    parser = argparse.ArgumentParser(description="Recover an interrupted MOSS pip upgrade")
    parser.add_argument("--home", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--stopped", action="store_true")
    parser.add_argument("--install-wheel", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--writer-token", help=argparse.SUPPRESS)
    args = parser.parse_args()
    home = args.home.resolve()
    if args.install_wheel is not None:
        pip_writer(home, args.install_wheel, args.writer_token)
        return
    if not args.stopped:
        parser.error("Stop all MOSS processes first, then add --stopped")
    with file_lock(home / "operation.lock"):
        recover_home(home)


if __name__ == "__main__":
    main()
