"""Holdings, gains and taxes for one portfolio.

streamlit_holdings / streamlit_gains transcribe the "Historical Shares and
Position Values", "Realized and Unrealized Gains/Losses" and "Annual
Gains/Losses Summary" blocks of 1_Multi_Backtest.py (same rebalance dates,
same period-by-period mark-to-market logic, same year bucketing).

acb_tax is the correct Canadian computation: shares are rebuilt daily from
the backtest's own allocations and total value, every change is a trade,
realized gains use the adjusted cost base (average cost, PBR) and are
reported by calendar year with dividends and contributions kept apart.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from ..legacy import multi_backtest as L
from ..serialize import date_key
from .dates import dates_by_freq

SHARES_FREQ_MAP = {
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
    "buy & hold": "Buy & Hold",
    "buy & hold (target)": "Buy & Hold (Target)",
}
_NO_REBALANCE = ("Never", "Buy & Hold", "Buy & Hold (Target)")
MAX_TRANSACTIONS = 60_000


def alloc_value(v: Any) -> float:
    if isinstance(v, dict):
        return float(v.get("allocation", v.get("weight", 0)))
    return float(v) if v is not None else 0.0


def ticker_order(allocations: dict) -> list[str]:
    tickers: set = set()
    for alloc in allocations.values():
        if isinstance(alloc, dict):
            tickers.update(alloc.keys())
    tickers.discard(None)
    out = sorted(tickers)
    if "CASH" in out:
        out.remove("CASH")
        out.append("CASH")
    return out


def weights_matrix(allocations: dict, dates: list, tickers: list[str]) -> np.ndarray:
    w = np.zeros((len(dates), len(tickers)), dtype=float)
    col = {t: j for j, t in enumerate(tickers)}
    for i, d in enumerate(dates):
        alloc = allocations.get(d) or {}
        for t, v in alloc.items():
            j = col.get(t)
            if j is not None:
                try:
                    w[i, j] = alloc_value(v)
                except (TypeError, ValueError):
                    pass
    return w


def asof(series: pd.Series, dates: list | pd.DatetimeIndex) -> np.ndarray:
    """Value at the last index <= date (NaN before the first index)."""
    if not len(dates):
        return np.zeros(0)
    idx = series.index
    pos = idx.searchsorted(pd.DatetimeIndex(dates), side="right") - 1
    vals = series.to_numpy(dtype=float, na_value=np.nan)
    out = np.full(len(pos), np.nan)
    ok = pos >= 0
    out[ok] = vals[pos[ok]]
    return out


def _close(raw: dict, ticker: str) -> pd.Series | None:
    df = raw.get(ticker)
    if isinstance(df, pd.DataFrame) and "Close" in df.columns:
        return df["Close"]
    return None


def rebalancing_dates(cfg: dict, entry: dict, allocations: dict) -> tuple[list, str]:
    freq = cfg.get("rebalancing_frequency", "none")
    freq_disp = SHARES_FREQ_MAP.get(str(freq).lower(), freq)
    reb: list = []
    try:
        na = entry.get("no_additions")
        if isinstance(na, pd.Series) and len(na):
            dates = dates_by_freq(freq_disp, na.index)
            if dates:
                reb = sorted(d for d in dates if d in allocations)
    except Exception:
        reb = []
    if not reb and freq_disp not in _NO_REBALANCE:
        reb = sorted(allocations.keys())
    return reb, freq_disp


def _r(a: np.ndarray, digits: int) -> list:
    return [None if not np.isfinite(x) else round(float(x), digits) for x in a]


def streamlit_holdings(cfg: dict, entry: dict, allocations: dict, raw: dict) -> dict[str, Any]:
    reb, freq_disp = rebalancing_dates(cfg, entry, allocations)
    tickers = ticker_order(allocations)
    n, m = len(reb), len(tickers)
    shares = np.zeros((n, m))
    values = np.zeros((n, m))
    prices = np.full((n, m), np.nan)
    has_data = np.zeros(m, dtype=bool)
    if n:
        wa = entry.get("with_additions")
        pv = asof(wa, reb) if isinstance(wa, pd.Series) else np.zeros(n)
        pv = np.where(np.isfinite(pv), pv, 0.0)
        w = weights_matrix(allocations, reb, tickers)
        for j, t in enumerate(tickers):
            alloc_val = pv * w[:, j]
            if t == "CASH":
                values[:, j] = alloc_val
                continue
            close = _close(raw, t)
            if close is None:
                values[:, j] = alloc_val
                continue
            has_data[j] = True
            p = asof(close, reb)
            prices[:, j] = p
            valid = np.isfinite(p) & (p > 0)
            raw_sh = np.divide(alloc_val, p, out=np.zeros(n), where=valid)
            shares[:, j] = [round(float(x), 2) if ok else 0.0 for x, ok in zip(raw_sh, valid)]
            values[:, j] = np.where(valid, raw_sh * np.where(valid, p, 0.0), alloc_val)
    return {
        "frequency": freq_disp,
        "dates": [date_key(d) for d in reb],
        "tickers": tickers,
        "shares": shares,
        "values": values,
        "prices": prices,
        "has_data": has_data,
    }


def streamlit_gains(h: dict) -> dict[str, Any]:
    tickers: list[str] = h["tickers"]
    shares: np.ndarray = h["shares"]
    values: np.ndarray = h["values"]
    prices: np.ndarray = h["prices"]
    has_data: np.ndarray = h["has_data"]
    n, m = shares.shape
    realized = np.zeros((n, m))
    unrealized = np.zeros((n, m))
    valid = np.isfinite(prices) & (prices > 0)
    avg: dict[int, float] = {}
    if n:
        for j, t in enumerate(tickers):
            if t == "CASH":
                continue
            fv, fs = values[0, j], shares[0, j]
            if fs > 0 and fv > 0:
                avg[j] = fv / fs
            elif has_data[j]:
                avg[j] = prices[0, j]
            else:
                avg[j] = 0.0

    def avg_ok(j: int) -> bool:
        a = avg.get(j, 0.0)
        return bool(a > 0)

    for i in range(n):
        for j, t in enumerate(tickers):
            if t == "CASH":
                continue
            ps = shares[i - 1, j] if i > 0 else 0.0
            cs = shares[i, j]
            if not valid[i, j]:
                continue
            cp = prices[i, j]
            pp = prices[i - 1, j] if i > 0 and valid[i - 1, j] else None
            diff = cs - ps
            if diff < 0:
                sold = abs(diff)
                gain = 0.0
                if ps > 0 and cp > 0:
                    if pp:
                        gain = (cp - pp) * sold
                    else:
                        prev_value = values[i - 1, j] if i > 0 else 0.0
                        if prev_value > 0 and ps > 0:
                            gain = (cp - prev_value / ps) * sold
                        elif avg_ok(j):
                            gain = (cp - avg[j]) * sold
                realized[i, j] = gain
                if cs > 0:
                    if pp:
                        unrealized[i, j] = (cp - pp) * cs
                    elif avg_ok(j):
                        unrealized[i, j] = (cp - avg[j]) * cs
                else:
                    avg[j] = 0.0
            elif ps > 0:
                if pp:
                    unrealized[i, j] = (cp - pp) * ps
                elif avg_ok(j):
                    unrealized[i, j] = (cp - avg[j]) * ps
        for j, t in enumerate(tickers):
            if t == "CASH" or not valid[i, j]:
                continue
            ps = shares[i - 1, j] if i > 0 else 0.0
            cs = shares[i, j]
            cp = prices[i, j]
            diff = cs - ps
            if diff > 0:
                if ps > 0:
                    if avg_ok(j):
                        prev_cost = ps * avg[j]
                    else:
                        prev_value = values[i - 1, j] if i > 0 else 0.0
                        pp = prices[i - 1, j] if i > 0 and valid[i - 1, j] else None
                        if prev_value > 0:
                            prev_cost = prev_value
                        elif pp:
                            prev_cost = ps * pp
                        else:
                            prev_cost = 0.0
                    avg[j] = (prev_cost + diff * cp) / cs if cs > 0 else cp
                else:
                    avg[j] = cp

    real_total = realized.sum(axis=1)
    unreal_total = unrealized.sum(axis=1)
    dates = [pd.Timestamp(d) for d in h["dates"]]
    labels: list[str] = []
    buckets: list[int] = []
    for i, d in enumerate(dates):
        if i > 0:
            prev = dates[i - 1]
            labels.append(f"{prev:%Y-%m-%d} - {d:%Y-%m-%d}")
            start_year, end_year = prev.year, d.year
        else:
            labels.append(f"{d:%Y-%m-%d} (start)")
            start_year = end_year = d.year
        buckets.append(end_year if start_year < end_year else end_year + 1 if start_year == end_year else end_year)
    annual_r: dict[int, float] = {}
    annual_u: dict[int, float] = {}
    for i, year in enumerate(buckets):
        annual_r[year] = annual_r.get(year, 0.0) + float(real_total[i])
        annual_u[year] = annual_u.get(year, 0.0) + float(unreal_total[i])
    annual = []
    for year in sorted(set(annual_r) | set(annual_u)):
        r, u = annual_r.get(year, 0.0), annual_u.get(year, 0.0)
        abs_total = abs(r) + abs(u)
        annual.append({
            "period": f"{year - 1}-{year}",
            "realized": round(r, 2),
            "unrealized": round(u, 2),
            "total": round(r + u, 2),
            "taxable_pct": round(abs(r) / abs_total * 100, 4) if abs_total > 0.01 else 0.0,
        })
    return {
        "periods": labels,
        "realized": [_r(row, 2) for row in realized],
        "unrealized": [_r(row, 2) for row in unrealized],
        "realized_total": _r(real_total, 2),
        "unrealized_total": _r(unreal_total, 2),
        "annual": annual,
    }


def holdings_payload(h: dict) -> dict[str, Any]:
    return {
        "frequency": h["frequency"],
        "dates": h["dates"],
        "tickers": h["tickers"],
        "shares": [_r(row, 2) for row in h["shares"]],
        "values": [_r(row, 2) for row in h["values"]],
    }


# Canadian adjusted cost base ------------------------------------------------------

def _dividend_flags(cfg: dict, configs: list[dict]) -> tuple[dict[str, bool], bool]:
    group = [cfg]
    fusion = cfg.get("fusion_portfolio") or {}
    if fusion.get("enabled"):
        wanted = set(fusion.get("selected_portfolios") or [])
        group = [c for c in configs if c.get("name") in wanted] or [c for c in configs if not (c.get("fusion_portfolio") or {}).get("enabled")]
    flags: dict[str, bool] = {}
    for c in group:
        for s in c.get("stocks", []):
            t = (s.get("ticker") or "").strip()
            if t:
                flags[t] = flags.get(t, False) or bool(s.get("include_dividends", False))
    collect_cash = all(bool(c.get("collect_dividends_as_cash", False)) for c in group) if group else False
    return flags, collect_cash


def _dividend_per_share(t: str, idx: pd.DatetimeIndex, reindexed: dict, price: np.ndarray) -> np.ndarray:
    n = len(idx)
    if "?L=" in t or "?E=" in t:
        base, _lev, _er = L.parse_ticker_parameters(t)
        bdf = reindexed.get(base)
        if not isinstance(bdf, pd.DataFrame) or "Dividends" not in bdf.columns:
            return np.zeros(n)
        bdiv = bdf["Dividends"].reindex(idx).fillna(0).to_numpy(dtype=float)
        bclose = bdf["Close"].reindex(idx).to_numpy(dtype=float)
        prev_b = np.concatenate([[np.nan], bclose[:-1]])
        prev_p = np.concatenate([[np.nan], price[:-1]])
        rate = np.divide(bdiv, prev_b, out=np.zeros(n), where=np.isfinite(prev_b) & (prev_b > 0))
        return np.where(np.isfinite(prev_p), rate * prev_p, 0.0)
    df = reindexed.get(t)
    if not isinstance(df, pd.DataFrame) or "Dividends" not in df.columns:
        return np.zeros(n)
    return df["Dividends"].reindex(idx).fillna(0).to_numpy(dtype=float)


def contribution_dates(cfg: dict, index: pd.DatetimeIndex) -> list[pd.Timestamp]:
    amount = cfg.get("added_amount", 0) or 0
    if amount <= 0 or not len(index):
        return []
    try:
        dates = dates_by_freq(cfg.get("added_frequency"), index)
    except Exception:
        return []
    return [d for d in dates if d != index[0]]


def acb_tax(cfg: dict, entry: dict, allocations: dict, reindexed: dict, configs: list[dict]) -> dict[str, Any]:
    wa = entry.get("with_additions")
    dates = sorted(allocations.keys())
    if not isinstance(wa, pd.Series) or not len(wa) or not dates:
        return {"transactions": None, "years": [], "positions": []}
    idx = pd.DatetimeIndex(dates)
    tickers = [t for t in ticker_order(allocations) if t != "CASH"]
    pv = asof(wa, idx)
    pv = np.where(np.isfinite(pv), pv, 0.0)
    w = weights_matrix(allocations, dates, tickers)
    div_flags, collect_cash = _dividend_flags(cfg, configs)
    years = idx.year.to_numpy()
    year_list = sorted(set(int(y) for y in years))
    year_end = {y: int(np.nonzero(years == y)[0][-1]) for y in year_list}

    tx_date: list[int] = []
    tx_ticker: list[int] = []
    tx_kind: list[str] = []
    tx_qty: list[float] = []
    tx_price: list[float] = []
    tx_amount: list[float] = []
    tx_gain: list[float | None] = []
    tx_shares: list[float] = []
    tx_acb: list[float] = []

    per_year = {y: {"proceeds": 0.0, "cost": 0.0, "realized": 0.0, "dividends": 0.0, "buys": 0.0, "sells": 0.0,
                    "trades": 0, "market_value": 0.0, "acb": 0.0} for y in year_list}
    realized_by = np.zeros((len(year_list), len(tickers)))
    dividends_by = np.zeros((len(year_list), len(tickers)))
    ypos = {y: k for k, y in enumerate(year_list)}
    positions = []

    for j, t in enumerate(tickers):
        df = reindexed.get(t)
        if not isinstance(df, pd.DataFrame) or "Close" not in df.columns:
            continue
        price = df["Close"].reindex(idx).to_numpy(dtype=float)
        pvalid = np.isfinite(price) & (price > 0)
        target = np.divide(pv * w[:, j], price, out=np.zeros(len(idx)), where=pvalid)
        tol = np.maximum(0.01, 1e-7 * pv)
        prev = np.concatenate([[0.0], target[:-1]])
        moved = pvalid & (np.abs(target - prev) * np.where(pvalid, price, 0.0) >= tol)
        dps = _dividend_per_share(t, idx, reindexed, price) if div_flags.get(t, False) else np.zeros(len(idx))
        has_div = dps > 0
        steps = np.nonzero(moved | has_div)[0]
        held = 0.0
        cost = 0.0
        ends = iter(sorted(year_end.items(), key=lambda kv: kv[1]))
        next_end = next(ends, None)

        def close_years(upto: int) -> None:
            nonlocal next_end
            while next_end is not None and next_end[1] < upto:
                y, e = next_end
                p = price[e] if pvalid[e] else np.nan
                if held > 0 and np.isfinite(p):
                    per_year[y]["market_value"] += held * p
                per_year[y]["acb"] += cost
                next_end = next(ends, None)

        for i in steps:
            close_years(i)
            y = int(years[i])
            k = ypos[y]
            p = price[i]
            if has_div[i] and held > 0:
                cash = held * dps[i]
                per_year[y]["dividends"] += cash
                dividends_by[k, j] += cash
            if not pvalid[i]:
                continue
            q = target[i] - held
            if abs(q) * p < tol[i]:
                continue
            if q > 0:
                drip_qty = held * dps[i] / p if (has_div[i] and not collect_cash) else 0.0
                parts = []
                if drip_qty > 0:
                    parts.append(("drip", min(q, drip_qty)))
                if q - min(q, drip_qty) > 1e-12 or not parts:
                    parts.append(("buy", q - (min(q, drip_qty) if drip_qty > 0 else 0.0)))
                for kind, qty in parts:
                    if qty * p < 0.005:
                        continue
                    held += qty
                    cost += qty * p
                    per_year[y]["buys"] += qty * p
                    per_year[y]["trades"] += 1
                    tx_date.append(i); tx_ticker.append(j); tx_kind.append(kind)
                    tx_qty.append(qty); tx_price.append(p); tx_amount.append(qty * p); tx_gain.append(None)
                    tx_shares.append(held); tx_acb.append(cost / held if held > 0 else 0.0)
            else:
                if held <= 0:
                    continue
                sold = min(-q, held)
                basis = cost * sold / held
                proceeds = sold * p
                gain = proceeds - basis
                held -= sold
                cost -= basis
                if held * p < 0.005:
                    held, cost = 0.0, 0.0
                per_year[y]["proceeds"] += proceeds
                per_year[y]["cost"] += basis
                per_year[y]["realized"] += gain
                per_year[y]["sells"] += proceeds
                per_year[y]["trades"] += 1
                realized_by[k, j] += gain
                tx_date.append(i); tx_ticker.append(j); tx_kind.append("sell")
                tx_qty.append(sold); tx_price.append(p); tx_amount.append(proceeds); tx_gain.append(gain)
                tx_shares.append(held); tx_acb.append(cost / held if held > 0 else 0.0)
        close_years(len(idx))
        last_p = price[pvalid][-1] if pvalid.any() else np.nan
        if held > 0:
            mv = held * last_p if np.isfinite(last_p) else None
            positions.append({
                "ticker": t,
                "shares": round(held, 6),
                "acb": round(cost, 2),
                "acb_per_share": round(cost / held, 6),
                "price": round(float(last_p), 4) if np.isfinite(last_p) else None,
                "market_value": round(mv, 2) if mv is not None else None,
                "unrealized": round(mv - cost, 2) if mv is not None else None,
            })

    contrib = {y: 0.0 for y in year_list}
    initial = float(cfg.get("initial_value", 0) or 0)
    if year_list:
        contrib[int(wa.index[0].year)] = contrib.get(int(wa.index[0].year), 0.0) + initial
        amount = float(cfg.get("added_amount", 0) or 0)
        for d in contribution_dates(cfg, wa.index):
            if d.year in contrib:
                contrib[d.year] += amount

    year_rows = []
    for y in year_list:
        s = per_year[y]
        year_rows.append({
            "year": y,
            "proceeds": round(s["proceeds"], 2),
            "cost_base": round(s["cost"], 2),
            "realized": round(s["realized"], 2),
            "dividends": round(s["dividends"], 2),
            "contributions": round(contrib.get(y, 0.0), 2),
            "buys": round(s["buys"], 2),
            "sells": round(s["sells"], 2),
            "trades": s["trades"],
            "market_value_end": round(s["market_value"], 2),
            "acb_end": round(s["acb"], 2),
            "unrealized_end": round(s["market_value"] - s["acb"], 2),
        })

    order = np.argsort(np.asarray(tx_date, dtype=np.int64), kind="stable") if tx_date else np.zeros(0, dtype=np.int64)
    truncated = len(order) > MAX_TRANSACTIONS
    if truncated:
        order = order[-MAX_TRANSACTIONS:]
    used_dates = sorted({tx_date[k] for k in order})
    dpos = {i: n for n, i in enumerate(used_dates)}
    transactions = {
        "dates": [date_key(idx[i]) for i in used_dates],
        "tickers": tickers,
        "date_idx": [dpos[tx_date[k]] for k in order],
        "ticker_idx": [tx_ticker[k] for k in order],
        "kind": [tx_kind[k] for k in order],
        "qty": [round(tx_qty[k], 6) for k in order],
        "price": [round(tx_price[k], 4) for k in order],
        "amount": [round(tx_amount[k], 2) for k in order],
        "gain": [None if tx_gain[k] is None else round(tx_gain[k], 2) for k in order],
        "shares_after": [round(tx_shares[k], 6) for k in order],
        "acb_per_share": [round(tx_acb[k], 6) for k in order],
        "total": len(tx_date),
        "truncated": truncated,
    }
    return {
        "transactions": transactions,
        "years": year_rows,
        "by_ticker": {
            "years": year_list,
            "tickers": tickers,
            "realized": [_r(row, 2) for row in realized_by],
            "dividends": [_r(row, 2) for row in dividends_by],
        },
        "positions": positions,
        "dividends_reinvested": not collect_cash,
    }
