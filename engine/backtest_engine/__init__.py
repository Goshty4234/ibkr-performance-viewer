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
