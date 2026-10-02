"""Build the portable Windows engine: one zip, nothing to install on the PC.

    py -3.13 engine/tools/build_portable.py [--out dist] [--version engine-v1.2.0] [--no-zip]

Layout of the zip (folder MomentumBacktesterEngine/):
    Lancer le moteur.cmd     double-click: starts the engine and opens the site
    LISEZMOI.txt
    version.txt
    python/                  official embeddable CPython (same version as the interpreter
                             running this script, so the wheels installed below match) with
                             the engine libraries in python/Lib/site-packages
    engine/                  backtest_engine, server, Complete_Tickers, allowed_origins.txt

Runs on Windows (pip installs the win_amd64 wheels of the running interpreter).
"""

from __future__ import annotations

import argparse
import platform
import shutil
import ssl
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
NAME = "MomentumBacktesterEngine"
EMBED_URL = "https://www.python.org/ftp/python/{v}/python-{v}-embed-amd64.zip"
ENGINE_ITEMS = ("backtest_engine", "server", "Complete_Tickers", "allowed_origins.txt")
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".cache", ".jobs", ".streamlit", ".certs", ".config")
# Test suites of the big scientific packages: never imported by the engine, ~60 MB.
TEST_DIRS = ("pandas/tests", "numpy/*/tests", "numpy/tests", "scipy/**/tests")

LAUNCHER = r"""@echo off
chcp 65001 >nul
title Momentum Backtester - moteur (laisse cette fenetre ouverte)
cd /d "%~dp0"
"%~dp0python\python.exe" -m backtest_engine.portable %*
if errorlevel 1 (
  echo.
  echo Le moteur s'est arrete avec une erreur. Copie le message ci-dessus si tu demandes de l'aide.
  pause
)
"""

README = """Momentum Backtester - moteur de calcul pour ton PC
===================================================

1. Double-clique sur « Lancer le moteur.cmd ».
   Windows peut afficher « Windows a protégé votre ordinateur » : clique « Informations
   complémentaires » puis « Exécuter quand même » (le moteur n'est pas signé).
2. Le site s'ouvre tout seul et détecte le moteur (pastille « Mon PC »).
   Chrome / Edge demandent une fois l'accès aux appareils locaux : clique « Autoriser ».
3. Laisse la fenêtre noire ouverte pendant tes backtests. La fermer arrête le moteur.

Rien n'est installé sur ton PC : Python et les librairies sont dans ce dossier.
Ta base de tickers et les caches sont dans %LOCALAPPDATA%\\MomentumBacktester :
une nouvelle version du moteur, décompressée n'importe où, les retrouve.
Pour tout supprimer : efface ce dossier et %LOCALAPPDATA%\\MomentumBacktester.
"""


def _download(url: str, dest: Path) -> None:
    if dest.exists():
        return
    print(f"download {url}", flush=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context()  # Windows: includes the OS store (antivirus TLS inspection)
    with urllib.request.urlopen(url, context=ctx, timeout=120) as r, open(dest.with_suffix(".part"), "wb") as f:
        shutil.copyfileobj(r, f)
    dest.with_suffix(".part").replace(dest)


def _strip_tests(site: Path) -> None:
    for pattern in TEST_DIRS:
        for d in site.glob(pattern):
            if d.is_dir() and d.name == "tests":
                shutil.rmtree(d, ignore_errors=True)
    for d in ("bin", "Scripts"):
        shutil.rmtree(site / d, ignore_errors=True)


def _size_mb(path: Path) -> float:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) / 2**20


def build(out: Path, version: str, make_zip: bool) -> Path:
    if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64"):
        raise SystemExit("Build on Windows x64: pip installs the wheels of the running interpreter.")
    py = platform.python_version()
    tag = f"{sys.version_info.major}{sys.version_info.minor}"
    stage = out / NAME
    shutil.rmtree(stage, ignore_errors=True)
    (stage / "python").mkdir(parents=True)

    embed = out / ".cache" / f"python-{py}-embed-amd64.zip"
    _download(EMBED_URL.format(v=py), embed)
    with zipfile.ZipFile(embed) as z:
        z.extractall(stage / "python")

    site = stage / "python" / "Lib" / "site-packages"
    print(f"pip install -> {site}", flush=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
         "--target", str(site), "-r", str(ENGINE / "requirements-portable.txt")],
        check=True,
    )
    _strip_tests(site)

    # Embedded Python ignores PYTHONPATH and site-packages unless its ._pth lists them.
    (stage / "python" / f"python{tag}._pth").write_text(
        f"python{tag}.zip\n.\nLib\\site-packages\n..\\engine\nimport site\n", encoding="ascii")

    for item in ENGINE_ITEMS:
        src = ENGINE / item
        dst = stage / "engine" / item
        if src.is_dir():
            shutil.copytree(src, dst, ignore=IGNORE)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    (stage / "Lancer le moteur.cmd").write_text(LAUNCHER.replace("\n", "\r\n"), encoding="utf-8")
    (stage / "LISEZMOI.txt").write_text(README.replace("\n", "\r\n"), encoding="utf-8")
    (stage / "version.txt").write_text(version, encoding="utf-8")

    # Smoke test with the embedded interpreter itself: every engine import must resolve.
    subprocess.run([str(stage / "python" / "python.exe"), "-c",
                    "import backtest_engine.legacy.multi_backtest, backtest_engine.legacy.allocations, server.app"],
                   check=True, cwd=stage, env={"ENGINE_ORIGINS_URL": "", "SYSTEMROOT": _systemroot()})
    # The import wrote this machine's CA bundle: each PC builds its own at first start.
    shutil.rmtree(stage / "engine" / ".certs", ignore_errors=True)
    print(f"staged {stage} ({_size_mb(stage):.0f} MB)", flush=True)

    if not make_zip:
        return stage
    archive = out / f"{NAME}-win64.zip"
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out))
    print(f"zip {archive} ({archive.stat().st_size / 2**20:.0f} MB)", flush=True)
    return archive


def _systemroot() -> str:
    import os

    return os.environ.get("SYSTEMROOT", r"C:\Windows")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ENGINE.parent / "dist"))
    ap.add_argument("--version", default="dev")
    ap.add_argument("--no-zip", action="store_true")
    args = ap.parse_args()
    build(Path(args.out).resolve(), args.version, not args.no_zip)


if __name__ == "__main__":
    main()
