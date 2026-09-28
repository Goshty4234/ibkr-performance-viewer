"""Per-portfolio result cache: a portfolio task whose inputs are identical to an
earlier task reuses that task's output instead of re-running the backtest.

The key covers everything the task reads: engine source code, the static
series in Complete_Tickers, Python/pandas/numpy versions, the portfolio
config (a fusion: every regular config), run options, the simulation axis,
the MA columns inherited from earlier portfolios, the universe maps and the
content of every price frame the task loads. Any difference is a miss, so a
hit returns exactly what a fresh run would have produced.

ENGINE_RESULT_CACHE=0 disables it; ENGINE_RESULT_CACHE_MB caps its size.
"""

from __future__ import annotations

import hashlib
import json
import os
import pickle
import sys
import time
from pathlib import Path
from typing import Any

import pandas as pd

from . import engine_home

ENABLED = os.environ.get("ENGINE_RESULT_CACHE", "1").strip().lower() not in ("0", "false", "no", "off")
_MAX_BYTES = int(float(os.environ.get("ENGINE_RESULT_CACHE_MB", "2048")) * 1_000_000)
_MAX_AGE_S = 30 * 86400
_PRUNE_EVERY_S = 600.0

_static: str | None = None
_last_prune = 0.0


def cache_dir() -> Path:
    return engine_home() / ".cache" / "portfolios"


def static_fingerprint() -> str:
    """Engine code + static series + library versions (computed once per process)."""
    global _static
    if _static is None:
        import numpy

        h = hashlib.sha256()
        h.update(f"{sys.version}|{pd.__version__}|{numpy.__version__}".encode())
        roots = (Path(__file__).resolve().parent, engine_home() / "Complete_Tickers")
        for root in roots:
            if not root.exists():
                continue
            for p in sorted(root.rglob("*")):
                if not p.is_file() or "__pycache__" in p.parts or p.suffix in (".pyc", ".part", ".tmp"):
                    continue
                if root == roots[0] and p.suffix != ".py":
                    continue
                h.update(p.relative_to(root).as_posix().encode() + b"\0")
                h.update(p.read_bytes() + b"\0")
        _static = h.hexdigest()
    return _static


def frame_digest(value: Any) -> str:
    """Content hash of one snapshot frame, independent of its in-memory layout."""
    if isinstance(value, str):
        return "s:" + value
    if not isinstance(value, pd.DataFrame):
        return "p:" + hashlib.sha256(pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)).hexdigest()
    h = hashlib.sha256()
    h.update(repr([str(c) for c in value.columns]).encode())
    h.update(repr([str(t) for t in value.dtypes]).encode())
    h.update(repr(value.index.dtype).encode())
    h.update(pd.util.hash_pandas_object(value, index=True).to_numpy().tobytes())
    return h.hexdigest()


def object_digest(value: Any) -> str:
    try:
        text = json.dumps(value, sort_keys=True, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        return hashlib.sha256(pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL)).hexdigest()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def task_key(doc: dict[str, Any]) -> str | None:
    try:
        doc = dict(doc, static=static_fingerprint())
        text = json.dumps(doc, sort_keys=True, default=str, separators=(",", ":"))
    except Exception:  # noqa: BLE001 - an unhashable input simply disables reuse for this task
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _path(key: str) -> Path:
    return cache_dir() / key[:2] / f"{key}.pkl"


def load(key: str) -> dict[str, Any] | None:
    path = _path(key)
    try:
        with open(path, "rb") as fh:
            rec = pickle.load(fh)
    except FileNotFoundError:
        return None
    except Exception:  # noqa: BLE001 - truncated or foreign file
        path.unlink(missing_ok=True)
        return None
    try:
        os.utime(path)
    except OSError:
        pass
    return rec


def save(key: str, rec: dict[str, Any]) -> None:
    path = _path(key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.part")
        with open(tmp, "wb") as fh:
            pickle.dump(rec, fh, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(path)
    except OSError:
        return
    _maybe_prune()


def _maybe_prune() -> None:
    global _last_prune
    now = time.time()
    if now - _last_prune < _PRUNE_EVERY_S:
        return
    _last_prune = now
    files = []
    for p in cache_dir().glob("*/*.pkl"):
        try:
            st = p.stat()
        except OSError:
            continue
        if now - st.st_mtime > _MAX_AGE_S:
            p.unlink(missing_ok=True)
        else:
            files.append((st.st_mtime, st.st_size, p))
    total = sum(s for _, s, _ in files)
    for _, size, p in sorted(files):
        if total <= _MAX_BYTES:
            break
        p.unlink(missing_ok=True)
        total -= size
