"""Starts the backtest engine on this PC (http://127.0.0.1:8765).

    python run_engine.py            # first run creates engine/.venv and installs dependencies
    python run_engine.py --port 9000
    python run_engine.py --reinstall
    python run_engine.py --data D:\\MesDonnees   # other data folder

All data (ticker prices, jobs, Monte Carlo files, settings) lives in ONE folder, the same as the
downloadable engine: %LOCALAPPDATA%\\MomentumBacktester\\engine. Delete it to wipe everything.

The web app (local dev or the Vercel site) detects the engine automatically
while this window stays open. Close it or press Ctrl+C to stop.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENGINE = ROOT / "engine"
VENV = ENGINE / ".venv"
REQUIREMENTS = ENGINE / "requirements.txt"
STAMP = VENV / ".requirements.sha256"


STATIC = ("Complete_Tickers", "TOP_20_SP500_COMPLETE_TEMPLATE.csv")


def default_data_home() -> Path:
    """Same folder as the portable engine, so both share one cache and one place to clean."""
    return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MomentumBacktester" / "engine"


def prepare_data_home(home: Path) -> None:
    """Creates the data folder, copies the static files the legacy code reads from it, and moves the
    ticker cache that older dev runs kept inside engine/ (once, only when the new one is empty)."""
    home.mkdir(parents=True, exist_ok=True)
    for name in STATIC:
        src = ENGINE / name
        if src.is_dir():
            shutil.copytree(src, home / name, dirs_exist_ok=True)
        elif src.exists():
            shutil.copy2(src, home / name)
    for old, new in ((ENGINE / ".streamlit", home / ".streamlit"),):
        if old.is_dir() and not new.exists():
            print(f"Moving the ticker cache {old} -> {new} (once) ...")
            try:
                shutil.move(str(old), str(new))
            except OSError as exc:
                print(f"  Could not move it ({exc}); the old folder is left in place.")


def venv_python() -> Path:
    return VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def pip_env() -> dict:
    """Older pip only trusts its bundled certifi; antivirus HTTPS scanning re-signs pypi.org with a
    root that only exists in the Windows store. Same bundle as backtest_engine/certs.py."""
    env = dict(os.environ)
    if sys.platform != "win32" or env.get("PIP_CERT"):
        return env
    import ssl

    pems: list[str] = []
    vendored = VENV / "Lib" / "site-packages" / "pip" / "_vendor" / "certifi" / "cacert.pem"
    if vendored.exists():
        pems.append(vendored.read_text(encoding="ascii", errors="ignore"))
    try:
        import certifi

        pems.append(Path(certifi.where()).read_text(encoding="ascii", errors="ignore"))
    except ImportError:
        pass
    seen: set[bytes] = set()
    for store in ("ROOT", "CA"):
        for der, encoding, _trust in ssl.enum_certificates(store):
            if encoding == "x509_asn" and der not in seen:
                seen.add(der)
                pems.append(ssl.DER_cert_to_PEM_cert(der))
    bundle = VENV / "pip-ca-bundle.pem"
    bundle.write_text("\n".join(pems), encoding="ascii", errors="ignore")
    env["PIP_CERT"] = str(bundle)
    return env


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
        env = pip_env()
        subprocess.check_call([str(py), "-m", "pip", "install", "--upgrade", "pip", "-q"], env=env)
        subprocess.check_call([str(py), "-m", "pip", "install", "-r", str(REQUIREMENTS)], env=env)
        STAMP.write_text(digest)
    return py


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=int(os.environ.get("ENGINE_PORT", 8765)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--reinstall", action="store_true")
    ap.add_argument("--data", help="data folder (default: %%LOCALAPPDATA%%\\MomentumBacktester\\engine)")
    args = ap.parse_args()

    py = ensure_venv(args.reinstall)
    home = Path(args.data).resolve() if args.data else Path(os.environ.get("ENGINE_HOME") or default_data_home()).resolve()
    prepare_data_home(home)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "ENGINE_MODE": os.environ.get("ENGINE_MODE", "local"), "ENGINE_HOME": str(home)}
    print(f"Data folder: {home}")
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
