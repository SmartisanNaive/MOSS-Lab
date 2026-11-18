import os
from pathlib import Path
import sys

# Keep this check independent of the potentially replaced manager modules.
home = Path(os.environ.get("MOSS_HOME", str(Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local/share")) / "MOSS-Lab")))
if "--home" in sys.argv:
    home = Path(sys.argv[sys.argv.index("--home") + 1])
if (home / "package-update.json").exists():
    recovery = home / "recover-install.py"
    if "recover" in sys.argv and "--stopped" in sys.argv:
        os.execv(sys.executable, [sys.executable, str(recovery), "--home", str(home), "--stopped"])
    print(f'pip 升级未完成，先停止 MOSS，再运行：py "{recovery}" --stopped', file=sys.stderr)
    raise SystemExit(1)

from .cli import main

raise SystemExit(main())
