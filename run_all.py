#!/usr/bin/env python3
"""Lance tout en local : le moteur de backtest (http://127.0.0.1:8765) et le site (http://localhost:3000).

    python run_all.py

Ctrl+C arrete les deux.
"""

from __future__ import annotations

import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import run_dev

ROOT = Path(__file__).resolve().parent
ENGINE_HEALTH = "http://127.0.0.1:8765/health"


def engine_running() -> bool:
    try:
        with urllib.request.urlopen(ENGINE_HEALTH, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def stop(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    if sys.platform == "win32":
        # The engine spawns worker processes: kill the whole tree.
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)
    else:
        proc.terminate()


def main() -> int:
    engine = None
    if engine_running():
        print(" Moteur deja lance sur http://127.0.0.1:8765 : reutilise.")
    else:
        print(" Demarrage du moteur (premier lancement : installation de quelques minutes)...")
        engine = subprocess.Popen([sys.executable, "-u", str(ROOT / "run_engine.py")], cwd=ROOT)
        for _ in range(600):
            if engine_running():
                print(" Moteur pret.")
                break
            if engine.poll() is not None:
                print(" Le moteur n'a pas demarre : voir les messages ci-dessus. Le site demarre quand meme.")
                engine = None
                break
            time.sleep(1)
    try:
        return run_dev.main()
    finally:
        stop(engine)


if __name__ == "__main__":
    raise SystemExit(main())
