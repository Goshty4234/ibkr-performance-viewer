"""Final performance statistics, as computed by the Streamlit results section.

Mirrors the "Recompute Final Performance Statistics" block of 1_Multi_Backtest.py:
same inputs (no-additions series, 2% risk-free rate, benchmark Price_change),
same metric functions (from the generated legacy module), and the same display
scaling/clamping. Each stat is returned both as the number shown in Streamlit
and as the exact display string.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from .legacy import multi_backtest as L

RISK_FREE_RATE = 0.02

PERCENT_STATS = ("CAGR", "MaxDrawdown", "Volatility", "MWRR", "Total Return", "Total Return (Contributed)")


def _scale_pct(val: Any) -> Any:
    if val is None or (isinstance(val, (int, float)) and np.isnan(val)):
        return np.nan
    if isinstance(val, str):
        return val
    if isinstance(val, (int, float)) and -1.5 < val < 1.5:
        return val * 100
    return val


def _clamp(val: Any, stat_type: str) -> Any:
    """Returns the value displayed by Streamlit (number) or None for "N/A"."""
    if val is None or (isinstance(val, float) and np.isnan(val)):
        return None
    v = _scale_pct(val)
    if isinstance(v, str):
        return None
    if stat_type in ("CAGR", "Volatility", "MWRR"):
        if isinstance(v, (int, float)) and v > 100:
            return None
    elif stat_type == "MaxDrawdown":
        if isinstance(v, (int, float)) and (v < -100 or v > 0):
            return None
    return v


def _display(v: Any, stat_type: str) -> str:
    if v is None:
        return "N/A"
    if stat_type in ("CAGR", "MaxDrawdown", "Volatility", "Total Return", "Total Return (Contributed)"):
        return f"{v:.2f}%"
    return f"{v:.3f}" if isinstance(v, float) else str(v)


def _div100(x: Any) -> Any:
    return x / 100 if isinstance(x, (int, float)) and pd.notna(x) else x


def compute_final_stats(
    name: str,
    series_obj: dict,
    cfg: dict | None,
    raw_data: dict | None,
) -> dict[str, Any]:
    ser_noadd = series_obj.get("no_additions") if isinstance(series_obj, dict) else series_obj
    with_add = series_obj.get("with_additions") if isinstance(series_obj, dict) else None

    def final_of(s: Any) -> Any:
        return float(s.iloc[-1]) if isinstance(s, pd.Series) and len(s) > 0 else None

    if ser_noadd is None or len(ser_noadd) < 2:
        empty = {k: None for k in ("Total Return", "CAGR", "MaxDrawdown", "Volatility", "Sharpe", "Sortino", "UlcerIndex", "UPI", "Beta", "MWRR")}
        return {
            "values": {**empty, "Final Value (with)": final_of(with_add), "Final Value (no_additions)": final_of(ser_noadd)},
            "display": {k: "N/A" for k in empty},
        }

    stats_values = ser_noadd.values
    stats_dates = ser_noadd.index
    stats_returns = pd.Series(stats_values, index=stats_dates).pct_change().fillna(0)

    total_return = None
    if len(stats_values) > 0:
        initial_val = stats_values[0]
        final_val = stats_values[-1]
        if initial_val > 0:
            total_return = (final_val / initial_val - 1) * 100

    cagr = L.calculate_cagr(stats_values, stats_dates)
    max_dd, _drawdowns = L.calculate_max_drawdown(stats_values)
    vol = L.calculate_volatility(stats_returns)
    sharpe = L.calculate_sharpe(stats_returns, RISK_FREE_RATE)
    sortino = L.calculate_sortino(stats_returns, RISK_FREE_RATE)
    ulcer = L.calculate_ulcer_index(pd.Series(stats_values, index=stats_dates))
    upi = L.calculate_upi(cagr, ulcer)

    beta = np.nan
    if cfg:
        bench_ticker = cfg.get("benchmark_ticker")
        if bench_ticker and raw_data and bench_ticker in raw_data:
            try:
                bench_df = raw_data[bench_ticker].reindex(ser_noadd.index)
                if "Price_change" in bench_df.columns:
                    bench_returns = bench_df["Price_change"].fillna(0)
                else:
                    bench_returns = bench_df["Close"].pct_change().fillna(0)
                portfolio_returns = pd.Series(stats_values, index=stats_dates).pct_change().fillna(0)
                common_idx = portfolio_returns.index.intersection(bench_returns.index)
                if len(common_idx) >= 2:
                    pr = portfolio_returns.reindex(common_idx).dropna()
                    br = bench_returns.reindex(common_idx).dropna()
                    common_idx2 = pr.index.intersection(br.index)
                    if len(common_idx2) >= 2 and br.loc[common_idx2].var() != 0:
                        beta = pr.loc[common_idx2].cov(br.loc[common_idx2]) / br.loc[common_idx2].var()
            except Exception:
                pass

    mwrr_val = np.nan
    if isinstance(series_obj, dict) and with_add is not None and cfg and len(with_add) > 0:
        if "cash_flows" in series_obj and "portfolio_values" in series_obj:
            cash_flows = series_obj["cash_flows"]
            pv = series_obj.get("with_additions", series_obj["portfolio_values"])
            mwrr_val = L.calculate_mwrr(pv, cash_flows, pv.index)
        else:
            cash_flows = pd.Series(0.0, index=with_add.index)
            cash_flows.iloc[0] = -cfg.get("initial_value", 0)
            dates_added = L.get_dates_by_freq(cfg.get("added_frequency"), with_add.index[0], with_add.index[-1], with_add.index)
            for d in dates_added:
                if d in cash_flows.index and d != cash_flows.index[0]:
                    cash_flows.loc[d] -= cfg.get("added_amount", 0)
            cash_flows.iloc[-1] += with_add.iloc[-1]
            mwrr_val = L.calculate_mwrr(with_add, cash_flows, with_add.index)

    total_money_added = np.nan
    if cfg and isinstance(ser_noadd, pd.Series) and len(ser_noadd) > 0:
        total_money_added = L.calculate_total_money_added(cfg, ser_noadd.index[0], ser_noadd.index[-1])

    total_return_contributed = np.nan
    if with_add is not None and len(with_add) > 0:
        if isinstance(total_money_added, (int, float)) and total_money_added > 0:
            total_return_contributed = (with_add.iloc[-1] / total_money_added - 1) * 100

    values = {
        "Total Return": _clamp(total_return, "Total Return"),
        "Total Return (Contributed)": _clamp(total_return_contributed, "Total Return"),
        "CAGR": _clamp(cagr, "CAGR"),
        "MaxDrawdown": _clamp(max_dd, "MaxDrawdown"),
        "Volatility": _clamp(vol, "Volatility"),
        "Sharpe": _clamp(_div100(sharpe), "Sharpe"),
        "Sortino": _clamp(_div100(sortino), "Sortino"),
        "UlcerIndex": _clamp(ulcer, "UlcerIndex"),
        "UPI": _clamp(_div100(upi), "UPI"),
        "Beta": _clamp(_div100(beta), "Beta"),
    }
    display = {k: _display(v, "Total Return" if k.startswith("Total Return") else k) for k, v in values.items()}

    mwrr_num = float(mwrr_val) if isinstance(mwrr_val, (int, float)) and pd.notna(mwrr_val) else None
    values["MWRR"] = mwrr_num
    display["MWRR"] = f"{mwrr_num:.2f}%" if mwrr_num is not None else "N/A"
    values["Final Value (with)"] = final_of(with_add)
    values["Final Value (no_additions)"] = final_of(ser_noadd)
    values["Total Money Added"] = (
        float(total_money_added) if isinstance(total_money_added, (int, float)) and pd.notna(total_money_added) else None
    )
    return {"values": {k: (float(v) if isinstance(v, (int, float, np.floating)) and v is not None else v) for k, v in values.items()}, "display": display}
