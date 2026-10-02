"""Permanent per-ticker price store: the engine's ticker database.

Every Yahoo ticker downloaded once is kept in full, without expiry, in the frame and cache
key the legacy code reads ([Close, Dividends], auto_adjust=False, key "<ticker>_max_False").
Its metadata records the stored range and when Yahoo last confirmed the history ("checked").
A run picks a mode:

    stored  use the stored histories as they are (the backtest ends where they end);
            only tickers never downloaded are fetched
    topup   stored tickers not checked since the last market close get only their recent
            days (default)
    full    download every history again

A top-up downloads a few already stored days again: when one of them differs (split,
restatement, Yahoo correction) or a split shows up, the ticker is downloaded again in full,
so a topped-up history always equals a full download.
"""

from __future__ import annotations

import pickle
import time
import zlib
from datetime import datetime, timedelta
from typing import Any, Callable

import numpy as np
import pandas as pd
import yfinance as yf

from . import yahoo as Y

MODES = ("stored", "topup", "full")
# Everything else the chart request returns, kept compressed beside the run frame so runs
# still unpickle only [Close, Dividends]. Adj Close is not kept: it is rewritten by every
# dividend and follows from Close + Dividends.
BARS = ["Open", "High", "Low", "Volume", "Stock Splits"]
CHUNK = 80
PAUSE_S = 1.5
OVERLAP_DAYS = 10
# A top-up group downloads from its oldest last day: tickers stopped long ago get their own group.
GROUP_SPAN_DAYS = 14
RTOL = 1e-6
_COLS = ["Close", "Dividends"]


def meta_key(ticker: str) -> str:
    return f"__meta__:{ticker}"


def bars_key(ticker: str) -> str:
    return f"__bars__:{ticker}"


def _bars(df: Any) -> pd.DataFrame:
    if not isinstance(df, pd.DataFrame) or df.empty:
        return pd.DataFrame(columns=BARS)
    out = df[[c for c in BARS if c in df.columns]].astype(float)
    if getattr(out.index, "tz", None) is not None:
        out.index = out.index.tz_localize(None)
    return out[~out.index.duplicated(keep="last")].sort_index()


def load_bars(store: Any, ticker: str) -> pd.DataFrame | None:
    blob = store.get(bars_key(ticker))
    return pickle.loads(zlib.decompress(blob)) if blob is not None else None


def _save_bars(store: Any, ticker: str, df: pd.DataFrame) -> None:
    store.set(bars_key(ticker), zlib.compress(pickle.dumps(df, protocol=pickle.HIGHEST_PROTOCOL), 6), expire=None)


def last_close(now: datetime | None = None) -> float:
    """Epoch of the most recent settled US close (weekdays; holidays only cost a no-op top-up)."""
    now = (now or datetime.now(Y._NY)).astimezone(Y._NY)
    day = now.replace(hour=Y._SETTLED[0], minute=Y._SETTLED[1], second=0, microsecond=0)
    if now < day:
        day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day.timestamp()


def normalize(df: Any) -> pd.DataFrame:
    """[Close, Dividends] on a tz-naive daily index, the way the runner reads it."""
    if not isinstance(df, pd.DataFrame) or df.empty or "Close" not in df.columns:
        return pd.DataFrame()
    out = df[[c for c in _COLS if c in df.columns]].copy()
    if "Dividends" not in out.columns:
        out["Dividends"] = 0.0
    if getattr(out.index, "tz", None) is not None:
        out.index = out.index.tz_localize(None)
    out = out[~out.index.duplicated(keep="last")].sort_index().dropna(how="all")
    return out


def _meta(df: pd.DataFrame, checked: float, full: float | None, bars: pd.DataFrame | None = None) -> dict:
    meta = {
        "first": df.index[0].strftime("%Y-%m-%d"),
        "last": df.index[-1].strftime("%Y-%m-%d"),
        "rows": int(len(df)),
        "checked": float(checked),
        "full": float(full) if full else None,
        "bars": bars is not None,
    }
    if bars is not None:
        sp = bars["Stock Splits"].fillna(0) if "Stock Splits" in bars.columns else pd.Series(dtype=float)
        meta["splits"] = {d.strftime("%Y-%m-%d"): float(v) for d, v in sp[sp != 0].items()}
    return meta


def describe(store: Any, ticker: str) -> dict | None:
    """Metadata of a stored ticker; entries written before the store existed get theirs here
    (never confirmed, so the next top-up verifies them)."""
    meta = store.get(meta_key(ticker))
    if isinstance(meta, dict):
        return meta
    df = normalize(store.get(Y.price_key(ticker)))
    if df.empty:
        return None
    meta = _meta(df, 0.0, None)
    store.set(meta_key(ticker), meta)
    store.touch(Y.price_key(ticker), expire=None)
    return meta


