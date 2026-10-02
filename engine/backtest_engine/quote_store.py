"""Archive of every Yahoo quote the engine receives (market cap, PE, EPS, dividend yield,
shares, 52-week range, names...).

Yahoo only serves today's values, so each answer is kept as a dated snapshot: from the first
snapshot on, the store holds the history Yahoo does not provide. One quote request covers a
few hundred symbols, so archiving every stored ticker costs a few dozen requests.

    latest:<symbol>   last full quote row (+ "_day")
    day:<YYYY-MM-DD>  every full row received that day, zlib-compressed JSON
    hist:<symbol>     {day: {key numeric fields}} for charts over time
"""

from __future__ import annotations

import json
import zlib
from datetime import datetime
from typing import Any

import diskcache

from . import yahoo as Y

STORE_DIR = ".streamlit/quote_store"
# Asked on top of Yahoo's default set, so funds get their size and every snapshot is complete.
FIELDS = [
    "marketCap", "netAssets", "netExpenseRatio", "ytdReturn", "trailingThreeMonthReturns",
    "trailingPE", "forwardPE", "priceToBook", "bookValue", "sharesOutstanding",
    "impliedSharesOutstanding", "floatShares", "epsTrailingTwelveMonths", "epsForward",
    "epsCurrentYear", "dividendRate", "dividendYield", "trailingAnnualDividendRate",
    "trailingAnnualDividendYield", "dividendDate", "earningsTimestamp", "averageAnalystRating",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "fiftyDayAverage", "twoHundredDayAverage",
    "averageDailyVolume3Month", "averageDailyVolume10Day", "regularMarketPrice",
    "regularMarketVolume", "regularMarketPreviousClose", "regularMarketTime", "longName",
    "shortName", "quoteType", "exchange", "fullExchangeName", "currency", "financialCurrency",
    "firstTradeDateMilliseconds",
]
HISTORY_FIELDS = [
    "marketCap", "netAssets", "trailingPE", "forwardPE", "priceToBook", "sharesOutstanding",
    "epsTrailingTwelveMonths", "epsForward", "dividendYield", "trailingAnnualDividendYield",
    "regularMarketPrice",
]


def open_store() -> diskcache.Cache:
    return diskcache.Cache(STORE_DIR, size_limit=32 * 2**30, eviction_policy="none")


def today() -> str:
    return datetime.now(Y._NY).strftime("%Y-%m-%d")


def _pack(obj: Any) -> bytes:
    return zlib.compress(json.dumps(obj, separators=(",", ":")).encode(), 6)


def _unpack(blob: Any) -> Any:
    return json.loads(zlib.decompress(blob)) if blob else None


def archive(rows: dict[str, dict], day: str | None = None) -> None:
    """Keeps full quote rows (symbol -> row) as today's snapshot."""
    if not rows:
        return
    day = day or today()
    store = open_store()
    with store.transact():
        snap = _unpack(store.get(f"day:{day}")) or {}
        for sym, row in rows.items():
            snap[sym] = {**snap.get(sym, {}), **row}
            store.set(f"latest:{sym}", {**snap[sym], "_day": day})
            key = {f: snap[sym][f] for f in HISTORY_FIELDS if snap[sym].get(f) is not None}
            if key:
                hist = store.get(f"hist:{sym}") or {}
                hist[day] = key
                store.set(f"hist:{sym}", hist)
        store.set(f"day:{day}", _pack(snap))


def latest(symbol: str) -> dict | None:
    return open_store().get(f"latest:{symbol}")


def latest_many(symbols: list[str]) -> dict[str, dict]:
    store = open_store()
    out = {}
    for s in symbols:
        row = store.get(f"latest:{s}")
        if row:
            out[s] = row
    return out


def history(symbol: str) -> dict[str, dict]:
    return open_store().get(f"hist:{symbol}") or {}


def snapshot_missing(symbols: list[str]) -> int:
    """Quotes of the symbols without a snapshot today (Y.quotes archives them). Returns how
    many were asked."""
    store = open_store()
    day = today()
    todo = [s for s in dict.fromkeys(symbols) if (store.get(f"latest:{s}") or {}).get("_day") != day]
    if todo:
        Y.quotes(todo, [])
    return len(todo)
