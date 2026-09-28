"""Starts the backtest engine on this PC (http://127.0.0.1:8765).

    python run_engine.py            # first run creates engine/.venv and installs dependencies
    python run_engine.py --port 9000
    python run_engine.py --reinstall

The web app (local dev or the Vercel site) detects the engine automatically
while this window stays open. Close it or press Ctrl+C to stop.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "engine"
VENV = ENGINE / ".venv"
REQUIREMENTS = ENGINE / "requirements.txt"
STAMP = VENV / ".requirements.sha256"


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_venv(reinstall: bool) -> Path:
    if sys.version_info < (3, 10):
        sys.exit(f"Python 3.10+ is required (found {sys.version.split()[0]}).")
    py = venv_python()
    if reinstall or not py.exists():
        print(f"Creating virtual environment in {VENV} ...")
        venv.EnvBuilder(with_pip=True, clear=reinstall).create(VENV)
    digest = hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()
    if reinstall or not STAMP.exists() or STAMP.read_text().strip() != digest:
        print("Installing engine dependencies (first run takes a few minutes) ...")
        subprocess.check_call([str(py), "-m", "pip", "install", "--upgrade", "pip", "-q"])
        subprocess.check_call([str(py), "-m", "pip", "install", "-r", str(REQUIREMENTS)])
        STAMP.write_text(digest)
    return py


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("ENGINE_PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--reinstall", action="store_true")
    args = ap.parse_args()

    py = ensure_venv(args.reinstall)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "ENGINE_MODE": os.environ.get("ENGINE_MODE", "local")}
    print(f"\nBacktest engine running on http://{args.host}:{args.port}  (Ctrl+C to stop)\n")
    try:
        return subprocess.call(
            [str(py), "-m", "backtest_engine", "serve", "--host", args.host, "--port", str(args.port)],
            cwd=str(ENGINE),
            env=env,
        )
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
