"""Streamlit result-page analytics, transcribed from 1_Multi_Backtest.py.

Rebuilds `multi_all_results` and the benchmark raw frames from a result
bundle, then evaluates the Variation Summary, monthly heatmap, yearly /
monthly tables with their Robust Statistics and the Focused Performance
Analysis exactly as the Streamlit page does. Used by results_parity.py to
check the TypeScript port (src/lib/backtest/analytics).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from backtest_engine.legacy.multi_backtest import (
    calculate_cagr,
    calculate_max_drawdown,
    calculate_sharpe,
    calculate_sortino,
    calculate_upi,
    calculate_volatility,
)


def _dates(summary: dict, ref: dict, n: int) -> pd.DatetimeIndex:
    if ref.get("dates"):
        return pd.DatetimeIndex(pd.to_datetime(ref["dates"]))
    off = ref.get("offset", 0)
    return pd.DatetimeIndex(pd.to_datetime(summary["dates"][off:off + n]))


def rebuild(summary: dict):
    configs, results = [], {}
    for p in summary["portfolios"]:
        if not p.get("ok"):
            if p.get("config"):
                configs.append(p["config"])
            continue
        configs.append(p["config"])
        s = p["series"]
        idx = _dates(summary, s, len(s["with_additions"]))
        wa = pd.Series([np.nan if v is None else v for v in s["with_additions"]], index=idx, dtype=float)
        na_vals = s["no_additions"] if s.get("no_additions") is not None else s["with_additions"]
        na = pd.Series([np.nan if v is None else v for v in na_vals], index=idx, dtype=float)
        results[p["name"]] = {"with_additions": wa, "no_additions": na}
    raw = {}
    for t, ref in (summary.get("benchmark_returns") or {}).items():
        idx = _dates(summary, ref, len(ref["values"]))
        pc = pd.Series([np.nan if v is None else v for v in ref["values"]], index=idx, dtype=float).dropna()
        raw[t] = pd.DataFrame({"Price_change": pc})
    return configs, results, raw


def variation(results: dict) -> dict:
    out = {}
    for name, obj in results.items():
        ser_no = obj["no_additions"]
        if ser_no is None or len(ser_no) < 2:
            continue
        vals = ser_no.values
        dates = ser_no.index
        total_return = (vals[-1] / vals[0] - 1) * 100 if vals[0] and not np.isnan(vals[0]) else np.nan
        cagr = calculate_cagr(vals, dates)
        vol = calculate_volatility(pd.Series(vals, index=dates).pct_change().fillna(0))
        max_dd, _ = calculate_max_drawdown(vals)
        out[name] = {"Total Return": total_return, "CAGR": cagr * 100, "Volatility": vol * 100,
                     "Max Drawdown": max_dd * 100}
    return out


def heatmap(configs: list, results: dict) -> dict:
    monthly_returns = {}
    order = [c["name"] for c in configs if c["name"] in results]
    for name in order:
        ser_no = results[name]["no_additions"]
        if ser_no is None or len(ser_no) < 2:
            continue
        pct = ser_no.resample("ME").last().pct_change().dropna() * 100
        pct.index = pct.index.strftime("%Y-%m")
        monthly_returns[name] = pct
    months = sorted({m for ser in monthly_returns.values() for m in ser.index})
    return {"months": months, "cells": {n: {m: float(v) for m, v in ser.items()} for n, ser in monthly_returns.items()}}


def _table(configs, results, kind):
    if kind == "year":
        all_years = {n: r["with_additions"].resample("YE").last() for n, r in results.items()}
        keys = sorted({y.year for ser in all_years.values() for y in ser.index})
        names = [c["name"] for c in configs if c.get("name") in all_years]
    else:
        keys = sorted({(d.year, d.month) for r in results.values() for d in r["with_additions"].index})
        names = [c["name"] for c in configs if c.get("name") in results]
    table = {}
    for name in names:
        pct_list, final_list = [], []
        if kind == "year":
            ser_with = all_years.get(name)
            ser_noadd = results[name]["no_additions"].resample("YE").last()
        else:
            ser_with = results[name]["with_additions"]
            ser_noadd = results[name]["no_additions"].resample("ME").last()

        def sel(ser, key):
            if kind == "year":
                return ser[ser.index.year == key]
            return ser[(ser.index.year == key[0]) & (ser.index.month == key[1])]

        for i, key in enumerate(keys):
            start = None
            if key == min(keys):
                cfg = next((c for c in configs if c["name"] == name), None)
                if cfg and cfg["initial_value"] > 0:
                    start = cfg["initial_value"]
            else:
                prev_key = key - 1 if kind == "year" else keys[i - 1]
                prev = sel(ser_noadd, prev_key)
                if not prev.empty:
                    start = prev.iloc[-1]
            cur = sel(ser_noadd, key)
            if not cur.empty and start is not None:
                end = cur.iloc[-1]
                pct = (end - start) / start * 100 if start > 0 else np.nan
            else:
                pct = np.nan
            cw = sel(ser_with, key)
            pct_list.append(pct)
            final_list.append(cw.iloc[-1] if not cw.empty else np.nan)
        table[name] = {"pct": pct_list, "final": final_list}
    labels = [str(k) for k in keys] if kind == "year" else [f"{y}-{m:02d}" for y, m in keys]
    return labels, names, table


def _robust(configs, results, raw, names, table, kind):
    rows = {}
    bench_ticker = configs[0].get("benchmark_ticker", "^GSPC") if configs else None
    df_bench = raw.get(bench_ticker)
    for nm in names:
        series_clean = pd.Series(table[nm]["pct"], dtype=float).dropna()
        total = len(series_clean)
        positives = int((series_clean > 0).sum()) if total > 0 else 0
        pos_s, neg_s = series_clean[series_clean > 0], series_clean[series_clean < 0]
        row = {
            "positives": positives,
            "positivePct": (positives / total) * 100 if total > 0 else np.nan,
            "mean": series_clean.mean() if total > 0 else np.nan,
            "median": series_clean.median() if total > 0 else np.nan,
            "std": series_clean.std(ddof=0) if total > 1 else np.nan,
            "posMean": pos_s.mean() if len(pos_s) else np.nan,
            "posMedian": pos_s.median() if len(pos_s) else np.nan,
            "negMean": neg_s.mean() if len(neg_s) else np.nan,
            "negMedian": neg_s.median() if len(neg_s) else np.nan,
            "volMean": np.nan, "volMedian": np.nan, "volAnnMean": np.nan, "volAnnMedian": np.nan,
            "betaMean": np.nan, "betaMedian": np.nan,
        }
        ser = results[nm]["no_additions"]
        if kind == "year":
            monthly_ser = ser.resample("ME").last().pct_change().dropna()
            if not monthly_ser.empty:
                vols = monthly_ser.groupby([monthly_ser.index.year]).std(ddof=0)
                if len(vols):
                    row["volMean"], row["volMedian"] = float(vols.mean()), float(vols.median())
                    va = vols * np.sqrt(12.0)
                    row["volAnnMean"], row["volAnnMedian"] = float(va.mean()), float(va.median())
                bench = df_bench["Price_change"].dropna() if isinstance(df_bench, pd.DataFrame) else None
                port = ser.pct_change().dropna()
                if bench is not None and not port.empty and not bench.empty:
                    j = pd.concat([port.rename("p"), bench.rename("b")], axis=1).dropna()
                    if not j.empty:
                        j["g"] = j.index.year
                        betas = [np.cov(g["p"], g["b"])[0, 1] / g["b"].var() for _k, g in j.groupby("g")
                                 if len(g) >= 2 and g["b"].var() > 0]
                        if betas:
                            row["betaMean"], row["betaMedian"] = float(np.mean(betas)), float(np.median(betas))
        else:
            port = ser.pct_change().dropna()
            if not port.empty:
                vols = port.groupby([port.index.to_period("M")]).std(ddof=0)
                if len(vols):
                    row["volMean"], row["volMedian"] = float(vols.mean()), float(vols.median())
                    va = vols * np.sqrt(252.0)
                    row["volAnnMean"], row["volAnnMedian"] = float(va.mean()), float(va.median())
            bench = df_bench["Price_change"].dropna() if isinstance(df_bench, pd.DataFrame) else None
            if bench is not None and not port.empty and not bench.empty:
                j = pd.concat([port.rename("p"), bench.rename("b")], axis=1).dropna()
                if not j.empty:
                    j["g"] = j.index.to_period("M")
                    betas = [np.cov(g["p"], g["b"])[0, 1] / g["b"].var() for _k, g in j.groupby("g")
                             if len(g) >= 2 and g["b"].var() > 0]
                    if betas:
                        row["betaMean"], row["betaMedian"] = float(np.mean(betas)), float(np.median(betas))
        rows[nm] = row
    return rows


def periods(configs, results, raw, kind):
    labels, names, table = _table(configs, results, kind)
    return {"labels": labels, "table": table, "robust": _robust(configs, results, raw, names, table, kind)}


def focused(configs, results, raw, start_date, end_date) -> dict:
    out = {}
    for portfolio_name, res in results.items():
        series = res["no_additions"]
        start_dt = pd.to_datetime(start_date)
        end_dt = pd.to_datetime(end_date) + pd.Timedelta(days=1)
        filtered_series = series[(series.index >= start_dt) & (series.index < end_dt)]
        if len(filtered_series) <= 1:
            continue
        returns = filtered_series.pct_change().fillna(0)
        zero_rate = (abs(returns) < 1e-5).mean()
        if zero_rate > 0.25:
            returns = returns[(returns.index.weekday < 5) | (abs(returns) > 1e-5)]
        original_returns = filtered_series.pct_change().fillna(0)
        cagr = calculate_cagr(filtered_series, filtered_series.index)
        volatility = calculate_volatility(original_returns)
        sharpe = calculate_sharpe(original_returns, 0.02)
        sortino = calculate_sortino(original_returns, 0.02)
        cumulative = (1 + original_returns).cumprod()
        drawdown = (cumulative - cumulative.expanding().max()) / cumulative.expanding().max()
        max_drawdown = drawdown.min()
        ulcer_index = np.sqrt((drawdown ** 2).mean()) * 100
        upi = calculate_upi(cagr, ulcer_index) if ulcer_index > 0 else np.nan
        beta = np.nan
        cfg = next((c for c in configs if c["name"] == portfolio_name), None)
        if cfg:
            bt = cfg.get("benchmark_ticker")
            if bt and bt in raw:
                bench_df = raw[bt].reindex(filtered_series.index)
                bench_returns = bench_df["Price_change"].fillna(0)
                common = original_returns.index.intersection(bench_returns.index)
                if len(common) >= 2:
                    pr = original_returns.reindex(common).dropna()
                    br = bench_returns.reindex(common).dropna()
                    c2 = pr.index.intersection(br.index)
                    if len(c2) >= 2 and br.loc[c2].var() != 0:
                        beta = pr.loc[c2].cov(br.loc[c2]) / br.loc[c2].var()
        total_return = filtered_series.iloc[-1] / filtered_series.iloc[0] - 1
        years = (filtered_series.index[-1] - filtered_series.index[0]).days / 365.25
        final_value_no_contrib = 10000 * ((1 + cagr) ** years)
        median_drawdown = drawdown.median()
        pos = returns[returns > 1e-5]
        neg = returns[returns < -1e-5]
        active = len(pos) + len(neg)
        win_rate = len(pos) / active * 100 if active > 0 else 0
        loss_rate = len(neg) / active * 100 if active > 0 else 0
        median_win = pos.median() * 100 if len(pos) else 0
        median_loss = neg.median() * 100 if len(neg) else 0
        gp = pos.sum() if len(pos) else 0
        gl = abs(neg.sum()) if len(neg) else 0
        profit_factor = gp / gl if gl > 0 else np.inf
        monthly = filtered_series.resample("ME").last().pct_change().fillna(0) * 100
        out[portfolio_name] = {
            "totalReturn": total_return * 100,
            "cagr": cagr * 100,
            "maxDrawdown": max_drawdown * 100,
            "volatility": volatility * 100,
            "sharpe": sharpe,
            "sortino": sortino,
            "ulcerIndex": ulcer_index,
            "upi": upi,
            "beta": beta,
            "finalValueNoContrib": final_value_no_contrib,
            "medianDrawdown": median_drawdown * 100,
            "winRate": win_rate,
            "lossRate": loss_rate,
            "medianWin": median_win,
            "medianLoss": median_loss,
            "profitFactor": profit_factor,
            "bestMonth": monthly.max() if len(monthly) else 0,
            "worstMonth": monthly.min() if len(monthly) else 0,
            "medianMonthly": monthly.median() if len(monthly) else 0,
            "calmar": (cagr * 100) / abs(max_drawdown * 100) if max_drawdown != 0 else np.nan,
            "sterling": (cagr * 100) / abs(median_drawdown * 100) if median_drawdown != 0 else np.nan,
            "recoveryFactor": abs(total_return) / abs(max_drawdown) if max_drawdown != 0 else np.nan,
            "tailRatio": returns.quantile(0.95) / abs(returns.quantile(0.05)) if returns.quantile(0.05) != 0 else np.nan,
        }
    return out
