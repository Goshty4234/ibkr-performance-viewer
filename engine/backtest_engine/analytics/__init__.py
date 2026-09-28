"""Result analytics computed next to each portfolio task (see pipeline.py).

Every entry point is isolated: a failing analytic is reported inside the
payload and never fails the backtest itself.
"""

from __future__ import annotations

import traceback
from typing import Any

import pandas as pd

from . import holdings, market, today


def _guard(name: str, fn: Any, *args: Any, errors: dict | None = None, default: Any = None) -> Any:
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001
        if errors is not None:
            errors[name] = f"{type(exc).__name__}: {exc}"
            errors.setdefault("_trace", traceback.format_exc(limit=4))
        return default


def _streamlit_tables(cfg: dict, entry: dict, allocations: dict, raw: dict) -> dict:
    h = holdings.streamlit_holdings(cfg, entry, allocations, raw)
    return {"holdings": holdings.holdings_payload(h), "gains": holdings.streamlit_gains(h)}


def portfolio_extras(prep: Any, cfg: dict, outcome: dict, raw: dict, reindexed: dict) -> tuple[dict, dict]:
    if not outcome.get("success"):
        return {}, {}
    errors: dict[str, str] = {}
    entry = outcome["entry"]
    allocations = outcome.get("allocations") or {}
    metrics = outcome.get("metrics") or {}
    fusion = bool(outcome.get("fusion"))
    summary = {
        "today": _guard("today", today.today_block, cfg, entry, metrics, allocations, raw, errors=errors),
        "timer": _guard("timer", today.timer_info, cfg, allocations, getattr(prep, "simulation_index", None), errors=errors),
    }
    detail: dict[str, Any] = {
        "rebalance_compare": _guard("rebalance_compare", today.rebalance_compare, cfg, entry, allocations, raw, fusion,
                                    errors=errors),
        "tax_acb": _guard("tax_acb", holdings.acb_tax, cfg, entry, allocations, reindexed, prep.configs, errors=errors),
    }
    detail.update(_guard("streamlit_tables", _streamlit_tables, cfg, entry, allocations, raw, errors=errors, default={}))
    if errors:
        detail["analytics_errors"] = errors
        summary["analytics_errors"] = [k for k in errors if not k.startswith("_")]
    return summary, detail


def fetch_market() -> dict:
    return _guard("market", market.fetch_market, default={}) or {}


def _period(pieces: list[dict], axis: Any) -> tuple[pd.Timestamp, pd.Timestamp] | None:
    first = last = None
    for p in pieces:
        s = p.get("series") or {}
        values = s.get("with_additions") or []
        if not p.get("ok") or not values:
            continue
        if "offset" in s:
            a, b = axis.index[s["offset"]], axis.index[s["offset"] + len(values) - 1]
        elif s.get("dates"):
            a, b = pd.Timestamp(s["dates"][0]), pd.Timestamp(s["dates"][-1])
        else:
            continue
        first = a if first is None or a < first else first
        last = b if last is None or b > last else last
    return (first, last) if first is not None else None


def market_data(prep: Any, axis: Any, pieces: list[dict]) -> dict:
    raw = getattr(prep, "market", None) or {}
    period = _period(pieces, axis)
    if not raw or period is None:
        return {}
    errors: dict[str, str] = {}
    out = _guard("market", market.market_payload, raw, period[0], period[1], axis, errors=errors, default={}) or {}
    if errors:
        out["error"] = errors.get("market")
    return out


def run_extras(prep: Any, pieces: list[dict], axis: Any) -> dict:
    return {}


def _bench_returns(df: pd.DataFrame, axis: Any, display_start: Any) -> dict | None:
    if "Price_change" in df.columns:
        pc = df["Price_change"]
    elif "Close" in df.columns:
        pc = df["Close"].pct_change(fill_method=None)
    else:
        return None
    pc = pc.dropna()
    lo = axis.index[0] if display_start is None else max(axis.index[0], pd.Timestamp(display_start))
    pc = pc[(pc.index >= lo) & (pc.index <= axis.index[-1])]
    pc = pc[~pc.index.duplicated(keep="last")]
    if pc.empty:
        return None
    start = axis.index.searchsorted(pc.index[0])
    stop = axis.index.searchsorted(pc.index[-1], side="right")
    return axis.encode(pc.reindex(axis.index[start:stop]), 8)


def benchmark_returns(raw: dict, keys: list[str], axis: Any, display_start: Any) -> dict:
    """Raw daily Price_change on the benchmark's own trading days (null elsewhere).

    Streamlit's beta tables use these returns directly, which a forward-filled
    close on the calendar axis cannot reproduce around market holidays.
    """
    out: dict[str, Any] = {}
    for b in keys:
        df = raw.get(b)
        if isinstance(df, pd.DataFrame):
            enc = _guard("benchmark_returns", _bench_returns, df, axis, display_start)
            if enc:
                out[b] = enc
    return out
