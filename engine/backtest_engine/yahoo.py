"""Yahoo Finance hygiene shared by the backtest download and the data services.

- `smart_ttl`: daily bars only change while the US market is open, so a price
  fetched after the close stays valid until the next open instead of the
  legacy fixed 4 hours (24/7 assets such as crypto keep the 4-hour rule).
- `rate_limit_retry`: wraps `yf.download` so a chunk refused with "Too Many
  Requests" is retried with a back-off instead of falling through to one
  request per ticker.
- missing markers: tickers Yahoo does not know are remembered for a while so
  every run does not ask for them again.
"""

from __future__ import annotations

import contextlib
import time
from datetime import datetime, timedelta
from typing import Any, Iterator
from zoneinfo import ZoneInfo

import yfinance as yf

CACHE_DIR = ".streamlit/ticker_cache"
LEGACY_TTL = 4 * 3600
MIN_TTL = 30 * 60
MISSING_TTL = 12 * 3600
_NY = ZoneInfo("America/New_York")
_OPEN = (9, 30)
_SETTLED = (16, 20)  # final daily bar is published a few minutes after the 16:00 close
_BACKOFF_S = (3.0, 10.0, 30.0)


def _is_round_the_clock(ticker: str) -> bool:
    t = ticker.upper()
    return t.endswith("-USD") or t.endswith("=X") or t.endswith("=F")


def smart_ttl(ticker: str = "", now: datetime | None = None) -> int:
    """Seconds a freshly downloaded daily history can be served from cache."""
    if _is_round_the_clock(ticker):
        return LEGACY_TTL
    now = (now or datetime.now(_NY)).astimezone(_NY)
    day_open = now.replace(hour=_OPEN[0], minute=_OPEN[1], second=0, microsecond=0)
    settled = now.replace(hour=_SETTLED[0], minute=_SETTLED[1], second=0, microsecond=0)
    if now.weekday() < 5 and day_open <= now < settled:
        return int(max(MIN_TTL, min(LEGACY_TTL, (settled - now).total_seconds())))
    nxt = day_open if now < day_open else day_open + timedelta(days=1)
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)
    return int(max(MIN_TTL, (nxt - now).total_seconds()))


def open_cache():
    import diskcache

    return diskcache.Cache(CACHE_DIR)


def price_key(ticker: str) -> str:
    """Key used by the legacy get_multiple_tickers_batch (period max, auto_adjust False)."""
    return f"{ticker}_max_False"


def missing_key(ticker: str) -> str:
    return f"__missing__:{ticker}"


def _rate_limited() -> bool:
    errors = getattr(getattr(yf, "shared", None), "_ERRORS", None) or {}
    text = " ".join(str(v) for v in errors.values()).lower()
    return "rate limit" in text or "too many requests" in text


class RetryState:
    def __init__(self) -> None:
        self.rate_limited = False
        self.retries = 0


_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
_QUOTE_CHUNK = 200


def quotes(symbols: list[str], fields: list[str]) -> dict[str, dict]:
    """Yahoo's quote endpoint answers for up to a few hundred symbols per request, where the
    quoteSummary modules (yahooquery) cost one request per symbol. Unknown symbols are absent."""
    from yfinance.data import YfData

    out: dict[str, dict] = {}
    data = YfData()
    wanted = list(dict.fromkeys(s for s in symbols if s))
    for i in range(0, len(wanted), _QUOTE_CHUNK):
        chunk = wanted[i:i + _QUOTE_CHUNK]
        payload = data.get_raw_json(_QUOTE_URL, params={"symbols": ",".join(chunk), "fields": ",".join(["symbol", *fields])})
        for row in ((payload or {}).get("quoteResponse") or {}).get("result") or []:
            if row.get("symbol"):
                out[row["symbol"]] = row
        if i + _QUOTE_CHUNK < len(wanted):
            time.sleep(1.0)
    return out


@contextlib.contextmanager
def rate_limit_retry(on_wait=None) -> Iterator[RetryState]:
    """Temporarily wraps whatever `yf.download` currently is (real or test replay)."""
    state = RetryState()
    inner = yf.download

    def download(*args: Any, **kwargs: Any):
        result = inner(*args, **kwargs)
        for delay in _BACKOFF_S:
            if not _rate_limited():
                return result
            state.retries += 1
            if on_wait:
                on_wait(delay)
            time.sleep(delay)
            result = inner(*args, **kwargs)
        state.rate_limited = _rate_limited()
        return result

    yf.download = download
    try:
        yield state
    finally:
        if yf.download is download:
            yf.download = inner
