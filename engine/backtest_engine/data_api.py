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


def _batched_pe(L: Any, tickers: list[str]) -> dict[str, dict] | None:
    """PE of the underlying Yahoo symbol (leverage suffix stripped, alias resolved), fetched a
    few hundred symbols per request. None when Yahoo refuses, so the caller can fall back."""
    resolved: dict[str, str] = {}
    for t in tickers:
        try:
            base, _ = L.parse_leverage_ticker(t)
            resolved[t] = L.resolve_ticker_alias(base)
        except Exception:
            resolved[t] = t
    try:
        rows = Y.quotes(list(set(resolved.values())), ["trailingPE"])
    except Exception:
        return None
    if not rows:
        return None
    return {t: {"trailingPE": (rows.get(r) or {}).get("trailingPE")} for t, r in resolved.items()}


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
            info = _batched_pe(L, missing)
            if info is None:
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
    """Empties the short-lived caches (quotes, market caps, PE, missing-ticker markers, lists).
    The ticker store (full price histories and their metadata) is kept: bringing it up to date
    is the job of the top-up / full re-download modes."""
    from . import price_store

    _legacy()
    cache = Y.open_cache()
    pe = cleared = 0
    with _lock:
        for k in list(cache.iterkeys()):
            if isinstance(k, str) and (k.startswith(("__meta__:", "__bars__:")) or (k.endswith("_max_False") and "?" not in k)):
                continue
            pe += isinstance(k, str) and k.startswith("__pe__:")
            cleared += cache.delete(k)
        import diskcache

        info = diskcache.Cache("marketdata/ticker_info_temp")
        cleared += len(info)
        info.clear()
    return {"entries": cleared, "pe": pe, "kept": len(price_store.list_stored())}


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


def _store_symbols(tickers: list[str]) -> tuple[dict[str, str], list[str], list[str]]:
    _legacy()
    from .runner import yahoo_symbols

    with contextlib.redirect_stdout(io.StringIO()):
        return yahoo_symbols(tickers)


def store_status(tickers: list[str]) -> dict[str, Any]:
    from . import price_store

    bases, _local, _derived = _store_symbols(tickers)
    return price_store.status(list(bases))


def store_list() -> list[dict]:
    """Stored tickers with their range and, from the last archived quote, name / type / market
    cap / PE."""
    from . import price_store, quote_store

    # The stores are opened through paths relative to the data home. Every other entry point switches
    # to it through _legacy(); this one never did, so asked first after a start it read the (empty)
    # folder the engine was launched from: "0 tickers".
    activate_engine_home()
    rows = price_store.list_stored()
    quotes = quote_store.latest_many([r["ticker"] for r in rows])
    for r in rows:
        q = quotes.get(r["ticker"]) or {}
        r["name"] = q.get("longName") or q.get("shortName")
        r["type"] = q.get("quoteType")
        cap = q.get("marketCap") if q.get("marketCap") is not None else q.get("netAssets")
        r["market_cap"] = cap
        r["pe"] = q.get("trailingPE")
        r["quote_day"] = q.get("_day")
    return rows


def quote_info(ticker: str, refresh: bool = False) -> dict[str, Any]:
    """Last archived quote of a ticker (all fields) and the archived history of its key
    figures. refresh asks Yahoo for today's quote first."""
    from . import quote_store

    bases, _local, _derived = _store_symbols([ticker.strip()])
    symbol = next(iter(bases.values()), ticker.strip())
    if refresh:
        Y.quotes([symbol], [])
    hist = quote_store.history(symbol)
    days = sorted(hist)
    return {
        "ticker": ticker,
        "symbol": symbol,
        "latest": quote_store.latest(symbol),
        "history": {
            "dates": days,
            "fields": {f: [hist[d].get(f) for d in days] for f in quote_store.HISTORY_FIELDS},
        },
    }


def store_update(tickers: list[str], mode: str) -> dict[str, Any]:
    from . import price_store

    bases, _local, _derived = _store_symbols(tickers)
    from .pipeline import download_lock

    _frames, report = price_store.update(bases, mode, lock=download_lock())
    return report


def price_frames(tickers: list[str], mode: str = "stored") -> tuple[dict[str, pd.DataFrame], dict]:
    """[Close, Dividends] frames the way a run gets them: ticker store for Yahoo symbols,
    legacy loader for local series, leveraged variants derived from their stored base."""
    from . import price_store
    from .pipeline import download_lock
    from .runner import _derive_leveraged

    bases, local, derived = _store_symbols(tickers)
    frames, report = price_store.update(bases, mode, lock=download_lock())
    out: dict[str, pd.DataFrame] = {t: df for t, df in frames.items() if t in tickers}
    if local:
        L = _legacy()
        with _lock, contextlib.redirect_stdout(io.StringIO()):
            batch = L.get_multiple_tickers_batch(local, period="max", auto_adjust=False) or {}
        out.update({t: df for t, df in batch.items() if isinstance(df, pd.DataFrame)})
    if derived:
        L = _legacy()
        for t in derived:
            base, _, _ = L.parse_ticker_parameters(t)
            out[t] = _derive_leveraged(t, frames.get(base))
    return out, report


def _bars_payload(ticker: str, index: pd.DatetimeIndex) -> dict[str, list] | None:
    from . import price_store

    bars = price_store.load_bars(Y.open_cache(), ticker)
    if bars is None or bars.empty:
        return None
    bars = bars.reindex(index)

    def col(name: str, digits: int) -> list:
        if name not in bars.columns:
            return [None] * len(index)
        return [None if v != v else round(float(v), digits) for v in bars[name].to_numpy(dtype=float)]

    return {"open": col("Open", 4), "high": col("High", 4), "low": col("Low", 4), "volume": col("Volume", 0)}


def price_history(ticker: str, job_dir: Path | None = None, mode: str = "stored", bars: bool = False) -> dict[str, Any]:
    """Close history of a ticker: from a job snapshot, else from the ticker store (downloaded
    in full the first time; mode "topup" brings a stored one up to date). bars adds the stored
    open / high / low / volume aligned on the close dates."""
    from . import price_store

    ticker = ticker.strip()
    df = _from_job(job_dir, ticker) if job_dir is not None else None
    source = "job"
    meta = None
    if df is None:
        frames, report = price_frames([ticker], mode)
        df = frames.get(ticker)
        source = "download" if report["downloaded"] else "store"
        meta = price_store.describe(Y.open_cache(), ticker)
        if not isinstance(df, pd.DataFrame) or df.empty:
            raise LookupError(f"No price data for {ticker}")
    close = df["Close"].dropna()
    if getattr(close.index, "tz", None) is not None:
        close = close.copy()
        close.index = close.index.tz_localize(None)
    divs = df["Dividends"] if "Dividends" in df.columns else None
    paid = divs[divs.fillna(0) > 0] if divs is not None else None
    return {
        "ticker": ticker,
        "source": source,
        "meta": meta,
        "dates": [d.strftime("%Y-%m-%d") for d in close.index],
        "close": [round(float(v), 4) for v in close.to_numpy(dtype=float)],
        "dividends": None if paid is None else {
            "dates": [d.strftime("%Y-%m-%d") for d in (paid.index.tz_localize(None) if getattr(paid.index, "tz", None) is not None else paid.index)],
            "amounts": [round(float(v), 6) for v in paid.to_numpy(dtype=float)],
        },
        "bars": _bars_payload(ticker, close.index) if bars and source != "job" else None,
    }
