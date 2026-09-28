"""Momentum backtest engine extracted from the Streamlit Multi-Backtest page."""

from __future__ import annotations

import os
import sys
from pathlib import Path

__version__ = "1.0.0"

# Parallelism comes from worker processes. Multi-threaded BLAS would also
# commit one buffer per core in every process (~1 GB each with 16 cores).
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

ENGINE_ROOT = Path(__file__).resolve().parent.parent


def engine_home() -> Path:
    """Folder holding Complete_Tickers/ and the .streamlit/ price cache.

    The legacy code opens these through relative paths, so the process working
    directory must point here before any backtest runs.
    """
    return Path(os.environ.get("ENGINE_HOME", ENGINE_ROOT)).resolve()


def activate_engine_home() -> Path:
    from backtest_engine.certs import ensure_system_ca_bundle

    ensure_system_ca_bundle(ENGINE_ROOT / ".certs")
    home = engine_home()
    os.chdir(home)
    for p in (str(home), str(ENGINE_ROOT)):
        if p not in sys.path:
            sys.path.insert(0, p)
    return home
