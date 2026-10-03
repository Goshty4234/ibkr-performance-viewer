"""Momentum backtest engine extracted from the Streamlit Multi-Backtest page."""

from __future__ import annotations

import os
import sys
from pathlib import Path

__version__ = "1.0.0"
# Contract between the site and the engine (endpoints, request and result formats). Bump it with
# ENGINE_API in src/lib/engine/client.ts when the site needs something older engines lack: the
# site then refuses to run on an older engine and offers its update.
API_VERSION = 3

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
    """Folder holding Complete_Tickers/ and the .streamlit/ price cache.

    The legacy code opens these through relative paths, so the process working
    directory must point here before any backtest runs.
    """
    return Path(os.environ.get("ENGINE_HOME", ENGINE_ROOT)).resolve()


# Folders of the data home, named for what they hold. Older versions used hidden-looking names.
RENAMED_DIRS = {".jobs": "jobs", ".config": "config", ".cache": "cache", ".mc": "montecarlo"}

DATA_README = """Dossier de donnees du moteur Momentum Backtester
===============================================
Tout ce que le moteur ecrit est ici. Supprime ce dossier = plus aucune trace
(il sera recree vide au prochain lancement, les prix se retelechargent au besoin).

  backtests\\              tes resultats de backtest complets (un dossier par run, par compte)
  ibkr\\                    releves IBKR importes dans l'IBKR viewer (fichiers CSV)
  configs\\                 copie de sauvegarde de tes configurations
  .streamlit\\ticker_cache   historiques de prix des tickers (le plus gros)
  .streamlit\\quote_store    fiches Yahoo archivees (PE, capitalisation...)
  .streamlit\\sec_store      historique du nombre d'actions
  .streamlit\\ticker_info_cache  infos tickers (cache temporaire)
  cache\\                    resultats de portfolios deja calcules (cache temporaire)
  jobs\\                     fichiers des backtests recents (supprimes apres quelques heures)
  montecarlo\\               bases de rendements reels pour le Monte Carlo
  config\\                   liste des adresses du site autorisees
  Complete_Tickers\\         listes de tickers fournies avec le moteur

(Le dossier .streamlit garde ce nom : il est utilise tel quel par le code de calcul d'origine.)
"""


def migrate_layout(home: Path) -> None:
    """Renames the old folder names to the current ones (once) and refreshes the README."""
    for old, new in RENAMED_DIRS.items():
        try:
            if (home / old).is_dir() and not (home / new).exists():
                (home / old).rename(home / new)
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
    os.chdir(home)
    for p in (str(home), str(ENGINE_ROOT)):
        if p not in sys.path:
            sys.path.insert(0, p)
    from backtest_engine.top20 import ensure_table

    ensure_table(home)
    return home
