"""Build the portable Windows engine: one zip, nothing to install on the PC, self-updating.

    py -3.13 engine/tools/build_portable.py [--out dist] [--version engine-2026.10.02-7] [--no-zip]
                                            [--asset-base URL]

Outputs in --out:
    MomentumBacktesterEngine/           the package (layout in backtest_engine/updater.py)
    MomentumBacktesterEngine-win64.zip  the package zipped: first install, and updates that change Python
                                        or a library
    engine-code.zip                     versions/<version> only: updates that change the engine code
    manifest.json                       version, api, code_sha, runtime + url/sha256/size of both zips

The runtime folder is named after the Python version and the hash of requirements-portable.txt,
so an update downloads the 90 MB runtime only when one of them changed.
Runs on Windows (pip installs the win_amd64 wheels of the running interpreter).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import re
import shutil
import ssl
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
NAME = "MomentumBacktesterEngine"
EMBED_URL = "https://www.python.org/ftp/python/{v}/python-{v}-embed-amd64.zip"
ASSET_BASE = "https://github.com/Goshty4234/ibkr-performance-viewer/releases/download/{version}"
CODE_ITEMS = ("backtest_engine", "server", "Complete_Tickers", "allowed_origins.txt")
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".cache", ".jobs", ".streamlit", "marketdata", ".certs", ".config")
# pandas' test suite (~40 MB) is never imported. numpy's and scipy's stay: numpy.testing, loaded
# by scipy.optimize, imports numpy/_core/tests (without it the MWRR silently became N/A).
TEST_DIRS = ("pandas/tests",)
# Bump when the runtime changes without requirements-portable.txt changing (stripping, ._pth...).
RUNTIME_RECIPE = "2"
# The legacy code swallows import errors (scipy -> MWRR N/A), so the libraries are imported too.
SMOKE = ("import scipy.optimize, numpy, pandas, yfinance, curl_cffi, diskcache, bs4, lxml; "
         "import backtest_engine.legacy.multi_backtest, backtest_engine.legacy.allocations, "
         "backtest_engine.portable, server.app")

LAUNCHER = r"""@echo off
chcp 65001 >nul
title Momentum Backtester - moteur (laisse cette fenetre ouverte)
cd /d "%~dp0"
:run
set "RT="
set /p RT=<runtime.txt
"%~dp0runtimes\%RT%\python.exe" -m mbt_launcher %*
if %errorlevel% equ 75 goto run
if %errorlevel% neq 0 (
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

Mises à jour : automatiques. Au démarrage, le moteur compare sa version à la dernière publiée ;
si le code a changé il télécharge la nouvelle version (quelques Mo), la vérifie et redémarre
dessus. Si une version ne démarre pas, il revient tout seul à la précédente.

Rien n'est installé sur ton PC : Python et les librairies sont dans ce dossier.
Tout le reste est dans le sous-dossier « data » : base de tickers, caches, résultats de tes
backtests (backtests/), fichiers IBKR (ibkr/) et configurations (configs/). Les mises à jour ne
le touchent jamais. Pour changer de PC, copie simplement ce dossier. Le site t'affiche
l'espace utilisé et propose le nettoyage dans la page « Stockage ».
Pour tout supprimer : efface ce dossier.
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


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_sha(folder: Path) -> str:
    """Identity of the shipped engine code: relative paths + bytes of every file."""
    h = hashlib.sha256()
    for f in sorted(p for p in folder.rglob("*") if p.is_file() and p.name != "build.json"):
        h.update(f.relative_to(folder).as_posix().encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()


def runtime_id(py: str) -> str:
    req = (ENGINE / "requirements-portable.txt").read_text(encoding="utf-8")
    h = hashlib.sha256(f"{py}\n{RUNTIME_RECIPE}\n{req}".encode()).hexdigest()
    return f"py{py}-{h[:10]}"


def api_version() -> int:
    text = (ENGINE / "backtest_engine" / "__init__.py").read_text(encoding="utf-8")
    return int(re.search(r"^API_VERSION = (\d+)", text, re.M).group(1))


def _zip(folder: Path, archive: Path, base: Path) -> None:
    archive.unlink(missing_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(folder.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(base))


def build(out: Path, version: str, make_zip: bool, asset_base: str) -> Path:
    if sys.platform != "win32" or platform.machine().lower() not in ("amd64", "x86_64"):
        raise SystemExit("Build on Windows x64: pip installs the wheels of the running interpreter.")
    py = platform.python_version()
    tag = f"{sys.version_info.major}{sys.version_info.minor}"
    rt = runtime_id(py)
    stage = out / NAME
    shutil.rmtree(stage, ignore_errors=True)
    runtime = stage / "runtimes" / rt
    code = stage / "versions" / version
    runtime.mkdir(parents=True)

    embed = out / ".cache" / f"python-{py}-embed-amd64.zip"
    _download(EMBED_URL.format(v=py), embed)
    with zipfile.ZipFile(embed) as z:
        z.extractall(runtime)

    site = runtime / "Lib" / "site-packages"
    print(f"pip install -> {site}", flush=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
         "--target", str(site), "-r", str(ENGINE / "requirements-portable.txt")],
        check=True,
    )
    _strip_tests(site)
    # Embedded Python ignores PYTHONPATH and site-packages unless its ._pth lists them; ..\.. is the
    # package root (mbt_launcher), the launcher adds the engine code folder itself.
    (runtime / f"python{tag}._pth").write_text(
        f"python{tag}.zip\n.\nLib\\site-packages\n..\\..\nimport site\n", encoding="ascii")
    (runtime / ".ok").write_text(version, encoding="utf-8")

    for item in CODE_ITEMS:
        src = ENGINE / item
        dst = code / item
        if src.is_dir():
            shutil.copytree(src, dst, ignore=IGNORE)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    code_sha = tree_sha(code)
    build_info = {"version": version, "api": api_version(), "code_sha": code_sha, "runtime": rt,
                  "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    (code / "build.json").write_text(json.dumps(build_info, indent=1), encoding="utf-8")

    shutil.copy2(ENGINE / "backtest_engine" / "portable_launcher.py", stage / "mbt_launcher.py")
    (stage / "state.json").write_text(json.dumps({"code": version, "runtime": rt}, indent=1), encoding="utf-8")
    (stage / "runtime.txt").write_text(rt, encoding="utf-8")
    (stage / "Lancer le moteur.cmd").write_text(LAUNCHER.replace("\n", "\r\n"), encoding="utf-8")
    (stage / "LISEZMOI.txt").write_text(README.replace("\n", "\r\n"), encoding="utf-8")

    out.mkdir(parents=True, exist_ok=True)
    code_zip = out / "engine-code.zip"
    _zip(code, code_zip, code)

    # Smoke test with the embedded interpreter itself: every engine import must resolve.
    script = f"import sys; sys.path.insert(0, {str(code)!r}); {SMOKE}"
    subprocess.run([str(runtime / "python.exe"), "-c", script], check=True, cwd=code,
                   env={"ENGINE_ORIGINS_URL": "", "SYSTEMROOT": _systemroot()})
    # The import wrote this machine's CA bundle: each PC builds its own at first start.
    shutil.rmtree(code / ".certs", ignore_errors=True)
    print(f"staged {stage} ({_size_mb(stage):.0f} MB), runtime {rt}, code {code_sha[:12]}", flush=True)

    if not make_zip:
        return stage
    archive = out / f"{NAME}-win64.zip"
    _zip(stage, archive, out)
    base = asset_base.format(version=version).rstrip("/")
    manifest = {
        **{k: build_info[k] for k in ("version", "api", "code_sha", "runtime", "built_at")},
        "assets": {
            "code": {"name": code_zip.name, "url": f"{base}/{code_zip.name}", "sha256": _sha256(code_zip),
                     "size": code_zip.stat().st_size},
            "full": {"name": archive.name, "url": f"{base}/{archive.name}", "sha256": _sha256(archive),
                     "size": archive.stat().st_size},
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    print(f"zip {archive} ({archive.stat().st_size / 2**20:.0f} MB), {code_zip.name} "
          f"({code_zip.stat().st_size / 2**20:.1f} MB), manifest.json", flush=True)
    return archive


def _systemroot() -> str:
    import os

    return os.environ.get("SYSTEMROOT", r"C:\Windows")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ENGINE.parent / "dist"))
    ap.add_argument("--version", default="dev")
    ap.add_argument("--no-zip", action="store_true")
    ap.add_argument("--asset-base", default=ASSET_BASE, help="where the release assets will be downloaded from")
    args = ap.parse_args()
    build(Path(args.out).resolve(), args.version, not args.no_zip, args.asset_base)


if __name__ == "__main__":
    main()
