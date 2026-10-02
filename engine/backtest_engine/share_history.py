"""Shares outstanding over time for the whole US market, from the SEC (not Yahoo).

The SEC "frames" API returns one XBRL fact for every filer in a single request: the cover-page
share count (dei:EntityCommonStockSharesOutstanding) of ~5-6k companies per quarter. About 70
requests cover 2009 to today, once; closed quarters are kept for good, recent ones refreshed
weekly. Counts are as reported (before later splits): callers adjust them with the split
events of the price store.

Multi-class filers (GOOGL, BRK-B...) report per class and are absent: callers keep their
estimate for those.
"""

from __future__ import annotations

import time
from datetime import date, datetime

import diskcache
import pandas as pd

STORE_DIR = ".streamlit/sec_store"
_UA = {"User-Agent": "IBKR Statement Performance Viewer (personal research) contact@ibkr-viewer.local", "Accept-Encoding": "gzip"}
_FRAMES = "https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/CY{y}Q{q}I.json"
_TICKERS = "https://www.sec.gov/files/company_tickers.json"
FIRST_YEAR = 2009
_RECENT_TTL = 7 * 86400
_PAUSE_S = 0.15  # SEC fair use: at most 10 requests per second


def open_store() -> diskcache.Cache:
    return diskcache.Cache(STORE_DIR, size_limit=4 * 2**30, eviction_policy="none")


def _get(url: str) -> dict | None:
    import requests

    r = requests.get(url, headers=_UA, timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    time.sleep(_PAUSE_S)
    return r.json()


def _quarters(today: date) -> list[tuple[int, int]]:
    out = []
    for y in range(FIRST_YEAR, today.year + 1):
        for q in range(1, 5):
            if (y, q) <= (today.year, (today.month - 1) // 3 + 1):
                out.append((y, q))
    return out


def _closed(y: int, q: int, today: date) -> bool:
    """Late filers keep adding facts for a while after the quarter ends."""
    end = date(y + (q == 4), 1 if q == 4 else q * 3 + 1, 1)
    return (today - end).days > 200


def cik_map(store: diskcache.Cache | None = None) -> dict[str, int]:
    store = store or open_store()
    hit = store.get("tickers")
    if hit is None:
        data = _get(_TICKERS) or {}
        hit = {str(v["ticker"]).upper(): int(v["cik_str"]) for v in data.values()}
        store.set("tickers", hit, expire=_RECENT_TTL)
    return hit


def _frame(store: diskcache.Cache, y: int, q: int, today: date) -> list[tuple[int, str, float]]:
    key = f"frame:{y}Q{q}"
    hit = store.get(key)
    if hit is not None:
        return hit
    data = _get(_FRAMES.format(y=y, q=q))
    rows = [(int(r["cik"]), str(r["end"]), float(r["val"])) for r in (data or {}).get("data", []) if r.get("val")]
    store.set(key, rows, expire=None if _closed(y, q, today) else _RECENT_TTL)
    return rows


def histories(tickers: list[str], progress=None) -> dict[str, pd.Series]:
    """{ticker: as-reported share count indexed by the cover-page date}, for the tickers the SEC
    knows. Raises when the SEC cannot be reached (callers then keep their estimate)."""
    store = open_store()
    today = datetime.now().date()
    ciks = cik_map(store)
    wanted = {t: ciks.get(t.upper()) or ciks.get(t.upper().replace(".", "-")) for t in tickers}
    wanted = {t: c for t, c in wanted.items() if c}
    if not wanted:
        return {}
    by_cik: dict[int, dict[str, float]] = {}
    quarters = _quarters(today)
    for n, (y, q) in enumerate(quarters):
        if progress and n % 8 == 0:
            progress(f"SEC share counts {n}/{len(quarters)} quarters...")
        for cik, end, val in _frame(store, y, q, today):
            by_cik.setdefault(cik, {})[end] = val
    out = {}
    for t, cik in wanted.items():
        obs = by_cik.get(cik)
        if obs:
            s = pd.Series(obs, dtype=float)
            s.index = pd.to_datetime(s.index)
            out[t] = s.sort_index()
    return out


def share_ratio(shares: pd.Series, splits: dict[str, float], shares_today: float,
                today: pd.Timestamp | None = None) -> pd.Series | None:
    """shares(date) / shares today (split-adjusted), or None when the SEC series cannot be
    trusted for this ticker: its latest count far from today's (share-class or mapping
    mismatch). Isolated XBRL typos (values in thousands, wrong class) are dropped first."""
    adj = adjust_for_splits(shares, splits)
    med = adj.rolling(5, center=True, min_periods=1).median()
    adj = adj[(adj / med).between(1 / 3, 3)]
    if adj.empty or not shares_today or shares_today <= 0:
        return None
    ratio = adj / float(shares_today)
    if not 0.5 <= ratio.iloc[-1] <= 2.0:
        return None
    today = today if today is not None else pd.Timestamp.now().normalize()
    if ratio.index[-1] < today:
        ratio.loc[today] = 1.0
    return ratio


def adjust_for_splits(shares: pd.Series, splits: dict[str, float]) -> pd.Series:
    """Express counts reported before a split in post-split shares (what the split-adjusted
    Close needs): a 10:1 split multiplies earlier counts by 10."""
    if not splits:
        return shares
    factor = pd.Series(1.0, index=shares.index)
    for day, ratio in splits.items():
        if ratio and ratio > 0:
            factor[shares.index < pd.Timestamp(day)] *= float(ratio)
    return shares * factor
