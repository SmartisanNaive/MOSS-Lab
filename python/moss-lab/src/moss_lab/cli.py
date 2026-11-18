"""The same Python invocation installs, starts, upgrades and restores MOSS."""
from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

from .install import Bundle, Manager, default_home, exclusive
from .update import update


def main(argv=None):
    parser = argparse.ArgumentParser(prog="py -m moss_lab", description="MOSS laboratory workbench")
    parser.add_argument("--home", type=Path, default=default_home(), help="Persistent configuration and experiment directory")
    subcommands = parser.add_subparsers(dest="command", required=True)
    for name in ["start", "check", "update"]:
        command = subcommands.add_parser(name)
        command.add_argument("--port", type=int, default=8765)
        command.add_argument("--timeout", type=float, default=1800, help="First-start dependency preparation and health deadline")
        if name == "start":
            command.add_argument("--no-open", action="store_true")
        if name == "update":
            command.add_argument("--wheel", type=Path, help="Use a previously downloaded MOSS wheel")
    command = subcommands.add_parser("import", help="Copy legacy data after stopping the old service")
    command.add_argument("directory", type=Path)
    command.add_argument("--stopped", action="store_true")
    command = subcommands.add_parser("recover", help="Recover an interrupted upgrade after confirming all MOSS processes stopped")
    command.add_argument("--stopped", action="store_true")
    subcommands.add_parser("rollback")
    subcommands.add_parser("config")
    subcommands.add_parser("status")
    args = parser.parse_args(argv)
    try:
        if args.command in {"start", "check", "update"} and (not 0 <= args.port <= 65535 or args.timeout <= 0):
            raise RuntimeError("Invalid port or startup timeout")
        bundle = Bundle(Path(__file__).parent / "_payload")
        manager = Manager(args.home, bundle)
        with exclusive(manager.home):
            if args.command not in {"recover", "status"}:
                manager.recover(stopped=False)
            if args.command == "config":
                path = manager.home / ".env"
                if path.exists():
                    print(f"Existing configuration was retained. Edit privately: {path}")
                    return 0
                url = input("模型服务地址（HTTPS，末尾为 /chat/completions）：").strip()
                model = input("模型名称：").strip()
                key = getpass.getpass("API 密钥（输入时不显示）：").strip()
                if not url.startswith("https://") or not url.endswith("/chat/completions") or not model or not key:
                    raise RuntimeError("HTTPS model URL, model name and API key are required")
                import json
                # JSON strings are also valid quoted Node .env values.
                with path.open("x", encoding="utf-8") as stream:
                    os.chmod(path, 0o600)
                    for name, value in [("AI_API_URL", url), ("AI_MODEL", model), ("AI_API_KEY", key), ("XIAOZHI_WSS_URL", ""), ("OPENTRONS_URL", ""), ("MOSS_ALLOW_LIVE_ROBOT", "0")]:
                        stream.write(name + "=" + json.dumps(value, ensure_ascii=False) + "\n")
                print(f"Configuration saved privately: {path}")
            elif args.command == "import":
                manager.import_legacy(args.directory, stopped=args.stopped)
                print("Old configuration and data copied; the original directory was not changed.")
            elif args.command == "recover":
                manager.recover(stopped=args.stopped)
                print("Interrupted upgrade recovered. Newer data retained in backups.")
            elif args.command == "rollback":
                manager.rollback()
            elif args.command == "status":
                state = manager.state()
                version = manager.release(state["current"])[1]["version"] if state["current"] else "not started"
                print(f"MOSS {version}\nData: {manager.home}\nInstalled package: {bundle.manifest['version']}")
            elif args.command == "update":
                update(manager, wheel=args.wheel, port=args.port, timeout=args.timeout)
            else:
                manager.start(port=args.port, verify=args.command == "check", no_open=getattr(args, "no_open", True), timeout=args.timeout)
        return 0
    except KeyboardInterrupt:
        return 130
    except Exception as error:
        print(f"MOSS: {error}", file=sys.stderr)
        return 1
