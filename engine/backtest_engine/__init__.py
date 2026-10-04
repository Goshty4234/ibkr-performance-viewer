"""Momentum backtest engine extracted from the Streamlit Multi-Backtest page."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

__version__ = "1.0.0"
# Contract between the site and the engine (endpoints, request and result formats). Bump it with
# ENGINE_API in src/lib/engine/client.ts when the site needs something older engines lack: the
# site then refuses to run on an older engine and offers its update.
API_VERSION = 4

# Parallelism comes from worker processes. Multi-threaded BLAS would also
# commit one buffer per core in every process (~1 GB each with 16 cores).
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

ENGINE_ROOT = Path(__file__).resolve().parent.parent


def _numba_optional() -> None:
    """The legacy page decorates two helpers with numba's @jit at import time, though nothing calls
    them. The portable engine leaves numba out (~140 MB with llvmlite): a pass-through jit keeps
    the import working."""
    import importlib.util
    import types

    if "numba" in sys.modules or importlib.util.find_spec("numba") is not None:
        return
    stub = types.ModuleType("numba")
    stub.jit = lambda *args, **kwargs: (lambda fn: fn)  # type: ignore[attr-defined]
    sys.modules["numba"] = stub


_numba_optional()


def engine_home() -> Path:
    """Folder holding Complete_Tickers/ and the marketdata/ price cache.

    The legacy code opens these through relative paths, so the process working
    directory must point here before any backtest runs.
    """
    return Path(os.environ.get("ENGINE_HOME", ENGINE_ROOT)).resolve()


# Folders of the data home, named for what they hold. Older versions used hidden-looking names.
# Order matters: ".streamlit" becomes "marketdata" first, then the folders inside it are renamed.
RENAMED_DIRS = {
    ".jobs": "jobs", ".config": "config", ".cache": "cache", ".mc": "montecarlo", ".streamlit": "marketdata",
    "marketdata/ticker_cache": "marketdata/price_history",
    "marketdata/ticker_info_cache": "marketdata/ticker_info_temp",
}

DATA_README = """Dossier de donnees du moteur Momentum Backtester
===============================================
Tout ce que le moteur ecrit est ici. Supprime ce dossier = plus aucune trace
(il sera recree vide au prochain lancement, les prix se retelechargent au besoin).

  backtests\\              tes resultats de backtest complets (un dossier par run, par compte)
  ibkr\\                    releves IBKR importes dans l'IBKR viewer (fichiers CSV)
  configs\\                 copie de sauvegarde de tes configurations
  marketdata\\price_history  PERMANENT : historiques de prix des tickers (le plus gros). Rien ne
                          l'efface tout seul ; il ne se refait que par retelechargement (lent,
                          limites de Yahoo). A garder / copier. (Ancien nom : ticker_cache.)
  marketdata\\quote_store   PERMANENT : fiches Yahoo archivees (PE, capitalisation...)
  marketdata\\sec_store     PERMANENT : historique du nombre d'actions
  marketdata\\ticker_info_temp  temporaire : infos tickers, se refait seul (ancien nom : ticker_info_cache)
  cache\\                    resultats de portfolios deja calcules (cache temporaire)
  jobs\\                     fichiers des backtests recents (supprimes apres quelques heures)
  montecarlo\\               fichiers temporaires des simulations Monte Carlo
  config\\                   liste des adresses du site autorisees
  Complete_Tickers\\         listes de tickers fournies avec le moteur
"""


def _merge_dir(src: Path, dst: Path) -> None:
    """Moves src to dst. When dst already exists, only what dst lacks is moved (folders recursively),
    so a folder recreated empty by a run never hides the data of the old one."""
    if not dst.exists():
        src.rename(dst)
        return
    for child in list(src.iterdir()):
        target = dst / child.name
        if not target.exists():
            child.rename(target)
        elif child.is_dir() and target.is_dir():
            _merge_dir(child, target)
        elif child.is_file() and target.is_file():
            child.unlink()  # same cache entry in both: the current folder's copy wins
    try:
        src.rmdir()
    except OSError:
        pass


EMPTY_STORE_BYTES = 5 * 1024 * 1024


def _dir_bytes(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def migrate_layout(home: Path) -> None:
    """Renames the old folder names to the current ones (once) and refreshes the README."""
    for old, new in RENAMED_DIRS.items():
        try:
            if not (home / old).is_dir():
                continue
            if "/" in old and (home / new).exists():
                # Two disk caches cannot be merged file by file (their index is one database): the one
                # a newer engine just created empty gives way to the real one; if both hold data, the
                # old folder is left alone (nothing is lost, the new one is simply used).
                if _dir_bytes(home / new) < EMPTY_STORE_BYTES:
                    shutil.rmtree(home / new)
                else:
                    continue
            _merge_dir(home / old, home / new)
        except OSError:
            pass
    try:
        readme = home / "LISEZ-MOI.txt"
        if not readme.exists() or readme.read_text(encoding="utf-8") != DATA_README:
            readme.write_text(DATA_README, encoding="utf-8")
    except OSError:
        pass


def activate_engine_home() -> Path:
    from backtest_engine.certs import ensure_system_ca_bundle

    ensure_system_ca_bundle(ENGINE_ROOT / ".certs")
    home = engine_home()
    migrate_layout(home)
    os.chdir(home)
    for p in (str(home), str(ENGINE_ROOT)):
        if p not in sys.path:
            sys.path.insert(0, p)
    from backtest_engine.top20 import ensure_table

    ensure_table(home)
    return home
