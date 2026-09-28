"""Rebalance-as-of-today, rebalancing timer and last-rebalance comparison.

Transcribes the selected-portfolio blocks of 1_Multi_Backtest.py: today's
weights come from the latest momentum metrics (or the normalized config
allocations), share counts are rounded to 0.1 at the latest close, and the
timer's last rebalance date is inferred from the allocation date pattern.
"""

from __future__ import annotations

import math
from typing import Any

import pandas as pd

from ..serialize import date_key
from .dates import dates_by_freq
from .holdings import alloc_value

TIMER_FREQ_MAP = {
    "monthly": "month",
    "weekly": "week",
    "bi-weekly": "2weeks",
    "biweekly": "2weeks",
    "quarterly": "3months",
    "semi-annually": "6months",
    "semiannually": "6months",
    "annually": "year",
    "yearly": "year",
    "market_day": "market_day",
    "calendar_day": "calendar_day",
    "never": "none",
    "none": "none",
}

COMPARE_FREQ_MAP = {
    "monthly": "Monthly",
    "weekly": "Weekly",
    "bi-weekly": "Biweekly",
    "biweekly": "Biweekly",
    "quarterly": "Quarterly",
    "semi-annually": "Semiannually",
    "semiannually": "Semiannually",
    "annually": "Annually",
    "yearly": "Annually",
    "never": "Never",
    "none": "Never",
}


def _num(x: Any) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def portfolio_value(entry: dict) -> float:
    wa = entry.get("with_additions")
    if isinstance(wa, pd.Series) and len(wa):
        v = wa.iloc[-1]
        if not pd.isna(v) and v > 0:
            return float(v)
    na = entry.get("no_additions")
    if isinstance(na, pd.Series) and len(na):
        v = na.iloc[-1]
        if not pd.isna(v) and v > 0:
            return float(v)
    return 10000.0


def today_weights(cfg: dict, metrics: dict) -> dict[str, float]:
    weights: dict[str, Any] = {}
    if cfg.get("use_momentum", True):
        if metrics:
            latest = metrics[max(metrics.keys())]
            for t, tm in (latest or {}).items():
                if isinstance(tm, dict) and "Calculated_Weight" in tm:
                    w = tm.get("Calculated_Weight", 0)
                    try:
                        keep = w > 0
                    except TypeError:
                        keep = False
                    if keep:
                        weights[t] = w
            # Summed in the metric's own dtype (float32 weights can total exactly 1.0).
            total = sum(weights.values())
            if total < 1.0:
                weights["CASH"] = 1.0 - total
            weights = {k: float(v) for k, v in weights.items()}
    else:
        stocks = cfg.get("stocks") or []
        total = sum(s.get("allocation", 0) for s in stocks if s.get("ticker"))
        if total > 0:
            for s in stocks:
                t = (s.get("ticker") or "").strip()
                a = s.get("allocation", 0)
                if t and a > 0:
                    weights[t] = a / total
    return weights


def pie(weights: dict) -> list[list]:
    """(label, percent) sorted like the Streamlit pies, positive weights only."""
    out = []
    for k, v in sorted(weights.items(), key=lambda x: (-_sort_key(x[1]), x[0])):
        val = _num(v)
        if val is not None and val * 100 > 0:
            out.append([k, round(val * 100, 6)])
    return out


def _sort_key(v: Any) -> float:
    n = _num(v)
    return n if n is not None else 0.0


def _price_on_or_before(close: pd.Series, date: pd.Timestamp) -> float | None:
    try:
        avail = close.index[close.index <= date]
        if len(avail):
            return float(close.loc[avail[-1]])
    except Exception:
        return None
    return None


