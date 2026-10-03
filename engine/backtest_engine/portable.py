"""Entry point of the portable Windows engine (started by mbt_launcher, see updater.py).

The package carries its own Python and libraries; nothing is installed on the PC. Data (ticker
database, caches, jobs) lives in the "data" folder of the package itself (MomentumBacktesterEngine/data):
delete the package folder and nothing is left on the PC. Updates never touch it.
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

from . import ENGINE_ROOT, updater

STATIC = ("Complete_Tickers", "TOP_20_SP500_COMPLETE_TEMPLATE.csv")


def legacy_data_home() -> Path:
    """Where the first releases kept the data (outside the package)."""
    return Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "MomentumBacktester" / "engine"


def default_data_home() -> Path:
    """Inside the package (one folder to delete) when it can be written, else the old place."""
    pkg = updater.root()
    if pkg is not None:
        data = pkg / "data"
        try:
            data.mkdir(exist_ok=True)
            probe = data / ".write-test"
            probe.write_text("1", encoding="utf-8")
            probe.unlink()
            return data
        except OSError:
            pass
    return legacy_data_home()


def _adopt_legacy_data(home: Path) -> None:
    """Moves the data of the first releases into the package folder, once."""
    old = legacy_data_home()
    if home == old or not old.is_dir() or any(p for p in home.iterdir() if p.name != ".write-test"):
        return
    print(f"  Deplacement des donnees {old} -> {home} (une seule fois, peut prendre un moment)...", flush=True)
    try:
        for item in old.iterdir():
            shutil.move(str(item), str(home / item.name))
        old.rmdir()
        if not any(old.parent.iterdir()):
            old.parent.rmdir()
    except OSError as exc:
        print(f"  Deplacement incomplet ({exc}) : le reste de l'ancien dossier peut etre supprime a la main.", flush=True)


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


def _when_ready(port: int, site: str | None, restarted: bool) -> None:
    for _ in range(600):
        if _health(port):
            updater.mark_started()
            print(f"\n  Moteur pret sur http://127.0.0.1:{port}")
            if site and not restarted:
                print(f"  Ouvre le site : {site}  (il detecte ce moteur tout seul)")
                webbrowser.open(f"{site}/?engine=local")
            print("  Laisse cette fenetre ouverte pendant tes backtests ; la fermer arrete le moteur.\n", flush=True)
            return
        time.sleep(0.5)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="backtest_engine.portable")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--data", help="data folder (default: the data folder inside the package)")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args(argv)

    home = Path(args.data).resolve() if args.data else default_data_home()
    home.mkdir(parents=True, exist_ok=True)
    if not args.data:
        _adopt_legacy_data(home)
    os.environ["ENGINE_HOME"] = str(home)
    os.environ.setdefault("ENGINE_MODE", "local")
    os.environ["ENGINE_PORTABLE"] = "1"
    restarted = _take_restart_mark()

    version = updater.build_info().get("version", "dev")
    print(f"  Momentum Backtester - moteur {version}\n  Donnees : {home}", flush=True)
    if _health(args.port):
        print(f"  Un moteur tourne deja sur le port {args.port}.")
        if not args.no_browser:
            from server.settings import site_origins

            origins = site_origins(home)
            if origins:
                webbrowser.open(f"{origins[0]}/?engine=local")
        return 0
    if updater.startup(lambda line: print(line, flush=True)):
        return _restart()

    _sync_static(home)
    from server.settings import site_origins

    origins = site_origins(home)
    # Read once here: the server would otherwise fetch the list a second time.
    os.environ["ENGINE_ALLOWED_ORIGINS"] = ",".join(origins)
    os.environ["ENGINE_ORIGINS_URL"] = ""
    site = None if args.no_browser or not origins else origins[0]

    threading.Thread(target=_when_ready, args=(args.port, site, restarted), daemon=True).start()
    if updater.enabled():
        threading.Thread(target=updater.periodic, daemon=True, name="engine-update-timer").start()
    import uvicorn

    server = uvicorn.Server(uvicorn.Config("server.app:app", host="127.0.0.1", port=args.port, workers=1,
                                           log_level="warning"))
    updater.bind_server(server)
    server.run()
    if updater.restart_requested():
        print("\n  Redemarrage sur la nouvelle version...\n", flush=True)
        return _restart()
    return 0


def _restart_mark() -> Path | None:
    pkg = updater.root()
    return pkg / ".restarted" if pkg else None


def _restart() -> int:
    """The window starts the engine again: the site is already open, no new tab then."""
    mark = _restart_mark()
    if mark:
        mark.write_text("1", encoding="utf-8")
    return updater.RESTART


def _take_restart_mark() -> bool:
    mark = _restart_mark()
    if mark and mark.exists():
        mark.unlink(missing_ok=True)
        return True
    return False


if __name__ == "__main__":
    sys.exit(main())