def status(tickers: list[str], now: datetime | None = None) -> dict:
    store = Y.open_cache()
    lc = last_close(now)
    current = stale = missing = unknown = 0
    stale_last: list[str] = []
    for t in dict.fromkeys(tickers):
        meta = describe(store, t)
        if meta is None:
            if Y.missing_key(t) in store:
                unknown += 1
            else:
                missing += 1
        elif meta["checked"] >= lc:
            current += 1
        else:
            stale += 1
            stale_last.append(meta["last"])
    return {
        "total": current + stale + missing + unknown,
        "current": current,
        "stale": stale,
        "missing": missing,
        "unknown": unknown,
        "stale_oldest_last": min(stale_last) if stale_last else None,
        "stale_newest_last": max(stale_last) if stale_last else None,
    }


def list_stored() -> list[dict]:
    store = Y.open_cache()
    lc = last_close()
    out = []
    for k in list(store.iterkeys()):
        if not (isinstance(k, str) and k.endswith("_max_False")):
            continue
        t = k[: -len("_max_False")]
        if "?" in t:
            continue
        meta = describe(store, t)
        if meta:
            out.append({"ticker": t, **meta, "current": meta["checked"] >= lc})
    return sorted(out, key=lambda r: r["ticker"])


def _split(data: Any, symbol: str, single: bool) -> pd.DataFrame:
    if not isinstance(data, pd.DataFrame) or data.empty:
        return pd.DataFrame()
    cols = data.columns
    if isinstance(cols, pd.MultiIndex):
        if symbol in cols.get_level_values(0):
            return data[symbol]
        if symbol in cols.get_level_values(1):
            return data.xs(symbol, axis=1, level=1)
        return pd.DataFrame()
    return data if single else pd.DataFrame()


def _download(symbols: list[str], start: str | None) -> dict[str, pd.DataFrame]:
    """One yfinance call (one chart request per symbol): Close, Dividends and the bars."""
    kwargs = {"start": start} if start else {"period": "max"}
    data = yf.download(symbols if len(symbols) > 1 else symbols[0], auto_adjust=False, actions=True,
                       progress=False, group_by="ticker", threads=True, **kwargs)
    out = {}
    for s in symbols:
        df = _split(data, s, len(symbols) == 1)
        if df.empty or "Close" not in df.columns:
            continue
        keep = [c for c in ("Close", "Dividends", *BARS) if c in df.columns]
        df = df[keep].dropna(how="all")
        df = df[df[[c for c in _COLS if c in df.columns]].notna().any(axis=1)]
        if getattr(df.index, "tz", None) is not None:
            df.index = df.index.tz_localize(None)
        if not df.empty:
            out[s] = df
    return out


def _consistent(old: pd.DataFrame, new: pd.DataFrame) -> bool:
    """The re-downloaded days match what is stored and no split happened since: appending is
    then exactly a full download. The last stored bar may have been taken during the session,
    so it is not compared."""
    if "Stock Splits" in new.columns and (new["Stock Splits"].fillna(0) != 0).any():
        return False
    days = old.index[(old.index >= new.index[0]) & (old.index < old.index[-1])]
    if len(days) == 0 or not days.isin(new.index).all():
        return False
    a, b = old.loc[days], new.loc[days]
    close_ok = np.allclose(a["Close"].to_numpy(float), b["Close"].to_numpy(float), rtol=RTOL, atol=0, equal_nan=True)
    div_ok = np.allclose(a["Dividends"].fillna(0).to_numpy(float), b["Dividends"].fillna(0).to_numpy(float), rtol=RTOL, atol=1e-12)
    return bool(close_ok and div_ok)


