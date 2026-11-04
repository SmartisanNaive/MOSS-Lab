"""Generate a Flex3D scene from an existing Opentrons analysis, without executing a protocol."""
import json
import os
from pathlib import Path
import sys


def main():
    flex_root, analysis_path, output_path = map(Path, sys.argv[1:])
    os.environ["FLEX3D_EXPORT"] = str(output_path)
    sys.path.insert(0, str(flex_root))
    from sim.web_player import Model

    model = Model("preview", analysis_path, output_path)
    try:
        (output_path / "info.json").write_text(json.dumps(model.info(), ensure_ascii=False), encoding="utf-8")
    finally:
        model.close()


if __name__ == "__main__":
    main()
