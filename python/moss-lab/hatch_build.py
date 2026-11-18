"""Require a complete native application before producing an installer wheel."""
import hashlib
import json
from pathlib import Path
from hatchling.builders.hooks.plugin.interface import BuildHookInterface

class MossBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if self.target_name != "wheel":
            raise RuntimeError("MOSS is distributed as complete platform wheels")
        payload = Path(self.root) / "src/moss_lab/_payload"
        manifest = json.loads((payload / "manifest.json").read_text())
        archive = payload / "application.zip"
        if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest["sha256"]:
            raise RuntimeError("MOSS application archive checksum mismatch")
        if manifest["version"] != self.metadata.version:
            raise RuntimeError("MOSS package and application versions differ")
        build_data["pure_python"] = False
        build_data["infer_tag"] = False
        build_data["tag"] = "py3-none-" + manifest["wheel_platform"]
        build_data["artifacts"] = ["src/moss_lab/_payload/**"]
