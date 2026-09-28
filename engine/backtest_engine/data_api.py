"""Small data services behind the engine API: PE ratios, ticker universes, price history.

All calls reuse the legacy disk caches (yfinance / yahooquery / Wikipedia /
Nasdaq Trader) so repeated requests are served locally.
"""

from __future__ import annotations

import contextlib
import io
import pickle
import threading
from pathlib import Path
from typing import Any

import pandas as pd

from . import activate_engine_home
from . import yahoo as Y

_lock = threading.Lock()
_PE_TTL = 12 * 3600
_MISS = object()


def _legacy():
    activate_engine_home()
    from .legacy import multi_backtest as L

    return L


def pe_ratios(tickers: list[str]) -> dict[str, float | None]:
    wanted = [t for t in dict.fromkeys(t.strip() for t in tickers if t and t.strip()) if t != "CASH"]
    out: dict[str, float | None] = {}
    missing = []
    L = _legacy()
    cache = Y.open_cache()
    for t in wanted:
        hit = cache.get(f"__pe__:{t}", default=_MISS)
        if hit is _MISS:
            missing.append(t)
        else:
            out[t] = hit
    if missing:
        with _lock, contextlib.redirect_stdout(io.StringIO()):
            info = L.get_multiple_tickers_info_batch(missing) or {}
        for t in missing:
            pe = (info.get(t) or {}).get("trailingPE")
            try:
                val = float(pe) if pe is not None else None
            except (TypeError, ValueError):
                val = None
            if val is not None and not (val > 0):
                val = None
            if t in info:
                cache.set(f"__pe__:{t}", val, expire=_PE_TTL)
            out[t] = val
    return out


def universe(name: str) -> dict[str, Any]:
    L = _legacy()
    with contextlib.redirect_stdout(io.StringIO()):
        if name == "sp500":
            payload, err = L.fetch_sp500_wikipedia_constituents()
        elif name == "us":
            payload, err = L.fetch_us_listed_common_stocks()
        else:
            raise ValueError(f"Unknown universe: {name}")
    if err or not payload:
        raise RuntimeError(err or "Universe unavailable")
    return {"name": name, "tickers": list(payload.get("tickers") or []), "date_added": payload.get("date_added") or None}


def resolve_tickers(tickers: list[str]) -> dict[str, str]:
    """Legacy alias resolution (SPYSIM -> SPYSIM_COMPLETE, BRK.B -> BRK-B, ...)."""
    L = _legacy()
    return {t: L.resolve_ticker_alias(t.replace(",", ".")) for t in dict.fromkeys(tickers) if t}


def clear_caches() -> dict[str, int]:
    """Empties the downloaded price / info / PE / missing-ticker disk caches."""
    L = _legacy()
    cache = Y.open_cache()
    pe = sum(1 for k in cache.iterkeys() if isinstance(k, str) and k.startswith("__pe__:"))
    with _lock, contextlib.redirect_stdout(io.StringIO()):
        cleared = int(L.clear_all_yahoo_caches() or 0)
    return {"entries": cleared, "pe": pe}


def _from_job(job_dir: Path, ticker: str) -> pd.DataFrame | None:
    meta_path = job_dir / "meta.pkl"
    if not meta_path.exists():
        return None
    with open(meta_path, "rb") as fh:
        meta = pickle.load(fh)
    entry = meta.get("files", {}).get(ticker)
    if not entry or entry[0] != "file":
        return None
    with open(job_dir / "data" / entry[1], "rb") as fh:
        df = pickle.load(fh)
    return df if isinstance(df, pd.DataFrame) else None


def price_history(ticker: str, job_dir: Path | None = None) -> dict[str, Any]:
    ticker = ticker.strip()
    df = _from_job(job_dir, ticker) if job_dir is not None else None
    source = "job"
    if df is None:
        source = "download"
        L = _legacy()
        with contextlib.redirect_stdout(io.StringIO()):
            resolved = L.resolve_ticker_alias(ticker) or ticker
            batch = L.get_multiple_tickers_batch([resolved], period="max", auto_adjust=False)
        df = batch.get(resolved) if isinstance(batch, dict) else None
        if not isinstance(df, pd.DataFrame) or df.empty:
            raise LookupError(f"No price data for {ticker}")
    close = df["Close"].dropna()
    if getattr(close.index, "tz", None) is not None:
        close = close.copy()
        close.index = close.index.tz_localize(None)
    return {
        "ticker": ticker,
        "source": source,
        "dates": [d.strftime("%Y-%m-%d") for d in close.index],
        "close": [round(float(v), 4) for v in close.to_numpy(dtype=float)],
    }