def allocation_table(alloc: dict, price_date: pd.Timestamp | None, pv: float, raw: dict,
                     exclude: set[str] | None = None) -> dict[str, Any] | None:
    if not alloc:
        return None
    rows = []
    for tk in sorted(k for k in alloc.keys() if not (exclude and k in exclude)):
        try:
            pct = alloc_value(alloc.get(tk, 0))
        except (TypeError, ValueError):
            pct = 0.0
        price = None
        if tk == "CASH":
            shares = 0.0
            value = pv * pct
        else:
            df = raw.get(tk)
            if isinstance(df, pd.DataFrame) and "Close" in df.columns and not df["Close"].dropna().empty:
                if price_date is None:
                    try:
                        price = float(df["Close"].iloc[-1])
                    except Exception:
                        price = None
                else:
                    price = _price_on_or_before(df["Close"], price_date)
            if price and price > 0:
                shares = round(pv * pct / price, 1)
                value = shares * price
            else:
                shares = 0.0
                value = pv * pct
        rows.append({
            "ticker": tk,
            "alloc_pct": pct * 100,
            "price": _num(price),
            "shares": float(shares),
            "value": value,
            "pct": (value / pv * 100) if pv > 0 else 0,
        })
    cash = next((r for r in rows if r["ticker"] == "CASH"), None)
    show_cash = bool(cash and cash["value"] and not pd.isna(cash["value"]) and cash["value"] != 0)
    shown = [r for r in rows if r["ticker"] != "CASH" or show_cash]
    total = {
        "alloc_pct": sum(r["alloc_pct"] for r in shown),
        "value": sum(r["value"] for r in shown),
        "pct": sum(r["pct"] for r in shown),
    }
    return {"rows": [{k: (round(v, 6) if isinstance(v, float) else v) for k, v in r.items()} for r in shown],
            "total": {k: round(v, 6) for k, v in total.items()},
            "cash_shown": show_cash}


def timer_info(cfg: dict, allocations: dict) -> dict[str, Any] | None:
    dates = sorted(allocations.keys())
    if not dates:
        return None
    freq = cfg.get("rebalancing_frequency", "none") or "none"
    f = str(freq).lower()
    if f in ("annually", "yearly", "year"):
        reb = [d for d in dates if d.month == 1 and d.day == 1]
    elif f in ("monthly", "month"):
        reb = [d for d in dates if d.day == 1]
    elif f in ("quarterly", "3months"):
        reb = [d for d in dates if d.month in (1, 4, 7, 10) and d.day == 1]
    elif f in ("semi-annually", "semiannually", "6months"):
        reb = [d for d in dates if d.month in (1, 7) and d.day == 1]
    else:
        reb = dates[:-1] if len(dates) > 1 else dates
    last = reb[-1] if reb else (dates[-2] if len(dates) > 1 else dates[-1])
    return {"last_rebalance": date_key(last), "frequency": TIMER_FREQ_MAP.get(f, freq)}


def rebalance_compare(cfg: dict, entry: dict, allocations: dict, raw: dict, fusion: bool) -> dict[str, Any] | None:
    dates = sorted(allocations.keys())
    if not dates:
        return None
    final_date = dates[-1]
    last = None
    freq = cfg.get("rebalancing_frequency", "Monthly") or "Monthly"
    freq = COMPARE_FREQ_MAP.get(str(freq).lower(), freq)
    if freq != "Never":
        na = entry.get("no_additions")
        if isinstance(na, pd.Series) and len(na):
            try:
                for d in reversed(dates_by_freq(freq, na.index)):
                    if d <= final_date:
                        last = d
                        break
            except Exception:
                last = None
    if last is None:
        last = dates[-2] if len(dates) > 1 else dates[-1]
    final_alloc = allocations.get(final_date, {}) or {}
    rebal_alloc = allocations.get(last, {}) or {}
    if fusion:
        cwm = entry.get("current_weights_map") or {}
        current_pie = pie({k: v for k, v in cwm.items() if isinstance(v, (int, float)) and not pd.isna(v)})
    else:
        current_pie = pie({k: v for k, v in final_alloc.items() if isinstance(v, (int, float)) and not pd.isna(v)})
    pv = portfolio_value(entry)
    exclude = set((cfg.get("fusion_portfolio") or {}).get("selected_portfolios") or []) if fusion else None
    return {
        "last_date": date_key(last),
        "final_date": date_key(final_date),
        "last_pie": pie(rebal_alloc),
        "current_pie": current_pie,
        "last_table": allocation_table(rebal_alloc, last, pv, raw, exclude),
        "current_table": allocation_table(final_alloc, None, pv, raw, exclude),
    }


def today_block(cfg: dict, entry: dict, metrics: dict, allocations: dict, raw: dict) -> dict[str, Any]:
    weights = today_weights(cfg, metrics)
    labels = pie(weights)
    if not labels or sum(v for _k, v in labels) < 0.1:
        labels = [["CASH", 100.0]]
    pv = portfolio_value(entry)
    table = allocation_table(weights, None, pv, raw) if allocations else None
    prices = {}
    for t in weights:
        if t == "CASH":
            continue
        df = raw.get(t)
        if isinstance(df, pd.DataFrame) and "Close" in df.columns and not df["Close"].dropna().empty:
            prices[t] = _num(df["Close"].iloc[-1])
    return {
        "weights": {k: round(v, 8) for k, v in weights.items()},
        "pie": labels,
        "portfolio_value": round(pv, 2),
        "table": table,
        "prices": prices,
    }