def update(tickers: dict[str, str], mode: str = "topup", *, lock: Any = None,
           progress: Callable[[str], None] | None = None, check_cancelled: Callable[[], None] | None = None,
           on_wait: Callable[[float], None] | None = None) -> tuple[dict[str, pd.DataFrame], dict]:
    """tickers: stored symbol -> Yahoo symbol (alias resolved). Returns the frames (empty for
    unknown tickers) and a report of what came from where."""
    import contextlib

    mode = mode if mode in MODES else "topup"
    store = Y.open_cache()
    lc = last_close()
    say = progress or (lambda _m: None)
    check = check_cancelled or (lambda: None)
    frames: dict[str, pd.DataFrame] = {}
    topup: list[tuple[str, dict]] = []
    full: list[str] = []
    # Full downloads already counted as refetched / upgraded, not counted again as "downloaded".
    counted: set[str] = set()
    report = {"mode": mode, "stored": 0, "topped_up": 0, "refetched": 0, "downloaded": 0, "unknown": 0,
              "unchanged": 0, "failed": 0, "upgraded": 0, "yahoo_symbols": 0, "rows_downloaded": 0, "rate_limited": False}
    for t in tickers:
        if mode == "full":
            full.append(t)
            continue
        meta = describe(store, t)
        if meta is None:
            if Y.missing_key(t) in store:
                frames[t] = pd.DataFrame()
                report["unknown"] += 1
            else:
                full.append(t)
        elif mode == "stored" or meta["checked"] >= lc:
            frames[t] = normalize(store.get(Y.price_key(t)))
            report["stored"] += 1
        elif not meta.get("bars"):
            # Stored before the bars were kept: one full download completes it for good.
            full.append(t)
            counted.add(t)
            report["upgraded"] += 1
        else:
            topup.append((t, meta))

    def network(symbols: list[str], start: str | None) -> dict[str, pd.DataFrame]:
        with Y.rate_limit_retry(on_wait) as retry:
            got = _download(symbols, start)
        report["yahoo_symbols"] += len(symbols)
        report["rows_downloaded"] += sum(len(df) for df in got.values())
        report["rate_limited"] = report["rate_limited"] or retry.rate_limited
        return got

    def save(t: str, df: pd.DataFrame, bars: pd.DataFrame, full_at: float | None) -> None:
        store.set(Y.price_key(t), df, expire=None)
        _save_bars(store, t, bars)
        store.set(meta_key(t), _meta(df, time.time(), full_at, bars=bars))

    topup.sort(key=lambda x: x[1]["last"])
    groups: list[list[tuple[str, dict]]] = []
    for item in topup:
        g = groups[-1] if groups else None
        if g is None or len(g) >= CHUNK or pd.Timestamp(item[1]["last"]) - pd.Timestamp(g[0][1]["last"]) > pd.Timedelta(days=GROUP_SPAN_DAYS):
            groups.append([item])
        else:
            g.append(item)
    done = 0
    for n, group in enumerate(groups):
        check()
        say(f"Updating recent days for {len(topup)} stored tickers ({done}/{len(topup)})...")
        done += len(group)
        with lock if lock is not None else contextlib.nullcontext():
            todo = []
            for t, meta in group:
                fresh = store.get(meta_key(t))
                if isinstance(fresh, dict) and fresh["checked"] >= lc:
                    frames[t] = normalize(store.get(Y.price_key(t)))
                    report["stored"] += 1
                else:
                    todo.append((t, meta))
            if todo:
                start = (pd.Timestamp(min(m["last"] for _, m in todo)) - pd.Timedelta(days=OVERLAP_DAYS)).strftime("%Y-%m-%d")
                got = network(list(dict.fromkeys(tickers[t] for t, _ in todo)), start)
                for t, meta in todo:
                    old = normalize(store.get(Y.price_key(t)))
                    new = got.get(tickers[t])
                    if not got:
                        # Nothing came back for the whole group: Yahoo unreachable, not "no new day".
                        frames[t] = old
                        report["failed"] += 1
                        continue
                    if new is None or new.empty:
                        frames[t] = old
                        if not report["rate_limited"]:
                            store.set(meta_key(t), {**meta, "checked": time.time()})
                            report["unchanged"] += 1
                        continue
                    if not _consistent(old, new):
                        full.append(t)
                        counted.add(t)
                        report["refetched"] += 1
                        continue
                    merged = pd.concat([old[old.index < new.index[0]], normalize(new)])
                    old_bars = load_bars(store, t)
                    if old_bars is None:
                        full.append(t)
                        counted.add(t)
                        report["upgraded"] += 1
                        continue
                    bars = pd.concat([old_bars[old_bars.index < new.index[0]], _bars(new)])
                    save(t, merged, bars, meta.get("full"))
                    frames[t] = merged
                    report["topped_up"] += 1
        if n + 1 < len(groups):
            if lock is not None:
                lock.yield_to_waiters()
            time.sleep(PAUSE_S * len(group) / CHUNK)

    for i in range(0, len(full), CHUNK):
        check()
        chunk = full[i:i + CHUNK]
        say(f"Downloading full history for {len(full)} tickers ({i}/{len(full)})...")
        with lock if lock is not None else contextlib.nullcontext():
            got = network(list(dict.fromkeys(tickers[t] for t in chunk)), None)
            now = time.time()
            for t in chunk:
                raw = got.get(tickers[t])
                df = normalize(raw)
                if df.empty and not got:
                    old = normalize(store.get(Y.price_key(t)))
                    frames[t] = old
                    report["failed"] += 1
                    continue
                if df.empty:
                    frames[t] = pd.DataFrame()
                    report["unknown"] += 1
                    if got and not report["rate_limited"]:
                        store.set(Y.missing_key(t), True, expire=Y.MISSING_TTL)
                    continue
                save(t, df, _bars(raw), now)
                frames[t] = df
                if t not in counted:
                    report["downloaded"] += 1
        if lock is not None and i + CHUNK < len(full):
            lock.yield_to_waiters()
        if i + CHUNK < len(full):
            time.sleep(PAUSE_S)

    if mode != "stored":
        known = [tickers[t] for t, df in frames.items() if isinstance(df, pd.DataFrame) and not df.empty]
        if known:
            say(f"Archiving today's quotes (market cap, PE...) for {len(known)} tickers...")
            try:
                from . import quote_store

                report["quotes"] = quote_store.snapshot_missing(known)
            except Exception:
                report["quotes"] = 0
    return frames, report
