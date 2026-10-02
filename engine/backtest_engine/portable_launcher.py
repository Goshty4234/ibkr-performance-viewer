"""Launcher of the portable package, copied to its root as mbt_launcher.py (see updater.py).

Lancer le moteur.cmd runs runtimes/<runtime.txt>/python.exe -m mbt_launcher and starts it again
when it exits with RESTART (update applied, rollback, runtime switch). Standard library only:
it must work whatever version state.json points to.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RESTART = 75
MAX_TRIES = 2


def _write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _save(state: dict) -> None:
    _write(ROOT / "state.json", json.dumps(state, indent=1))
    _write(ROOT / "runtime.txt", state["runtime"])


def _rollback(state: dict, why: str) -> int:
    prev = state["previous"]
    print(f"\n  La nouvelle version ne demarre pas ({why}) : retour a la version precedente.\n", flush=True)
    # "skip": the updater does not install this version again (a fixed release has another name).
    _save({"code": prev["code"], "runtime": prev["runtime"], "skip": state["code"]})
    return RESTART


def main() -> int:
    state = json.loads((ROOT / "state.json").read_text(encoding="utf-8"))
    pending = bool(state.get("pending") and state.get("previous"))
    if pending:
        state["tries"] = int(state.get("tries", 0)) + 1
        if state["tries"] > MAX_TRIES:
            return _rollback(state, "plusieurs essais")
        _save(state)
    if Path(sys.executable).resolve().parent.name != state["runtime"]:
        # runtime.txt lagged behind state.json (interrupted switch): the .cmd starts the right one.
        _write(ROOT / "runtime.txt", state["runtime"])
        return RESTART
    code = ROOT / "versions" / state["code"]
    if not (code / "backtest_engine").is_dir():
        if pending:
            return _rollback(state, "dossier manquant")
        print(f"  Version introuvable : {code}. Retelecharge le moteur.", flush=True)
        return 1
    sys.path.insert(0, str(code))
    try:
        from backtest_engine.portable import main as run

        return run(sys.argv[1:])
    except (SystemExit, KeyboardInterrupt):
        raise
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        # Still pending = it never answered /health; a version that ran fine is kept.
        current = json.loads((ROOT / "state.json").read_text(encoding="utf-8"))
        if pending and current.get("pending"):
            return _rollback(current, repr(exc)[:200])
        return 1


if __name__ == "__main__":
    sys.exit(main())
