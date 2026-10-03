"""Shares outstanding over time for the whole US market, from the SEC (not Yahoo).

The SEC "frames" API returns one XBRL fact for every filer in a single request. Two facts are
used, per calendar quarter since 2009:
- dei:EntityCommonStockSharesOutstanding, the cover-page count (~5-6k companies);
- us-gaap:WeightedAverageNumberOfSharesOutstandingBasic, all classes together, for the filers
  without a single cover-page count (multi-class: META, GOOGL, PLTR, DELL...). Quarterly frames,
  annual ones where a filer only reports the full year.
About 160 requests cover 2009 to today, once. Closed quarters are kept for good, recent ones
refreshed at most weekly, and a stored frame is reused when the SEC cannot be reached.
Counts are as reported (before later splits): callers adjust them with the split events of
the price store. IFRS filers (AZN, NVO, BP...) and funds are absent: callers keep their estimate.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

import diskcache
import pandas as pd

STORE_DIR = "marketdata/sec_store"
_UA = {"User-Agent": "IBKR Statement Performance Viewer (personal research) contact@ibkr-viewer.local", "Accept-Encoding": "gzip"}
_FRAMES = "https://data.sec.gov/api/xbrl/frames/{tax}/{tag}/shares/{period}.json"
_TICKERS = "https://www.sec.gov/files/company_tickers.json"
_COVER = ("dei", "EntityCommonStockSharesOutstanding")
_WEIGHTED = ("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic")
FIRST_YEAR = 2009
_RECENT_TTL = 7 * 86400
_PAUSE_S = 0.15
_WORKERS = 3  # with the pause: well under the SEC fair-use limit of 10 requests per second


def open_store() -> diskcache.Cache:
    return diskcache.Cache(STORE_DIR, size_limit=4 * 2**30, eviction_policy="none")


def _get(url: str) -> dict | None:
    import requests

    r = requests.get(url, headers=_UA, timeout=60)
    time.sleep(_PAUSE_S)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


def _quarters(today: date) -> list[tuple[int, int]]:
    current = (today.year, (today.month - 1) // 3 + 1)
    return [(y, q) for y in range(FIRST_YEAR, today.year + 1) for q in range(1, 5) if (y, q) <= current]


def _closed(period_end: date, today: date) -> bool:
    """Late filers keep adding facts for a while after the period ends."""
    return (today - period_end).days > 200


def _periods(today: date) -> list[tuple[str, str, date]]:
    """(store key, url, period end) of every frame used."""
    out = []
    for y, q in _quarters(today):
        end = date(y + (q == 4), 1 if q == 4 else q * 3 + 1, 1)
        out.append((f"cover:{y}Q{q}", _FRAMES.format(tax=_COVER[0], tag=_COVER[1], period=f"CY{y}Q{q}I"), end))
        out.append((f"weighted:{y}Q{q}", _FRAMES.format(tax=_WEIGHTED[0], tag=_WEIGHTED[1], period=f"CY{y}Q{q}"), end))
    for y in range(FIRST_YEAR, today.year + 1):
        out.append((f"weighted:{y}", _FRAMES.format(tax=_WEIGHTED[0], tag=_WEIGHTED[1], period=f"CY{y}"), date(y + 1, 1, 1)))
    return out


def _fresh(hit) -> bool:
    return isinstance(hit, dict) and (hit.get("closed") or time.time() - hit.get("at", 0) < _RECENT_TTL)


def cik_map(store: diskcache.Cache | None = None) -> dict[str, int]:
    store = store or open_store()
    hit = store.get("tickers")
    if _fresh(hit):
        return hit["map"]
    try:
        data = _get(_TICKERS) or {}
    except Exception:
        if isinstance(hit, dict):
            return hit["map"]
        raise
    mapping = {str(v["ticker"]).upper(): int(v["cik_str"]) for v in data.values()}
    store.set("tickers", {"map": mapping, "at": time.time(), "closed": False})
    return mapping


def _frames(store: diskcache.Cache, today: date, progress=None) -> dict[str, list[tuple[int, str, float]]]:
    """{store key: [(cik, end, value)]}, downloading only missing or stale frames. A frame the
    SEC fails to return keeps its stored copy; with no copy at all the error propagates."""
    periods = _periods(today)
    stored = {key: store.get(key) for key, _, _ in periods}
    todo = [(key, url, end) for key, url, end in periods if not _fresh(stored[key])]

    def fetch(item):
        key, url, end = item
        try:
            data = _get(url)
        except Exception:
            if isinstance(stored[key], dict):
                return key, stored[key]
            raise
        rows = [(int(r["cik"]), str(r["end"]), float(r["val"])) for r in (data or {}).get("data", []) if r.get("val")]
        entry = {"rows": rows, "at": time.time(), "closed": _closed(end, today)}
        store.set(key, entry)
        return key, entry

    if todo:
        if progress:
            progress(f"SEC share counts: downloading {len(todo)} quarterly files...")
        with ThreadPoolExecutor(_WORKERS) as pool:
            for key, entry in pool.map(fetch, todo):
                stored[key] = entry
    return {key: entry["rows"] for key, entry in stored.items() if isinstance(entry, dict)}


_MEMO: dict = {}
_MEMO_TTL = 6 * 3600


def _merged(store: diskcache.Cache, progress=None) -> tuple[dict, dict, dict]:
    """{cik: {end: shares}} for cover counts, quarterly and annual weighted averages. Unpickling
    the ~160 frames takes seconds: the engine process keeps the merge for a few hours."""
    if _MEMO and time.time() - _MEMO["at"] < _MEMO_TTL:
        return _MEMO["data"]
    cover: dict[int, dict[str, float]] = {}
    weighted: dict[int, dict[str, float]] = {}
    annual: dict[int, dict[str, float]] = {}
    for key, rows in _frames(store, datetime.now().date(), progress).items():
        target = cover if key.startswith("cover:") else weighted if "Q" in key else annual
        for cik, end, val in rows:
            target.setdefault(cik, {})[end] = val
    _MEMO.update(at=time.time(), data=(cover, weighted, annual))
    return cover, weighted, annual


def histories(tickers: list[str], progress=None) -> dict[str, pd.Series]:
    """{ticker: as-reported share count indexed by date}, for the tickers the SEC knows: the
    cover-page count, else the weighted average of all classes. Raises when the SEC cannot be
    reached and nothing is stored yet (callers then keep their estimate)."""
    store = open_store()
    ciks = cik_map(store)
    wanted = {t: ciks.get(t.upper()) or ciks.get(t.upper().replace(".", "-")) for t in tickers}
    wanted = {t: c for t, c in wanted.items() if c}
    if not wanted:
        return {}
    cover, weighted, annual = _merged(store, progress)
    out = {}
    for t, cik in wanted.items():
        obs, source = cover.get(cik), "cover"
        if not obs:
            obs, source = {**annual.get(cik, {}), **weighted.get(cik, {})}, "weighted"
        if obs:
            out[t] = _series(obs, source)
    return out


def _series(obs: dict[str, float], source: str) -> pd.Series:
    s = pd.Series(obs, dtype=float)
    s.index = pd.to_datetime(s.index)
    s = s.sort_index()
    s.attrs["source"] = source
    return s


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
    Close needs): a 10:1 split multiplies earlier counts by 10.

    Cover-page counts are never restated: every split after the date applies. Weighted averages
    come from the latest filing covering the period, and filings restate the comparative periods
    of the last one to three years: a given point may already include some later splits. Walking
    back from today, each point takes the adjustment (none, or all splits up to one of the later
    split dates) that lands closest to the next point."""
    events = sorted((pd.Timestamp(d), float(r)) for d, r in (splits or {}).items() if r and r > 0 and r != 1)
    if not events or shares.empty:
        return shares
    if shares.attrs.get("source") != "weighted":
        factor = pd.Series(1.0, index=shares.index)
        for day, ratio in events:
            factor[shares.index < day] *= ratio
        return shares * factor
    import math

    values = shares.to_numpy(dtype=float)
    dates = shares.index
    out = values.copy()
    later = None
    for i in range(len(values) - 1, -1, -1):
        after = [r for d, r in events if d > dates[i]]
        candidates = [math.prod(after[:k]) for k in range(len(after) + 1)]
        if later is None:
            out[i] = values[i] * candidates[-1]
        else:
            out[i] = min((values[i] * c for c in candidates), key=lambda v: abs(math.log(v / later)) if v > 0 else math.inf)
        later = out[i] if out[i] > 0 else later
    res = pd.Series(out, index=dates)
    res.attrs = dict(shares.attrs)
    return res
