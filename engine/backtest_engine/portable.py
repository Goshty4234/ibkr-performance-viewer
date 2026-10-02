"""Entry point of the portable Windows engine: python\\python.exe -m backtest_engine.portable

The package carries its own Python and libraries; nothing is installed on the PC. Data (ticker
database, caches, jobs) lives in %LOCALAPPDATA%\\MomentumBacktester, so a newer package extracted
anywhere keeps it.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

from . import ENGINE_ROOT, __version__

RELEASES_API = "https://api.github.com/repos/Goshty4234/ibkr-performance-viewer/releases/latest"
DOWNLOAD_PAGE = "https://github.com/Goshty4234/ibkr-performance-viewer/releases/latest"
STATIC = ("Complete_Tickers", "TOP_20_SP500_COMPLETE_TEMPLATE.csv")


def default_data_home() -> Path:
    return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MomentumBacktester" / "engine"


def package_version() -> str:
    try:
        return (ENGINE_ROOT.parent / "version.txt").read_text(encoding="utf-8").strip()
    except OSError:
        return __version__


def _sync_static(home: Path) -> None:
    """The legacy code opens these through paths relative to ENGINE_HOME."""
    for name in STATIC:
        src = ENGINE_ROOT / name
        if src.is_dir():
            shutil.copytree(src, home / name, dirs_exist_ok=True)
        elif src.exists():
            shutil.copy2(src, home / name)


def _health(port: int, timeout: float = 1.0) -> dict | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8"))
        return body if body.get("engine") == "momentum-backtest" else None
    except Exception:  # noqa: BLE001
        return None


def _open_when_ready(port: int, site: str | None) -> None:
    for _ in range(600):
        if _health(port):
            print(f"\n  Moteur pret sur http://127.0.0.1:{port}")
            if site:
                print(f"  Ouvre le site : {site}  (il detecte ce moteur tout seul)")
                webbrowser.open(f"{site}/?engine=local")
            print("  Laisse cette fenetre ouverte pendant tes backtests ; la fermer arrete le moteur.\n", flush=True)
            return
        time.sleep(0.5)


def _check_update(current: str) -> None:
    try:
        req = urllib.request.Request(RELEASES_API, headers={"Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            tag = str(json.loads(r.read().decode("utf-8")).get("tag_name") or "")
    except Exception:  # noqa: BLE001 - offline or rate-limited: no notice
        return
    if tag and tag != current:
        print(f"\n  Nouvelle version du moteur disponible ({tag}, tu as {current}) : {DOWNLOAD_PAGE}\n"
              "  Telecharge-la et decompresse-la n'importe ou : ta base de tickers est conservee.\n", flush=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="backtest_engine.portable")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", help="data folder (default: %%LOCALAPPDATA%%\\MomentumBacktester\\engine)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    home = Path(args.data).resolve() if args.data else default_data_home()
    home.mkdir(parents=True, exist_ok=True)
    os.environ["ENGINE_HOME"] = str(home)
    os.environ.setdefault("ENGINE_MODE", "local")
    os.environ["ENGINE_PORTABLE"] = "1"
    _sync_static(home)

    from server.settings import site_origins

    origins = site_origins(home)
    # Read once here: the server would otherwise fetch the list a second time.
    os.environ["ENGINE_ALLOWED_ORIGINS"] = ",".join(origins)
    os.environ["ENGINE_ORIGINS_URL"] = ""
    site = None if args.no_browser or not origins else origins[0]

    version = package_version()
    print(f"  Momentum Backtester - moteur {version}\n  Donnees : {home}", flush=True)
    if _health(args.port):
        print(f"  Un moteur tourne deja sur le port {args.port}.")
        if site:
            webbrowser.open(f"{site}/?engine=local")
        return 0

    threading.Thread(target=_open_when_ready, args=(args.port, site), daemon=True).start()
    threading.Thread(target=_check_update, args=(version,), daemon=True).start()
    import uvicorn

    uvicorn.run("server.app:app", host="127.0.0.1", port=args.port, workers=1, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
