"""Market context charts: VIX and the 13-week Treasury risk-free rate.

Raw quotes are fetched once in the prepare task (under the download lock)
and stored in the snapshot; the assemble task only slices them to the
results period. The risk-free lookup is a vectorized equivalent of legacy
get_risk_free_rate_robust (last quote on or before each calendar day,
earliest quote before the first one).
"""

from __future__ import annotations

import contextlib
import io
import os
from typing import Any

import numpy as np
import pandas as pd

from ..legacy import multi_backtest as L

RF_SYMBOLS = ("^IRX", "^FVX", "^TNX", "^TYX")


def _naive(s: pd.Series) -> pd.Series:
    if getattr(s.index, "tz", None) is not None:
        s = s.copy()
        s.index = s.index.tz_convert(None)
    return s[~s.index.duplicated(keep="last")].sort_index()


def fetch_market() -> dict[str, Any]:
    if os.environ.get("ENGINE_MARKET_DATA", "1") == "0":
        return {}
    out: dict[str, Any] = {}
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            vix = L.get_ticker_history_with_cache("^VIX", period="max", auto_adjust=False)
            if vix is not None and not vix.empty and "Close" in vix.columns:
                out["vix"] = _naive(vix["Close"].dropna().astype(float))
        except Exception as exc:  # noqa: BLE001
            out["vix_error"] = str(exc)
        for symbol in RF_SYMBOLS:
            try:
                hist = L.get_ticker_history_with_cache(symbol, period="max", auto_adjust=False)
            except Exception:
                continue
            if hist is None or hist.empty or "Close" not in hist.columns:
                continue
            valid = hist[hist["Close"].notnull() & (hist["Close"] > 0)]
            if valid.empty:
                continue
            daily = (1 + valid["Close"].astype(float) / 100.0) ** (1 / 365.25) - 1.0
            out["rf_daily"] = _naive(daily)
            out["rf_symbol"] = symbol
            break
    return out


def rf_daily_on(rf: pd.Series, dates: pd.DatetimeIndex) -> np.ndarray:
    pos = rf.index.searchsorted(dates, side="right") - 1
    vals = rf.to_numpy(dtype=float)
    out = np.where(pos >= 0, vals[np.clip(pos, 0, None)], vals[0])
    return out


def market_payload(raw: dict[str, Any], first: pd.Timestamp, last: pd.Timestamp, axis: Any) -> dict[str, Any]:
    days = pd.date_range(first, last, freq="D")
    out: dict[str, Any] = {"start": first.strftime("%Y-%m-%d"), "end": last.strftime("%Y-%m-%d")}
    vix = raw.get("vix")
    if isinstance(vix, pd.Series) and len(vix):
        s = vix.reindex(vix.index.union(days)).ffill().reindex(days)
        s[days < vix.index[0]] = np.nan
        out["vix"] = axis.encode(s, 2)
        out["vix_first"] = vix.index[0].strftime("%Y-%m-%d")
    rf = raw.get("rf_daily")
    if isinstance(rf, pd.Series) and len(rf):
        daily = rf_daily_on(rf, days)
        annual = ((1 + daily) ** 365.25 - 1) * 100
        out["rf_annual_pct"] = axis.encode(pd.Series(annual, index=days), 5)
        out["rf_symbol"] = raw.get("rf_symbol")
    return out
