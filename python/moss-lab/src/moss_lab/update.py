"""Download a checksum-verified GitHub wheel and retain the installed wheel for recovery."""
from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from .install import Bundle, Manager, digest
from .recovery import recover_home, install_wheel as pip_install

REPOSITORY = "SmartisanNaive/MOSS-Lab"


def download(url: str, destination: Path, limit: int) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "MOSS-Lab-installer", "Accept": "application/octet-stream"})
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("xb") as target:
        os.chmod(destination, 0o600)
        size = 0
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise RuntimeError("MOSS download exceeds its size limit")
            target.write(chunk)


def installed_wheel(destination: Path) -> Path:
    """Reconstruct the installed, dependency-free wheel before pip can replace it."""
    distribution = importlib.metadata.distribution("moss-lab")
    version = distribution.version
    wheel_metadata = distribution.read_text("WHEEL")
    tag = next(line.removeprefix("Tag: ") for line in wheel_metadata.splitlines() if line.startswith("Tag: "))
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = destination / f"moss_lab-{version}-{tag}.whl"
    records = []
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name in distribution.files or []:
            label = str(name).replace("\\", "/")
            if (not label.startswith(("moss_lab/", "moss_lab-")) or "__pycache__" in label
                    or label.endswith(("/RECORD", "/INSTALLER", "/REQUESTED", "/direct_url.json"))):
                continue
            data = distribution.locate_file(name).read_bytes()
            archive.writestr(label, data)
            checksum = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            records.append([label, "sha256=" + checksum, str(len(data))])
        record_name = f"moss_lab-{version}.dist-info/RECORD"
        records.append([record_name, "", ""])
        stream = io.StringIO()
        csv.writer(stream, lineterminator="\n").writerows(records)
        archive.writestr(record_name, stream.getvalue())
    return target


def latest_wheel(directory: Path) -> Path:
    """Use stable MOSS releases from the owning repository, never an arbitrary index."""
    request = urllib.request.Request(f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=20", headers={"User-Agent": "MOSS-Lab-installer"})
    with urllib.request.urlopen(request, timeout=30) as response:
        releases = json.load(response)
    release = next((r for r in releases if not r["draft"] and not r["prerelease"] and re.fullmatch(r"moss-v\d+\.\d+\.\d+", r["tag_name"])), None)
    if release is None:
        raise RuntimeError("No stable Windows MOSS release is available")
    prefix = f"https://github.com/{REPOSITORY}/releases/download/{release['tag_name']}/"
    metadata = next((a for a in release["assets"] if a["name"] == "moss-windows.json"), None)
    if metadata is None or metadata["browser_download_url"] != prefix + "moss-windows.json":
        raise RuntimeError("MOSS release manifest is missing")
    manifest_path = directory / "release.json"
    download(metadata["browser_download_url"], manifest_path, 32768)
    manifest = json.loads(manifest_path.read_text())
    version = release["tag_name"].removeprefix("moss-v")
    expected = f"moss_lab-{version}-py3-none-win_amd64.whl"
    if manifest.get("wheel") != expected or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("sha256", "")):
        raise RuntimeError("Invalid MOSS release metadata")
    artifact = next((a for a in release["assets"] if a["name"] == expected), None)
    if artifact is None or artifact["browser_download_url"] != prefix + expected:
        raise RuntimeError("MOSS Windows wheel is missing")
    target = directory / expected
    download(artifact["browser_download_url"], target, 1024**3)
    if digest(target) != manifest["sha256"]:
        raise RuntimeError("Downloaded MOSS wheel checksum mismatch; installed package retained")
    return target


def update(manager: Manager, *, wheel: Path | None, port: int, timeout: float) -> None:
    """Stop-before-update is enforced by the caller's installation lock."""
    manager.recover(stopped=False)
    packages = manager.home / "packages"
    packages.mkdir(exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="update-", dir=packages) as temporary:
        stage = Path(temporary)
        selected = wheel.resolve() if wheel is not None else latest_wheel(stage)
        if not selected.is_file() or selected.suffix != ".whl":
            raise RuntimeError("Select a complete MOSS wheel")
        with zipfile.ZipFile(selected) as archive:
            for name in ["moss_lab/_payload/manifest.json", "moss_lab/_payload/application.zip"]:
                archive.extract(name, stage)
            candidate = Bundle(stage / "moss_lab/_payload")
            metadata_name = next(n for n in archive.namelist() if n.endswith(".dist-info/METADATA"))
            metadata = archive.read(metadata_name).decode()
            if ("Name: moss-lab\n" not in metadata or "Requires-Dist:" in metadata
                    or "Version: " + candidate.manifest["version"] + "\n" not in metadata):
                raise RuntimeError("Unsupported MOSS installer dependencies")
        if candidate.id == manager.state()["current"]:
            print("MOSS is already using this application version.")
            return
        recovery = installed_wheel(packages / ("recovery-" + os.urandom(8).hex()))
        from .install import atomic_json
        backup = manager.snapshot()
        recovery_script = manager.home / "recover-install.py"
        import shutil
        shutil.copy2(Path(__file__).with_name("recovery.py"), recovery_script)
        os.chmod(recovery_script, 0o600)
        atomic_json(manager.home / "package-update.json", {"schema": 1, "writer": os.urandom(16).hex(),
                    "wheel": recovery.relative_to(manager.home).as_posix(), "wheel_sha256": digest(recovery),
                    "backup": backup.relative_to(manager.home).as_posix(), "candidate": candidate.id,
                    "site_packages": str(Path(importlib.metadata.distribution("moss-lab").locate_file("")).resolve())})
        print(f'升级中断时的恢复命令：py "{recovery_script}" --stopped', flush=True)
        try:
            pip_install(selected, manager.home)
            state = manager.state()
            if state.get("blocked") == candidate.id:
                state["blocked"] = None
                from .install import atomic_json
                atomic_json(manager.state_path, state)
            manager.activate(candidate, port=port, timeout=timeout)
        except BaseException as error:
            # A live/uncertain process blocks data restoration in activate. Keeping
            # its interpreter files intact also avoids pip replacement at that point.
            if manager.journal_path.exists():
                raise RuntimeError(f"Upgrade recovery requires a stopped application. Cached installer: {recovery}") from error
            try:
                recover_home(manager.home)
            except Exception as restore_error:
                raise RuntimeError(f"Package restore failed; reinstall the retained wheel: {recovery}") from restore_error
            raise RuntimeError("Upgrade failed; previous pip package/application/data retained or restored") from error
        (manager.home / "package-update.json").unlink()
        print(f"MOSS {candidate.manifest['version']} upgraded and startup checked. Start with: py -m moss_lab start")
