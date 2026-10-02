"""Data behind the Allocations page: fundamentals table and benchmark comparison.

Mirrors the display code of Streamlit's 2_Allocations.py (build_comprehensive_portfolio_table
and calculate_benchmark_returns), which lives in top-level UI blocks and so cannot be
extracted. The helpers it calls (aliases, custom sectors, yahooquery batch) come from the
extracted legacy.allocations module.

Yahoo hygiene: fundamentals change slowly, so each resolved symbol is kept 24 h on disk and
only the symbols missing from that cache go to yahooquery (one batch call).
"""

from __future__ import annotations

import contextlib
import io
import math
import threading
from datetime import datetime
from typing import Any

import numpy as np
import pandas as pd

from . import activate_engine_home
from . import yahoo as Y

_lock = threading.Lock()
INFO_TTL = 24 * 3600
_MISS = object()

BENCHMARKS = ["SPY", "QQQ", "SPMO", "VTI", "VT", "SSO", "QLD", "BITCOIN"]
PERIODS = {"1W": 7, "1M": 30, "3M": 90, "6M": 180, "1Y": 365}
COMMODITIES = {"GLD", "SLV", "USO", "UNG"}


def _alloc():
    activate_engine_home()
    from .legacy import allocations as A

    return A


def _legacy():
    activate_engine_home()
    from .legacy import multi_backtest as L

    return L


def _resolved_symbol(A, ticker: str) -> str:
    base, _ = A.parse_leverage_ticker(ticker)
    lev = A.get_leveraged_ticker_underlying()
    return lev[base.upper()] if base.upper() in lev else A.resolve_ticker_alias(base, for_stats=True)


def infos(tickers: list[str]) -> dict[str, dict]:
    """get_multiple_tickers_info_batch with a 24 h disk cache per resolved symbol."""
    A = _alloc()
    from .st_shim import st

    wanted = [t for t in dict.fromkeys(tickers) if t and t != "CASH"]
    if not wanted:
        return {}
    cache = Y.open_cache()
    with _lock, contextlib.redirect_stdout(io.StringIO()):
        resolved = {t: _resolved_symbol(A, t) for t in wanted}
        merged: dict[str, dict] = {}
        for r in set(resolved.values()):
            hit = cache.get(f"__info__:{r}", default=_MISS)
            if hit is not _MISS:
                merged[r] = hit
        before = set(merged)
        st.session_state["alloc_page2_info_by_resolved"] = merged
        st.session_state.setdefault("api_call_count", 0)
        out = A.get_multiple_tickers_info_batch(wanted) or {}
        for r, blob in merged.items():
            if r not in before and blob:
                cache.set(f"__info__:{r}", blob, expire=INFO_TTL)
    return out


def _num(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, dict):
        v = v.get("raw")
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def _first(info: dict, *keys: str) -> Any:
    for k in keys:
        v = info.get(k)
        if v:
            return v
    return None


def _scaled(info: dict, keys: tuple[str, ...], factor: float, skip: bool) -> float | None:
    v = _num(_first(info, *keys))
    return None if skip or v is None else v * factor


def _yield_pct(info: dict) -> float | None:
    """yahooquery yields are decimals (0.0032) and Streamlit printed them as-is next to a "%".
    Values above 1 would be a >100 % yield, so those are taken as already in percent."""
    v = _num(_first(info, "dividendYield", "yield"))
    if v is None:
        return None
    return v if v > 1 else v * 100


def _row(A, ticker: str, info: dict, alloc_pct: float, portfolio_value: float, price: float | None) -> dict[str, Any]:
    quote_type = str(info.get("quoteType") or "").lower()
    is_commodity = ticker in COMMODITIES or "gold" in str(info.get("longName") or "").lower()
    if price is None:
        price = _num(_first(info, "currentPrice", "regularMarketPrice", "price", "lastPrice", "close",
                            "regularMarketPreviousClose", "previousClose"))
    value = portfolio_value * alloc_pct
    shares = round(value / price, 1) if price and price > 0 else 0.0
    total = shares * price if price else value

    sector = A.get_custom_sector_for_ticker(ticker) or info.get("sector") or info.get("industrySector") or "N/A"
    industry = A.get_custom_industry_for_ticker(ticker) or info.get("industry") or info.get("industryClassification") or "N/A"
    c = is_commodity
    rec = _first(info, "recommendationKey", "recommendationMean")
    row: dict[str, Any] = {
        "ticker": ticker,
        "name": _first(info, "longName", "shortName", "companyName", "name", "displayName", "title") or "N/A",
        "quote_type": quote_type or None,
        "sector": sector,
        "industry": industry,
        "price": price,
        "alloc_pct": alloc_pct * 100,
        "shares": shares,
        "value": total,
        "pct_of_portfolio": (total / portfolio_value * 100) if portfolio_value > 0 else 0.0,
        "market_cap_b": _scaled(info, ("marketCap", "totalAssets", "marketCapitalization"), 1e-9, c),
        "enterprise_value_b": _scaled(info, ("enterpriseValue",), 1e-9, c),
        "pe": _num(_first(info, "trailingPE", "priceEarnings", "pe", "peRatio")),
        "forward_pe": None if c else _num(_first(info, "forwardPE", "forwardPERatio")),
        "peg": None,
        "peg_source": "N/A",
        "price_book": None if c else _num(_first(info, "priceToBook", "priceBook", "pb", "pbRatio")),
        "price_sales": None if c else _num(_first(info, "priceToSalesTrailing12Months", "priceToSales", "ps", "psRatio")),
        "price_cash_flow": None if c else _num(_first(info, "priceToCashflow", "priceCashflow", "pcf", "pcfRatio")),
        "ev_ebitda": None if c else _num(_first(info, "enterpriseToEbitda", "evToEbitda", "evEbitda", "evEbitdaRatio")),
        "fcf_b": _scaled(info, ("freeCashflow",), 1e-9, c),
        "fcf_yield": None,
        "price_fcf": None,
        "shares_outstanding_m": _scaled(info, ("sharesOutstanding",), 1e-6, c),
        "float_shares_m": _scaled(info, ("floatShares",), 1e-6, c),
        "revenue_b": _scaled(info, ("totalRevenue",), 1e-9, c),
        "earnings_b": None,
        "debt_equity": None if c else _num(_first(info, "debtToEquity", "debtEquity", "debtEquityRatio")),
        "current_ratio": None if c else _num(_first(info, "currentRatio", "currentRatioRatio")),
        "quick_ratio": None if c else _num(_first(info, "quickRatio", "quickRatioRatio")),
        "roe": _scaled(info, ("returnOnEquity", "roe"), 100, c),
        "roa": _scaled(info, ("returnOnAssets", "roa"), 100, c),
        "roic": _scaled(info, ("returnOnInvestedCapital", "roic"), 100, c),
        "total_debt_b": _scaled(info, ("totalDebt",), 1e-9, c),
        "net_debt_b": None,
        "working_capital_b": None,
        "interest_coverage": None,
        "revenue_growth": _scaled(info, ("revenueGrowth", "revenueGrowthRate"), 100, c),
        "earnings_growth": _scaled(info, ("earningsGrowth", "earningsGrowthRate"), 100, c),
        "eps_growth": _scaled(info, ("earningsQuarterlyGrowth", "epsGrowth", "earningsGrowth"), 100, c),
        "dividend_yield": _yield_pct(info),
        "dividend_rate": _num(_first(info, "dividendRate", "dividend")),
        "payout_ratio": _scaled(info, ("payoutRatio",), 100, c),
        "dividend_growth_5y": _num(_first(info, "fiveYearAvgDividendYield", "dividendGrowth")),
        "high_52w": _num(_first(info, "fiftyTwoWeekHigh", "52WeekHigh")),
        "low_52w": _num(_first(info, "fiftyTwoWeekLow", "52WeekLow")),
        "ma_50": _num(_first(info, "fiftyDayAverage", "50DayAverage")),
        "ma_200": _num(_first(info, "twoHundredDayAverage", "200DayAverage")),
        "beta": _num(_first(info, "beta", "beta3Year", "beta5Year")),
        "volume": _num(_first(info, "volume", "regularMarketVolume")),
        "avg_volume": _num(_first(info, "averageVolume", "avgVolume")),
        "analyst_rating": str(rec).title() if rec and not c else "N/A",
        "target_price": None if c else _num(_first(info, "targetMeanPrice", "targetHighPrice", "targetPrice")),
        "target_high": None if c else _num(_first(info, "targetHighPrice", "targetHigh")),
        "target_low": None if c else _num(_first(info, "targetLowPrice", "targetLow")),
        "book_value": None if c else _num(_first(info, "bookValue", "bookValuePerShare")),
        "cash_per_share": None if c else _num(_first(info, "totalCashPerShare", "cashPerShare")),
        "revenue_per_share": None if c else _num(_first(info, "revenuePerShare")),
        "profit_margin": _scaled(info, ("profitMargins", "profitMargin"), 100, c),
        "operating_margin": _scaled(info, ("operatingMargins", "operatingMargin"), 100, c),
        "gross_margin": _scaled(info, ("grossMargins", "grossMargin"), 100, c),
        "interest_coverage_unbounded": False,
    }

    eps, so = _num(info.get("trailingEps")), _num(info.get("sharesOutstanding"))
    if eps and so and not c:
        row["earnings_b"] = eps * so / 1e9

    pe, growth = _num(info.get("trailingPE")), _num(info.get("earningsGrowth"))
    if not c and pe and pe > 0 and growth and growth > 0:
        row["peg"] = pe / (growth * 100)
        row["peg_source"] = "P/E ÷ Earnings Growth"

    fcf, mcap = _num(info.get("freeCashflow")), _num(info.get("marketCap"))
    if not c and fcf and mcap and mcap > 0:
        row["fcf_yield"] = fcf / mcap * 100
        if fcf > 0:
            row["price_fcf"] = mcap / fcf

    debt = _num(info.get("totalDebt"))
    if not c and debt is not None:
        net = (debt - (_num(info.get("totalCash")) or 0)) / 1e9
        row["net_debt_b"] = net if net >= 0 else 0

    assets, liabilities = _num(info.get("totalCurrentAssets")), _num(info.get("totalCurrentLiabilities"))
    if not c and assets and liabilities:
        row["working_capital_b"] = (assets - liabilities) / 1e9

    ebit, interest = _num(info.get("ebit")) or 0, _num(info.get("interestExpense")) or 0
    if not c and ebit and interest > 0:
        row["interest_coverage"] = ebit / interest
    elif not c and interest == 0 and ebit > 0:
        row["interest_coverage_unbounded"] = True

    ebitda = _num(info.get("ebitda"))
    if row["enterprise_value_b"] and ebitda and ebitda > 0:
        row["ev_ebitda"] = row["enterprise_value_b"] * 1e9 / ebitda
    return row


def _dual_class(rows: list[dict[str, Any]], infos_by_ticker: dict[str, dict]) -> None:
    """Share classes of one company (BRK-A / BRK-B): rescale per-share data from the pricier class."""
    per_share = ("book_value", "cash_per_share", "revenue_per_share")
    seen: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        price = row["price"]
        if not price or price <= 0:
            continue
        base = row["ticker"].split("-")[0]
        for other in seen.get(base, []):
            ratio = price / other["price"]
            if (ratio > 10 or ratio < 0.1) and price < other["price"]:
                for f in per_share:
                    if row[f] and other[f]:
                        row[f] = other[f] * ratio
                if other["enterprise_value_b"] is not None:
                    row["enterprise_value_b"] = other["enterprise_value_b"]
                    ebitda = _num(infos_by_ticker.get(row["ticker"], {}).get("ebitda"))
                    if ebitda and ebitda > 0:
                        row["ev_ebitda"] = row["enterprise_value_b"] * 1e9 / ebitda
            break
        seen.setdefault(base, []).append(row)
    for row in rows:
        bv = row["book_value"]
        if row["price"] and bv and bv > 0:
            row["price_book"] = row["price"] / bv
        elif row["price"] and bv == 0:
            row["price_book"] = None


WEIGHTED_FIELDS = {
    "pe": "P/E", "forward_pe": "P/E", "peg": "PEG", "price_book": "ratio", "price_sales": "ratio",
    "ev_ebitda": "ratio", "price_fcf": "ratio", "fcf_yield": "", "interest_coverage": "ratio",
    "roe": "", "roa": "", "roic": "", "debt_equity": "ratio", "current_ratio": "ratio", "quick_ratio": "ratio",
    "profit_margin": "", "operating_margin": "", "gross_margin": "", "revenue_growth": "", "earnings_growth": "",
    "eps_growth": "", "dividend_yield": "", "payout_ratio": "", "dividend_growth_5y": "", "market_cap_b": "",
    "enterprise_value_b": "", "beta": "beta",
}


def weighted_average(rows: list[dict[str, Any]], field: str) -> float | None:
    """Streamlit weighted_average: weights = % of portfolio, with its per-metric sanity filters."""
    kind = WEIGHTED_FIELDS.get(field, "")
    num = den = 0.0
    for r in rows:
        v, w = r.get(field), r.get("pct_of_portfolio")
        if v is None or w is None:
            continue
        if kind in ("P/E", "PEG") and not (0 < v <= 1000):
            continue
        if kind == "beta" and not (-5 <= v <= 5):
            continue
        if kind == "ratio" and v < 0:
            continue
        num += v * w / 100
        den += w / 100
    return num / den if den else None


def fundamentals(weights: dict[str, float], portfolio_value: float, prices: dict[str, float | None] | None = None) -> dict[str, Any]:
    A = _alloc()
    prices = prices or {}
    tickers = [t for t, w in weights.items() if t != "CASH" and (w or 0) > 0]
    info_map = infos(tickers)
    rows = []
    for t in tickers:
        try:
            rows.append(_row(A, t, info_map.get(t) or {}, float(weights[t]), float(portfolio_value), _num(prices.get(t))))
        except Exception as exc:  # keep the table usable, like Streamlit
            value = portfolio_value * float(weights[t])
            rows.append({"ticker": t, "name": f"Erreur : {exc}", "alloc_pct": float(weights[t]) * 100, "shares": 0,
                         "value": value, "pct_of_portfolio": value / portfolio_value * 100 if portfolio_value else 0})
    _dual_class(rows, info_map)

    def group(key: str) -> list[list[Any]]:
        acc: dict[str, float] = {}
        for r in rows:
            acc[r.get(key) or "N/A"] = acc.get(r.get(key) or "N/A", 0.0) + r["alloc_pct"]
        return [[k, v] for k, v in sorted(acc.items(), key=lambda kv: -kv[1])]

    return {
        "as_of": datetime.now().strftime("%Y-%m-%d"),
        "portfolio_value": portfolio_value,
        "rows": rows,
        "weighted": {f: weighted_average(rows, f) for f in WEIGHTED_FIELDS},
        "sectors": group("sector"),
        "industries": group("industry"),
    }


def _close(df: pd.DataFrame | None) -> pd.Series | None:
    if not isinstance(df, pd.DataFrame) or df.empty or "Close" not in df.columns:
        return None
    s = df["Close"].dropna()
    s.index = pd.to_datetime(s.index)
    if getattr(s.index, "tz", None) is not None:
        s.index = s.index.tz_localize(None)
    return s


def _value_days_ago(s: pd.Series, days: int) -> float | None:
    prior = s.loc[: s.index[-1] - pd.Timedelta(days=days)]
    return float(prior.iloc[-1] if len(prior) else s.iloc[0])


def _period_returns(s: pd.Series) -> dict[str, float | None]:
    out: dict[str, float | None] = {}
    for name, days in PERIODS.items():
        past = _value_days_ago(s, days)
        out[name] = (float(s.iloc[-1]) - past) / past * 100 if past and past > 0 else None
    return out


def _annualized_vol(rets: pd.Series) -> float | None:
    """Std of the observed returns scaled by their own frequency (~252/yr for stocks, ~365 for crypto)."""
    rets = rets.dropna()
    if len(rets) < 20:
        return None
    span = (rets.index[-1] - rets.index[0]).days
    per_year = len(rets) * 365.25 / span if span > 0 else 252.0
    return float(rets.std() * np.sqrt(per_year) * 100)


def _beta(rets: pd.Series, bench_rets: pd.Series) -> float | None:
    idx = rets.index.intersection(bench_rets.index)
    if len(idx) < 3:
        return None
    t, b = rets.loc[idx], bench_rets.loc[idx]
    var = b.var()
    if not var or np.isnan(var):
        return None
    beta = t.cov(b) / var
    return None if np.isnan(beta) else float(beta)


def _last_year_returns(s: pd.Series) -> pd.Series:
    return s.loc[s.index[-1] - pd.Timedelta(days=365):].pct_change().dropna()


def returns_summary(
    weights: dict[str, float],
    metrics: dict[str, dict[str, float | None]] | None,
    benchmark_ticker: str | None,
    portfolio: dict[str, list] | None,
) -> list[dict[str, Any]]:
    """Returns Summary of 2_Allocations.py (calculate_returns_table), one row per ticker of the final allocation.

    Momentum / Beta / Volatility come from the last momentum metrics when present. Otherwise beta and
    volatility are measured over the last 365 days: on trading-day returns annualized at their own
    frequency (Streamlit forward-filled weekends and used sqrt(252), which understates volatility), and
    beta against the portfolio benchmark (^GSPC by default). The PORTFOLIO HISTORICAL row looks back in
    calendar days like the ticker rows (Streamlit counted rows of the daily curve, 365 rows ≈ 17 months).
    """
    tickers = [t for t in weights if t and t.upper() != "CASH"]
    bench_ticker = benchmark_ticker or "^GSPC"
    hist = _histories(list(dict.fromkeys(tickers + [bench_ticker])))
    bench = hist.get(bench_ticker)
    bench_rets = _last_year_returns(bench) if bench is not None and len(bench) > 2 else None
    metrics = metrics or {}

    def pct(v: Any, scale_small: bool = False) -> float | None:
        x = _num(v)
        if x is None:
            return None
        return x * 100 if not scale_small or x <= 3 else x

    rows: list[dict[str, Any]] = []
    for t in tickers:
        s = hist.get(t)
        if s is None or not len(s):
            continue
        m = metrics.get(t) or {}
        row: dict[str, Any] = {
            "ticker": t,
            "weight": float(weights.get(t) or 0),
            "momentum": pct(m.get("Momentum")),
            "beta": _num(m.get("Beta")),
            "volatility": pct(m.get("Volatility"), scale_small=True),
        }
        row.update(_period_returns(s))
        rows.append(row)

    # Streamlit fills a column only when no ticker has it from the metrics.
    need_beta = not any(r["beta"] is not None for r in rows)
    need_vol = not any(r["volatility"] is not None for r in rows)
    if need_beta or need_vol:
        for r in rows:
            rets = _last_year_returns(hist[r["ticker"]])
            if need_vol:
                r["volatility"] = _annualized_vol(rets)
            if need_beta and bench_rets is not None:
                r["beta"] = _beta(rets, bench_rets)

    rows.sort(key=lambda r: (r["weight"] <= 0.0001, r["ticker"]))

    if portfolio and portfolio.get("dates"):
        s = pd.Series(portfolio["values"], index=pd.to_datetime(portfolio["dates"]), dtype=float).dropna()
        if len(s):
            row = {"ticker": "PORTFOLIO HISTORICAL", "weight": 1.0, "momentum": None, "portfolio": True}
            row.update(_period_returns(s))
            rets = _last_year_returns(s)
            row["volatility"] = _annualized_vol(rets)
            row["beta"] = _beta(rets, bench_rets) if bench_rets is not None else None
            rows.append(row)
    return rows


def _histories(tickers: list[str]) -> dict[str, pd.Series]:
    from .data_api import price_frames

    frames, _report = price_frames(tickers, "topup")
    out = {}
    for t in tickers:
        s = _close(frames.get(t))
        if s is not None and len(s):
            out[t] = s
    return out


def benchmarks(portfolio: dict[str, list] | None, benchmark_ticker: str | None, portfolio_pe: float | None) -> list[dict[str, Any]]:
    """Benchmark comparison table: the portfolio's no_additions series first, then BENCHMARKS."""
    A = _alloc()
    extra = [benchmark_ticker] if benchmark_ticker and benchmark_ticker not in BENCHMARKS else []
    hist = _histories(BENCHMARKS + extra)
    info_map = infos(BENCHMARKS)
    rows: list[dict[str, Any]] = []

    spy = hist.get("SPY")
    if portfolio and portfolio.get("dates"):
        s = pd.Series(portfolio["values"], index=pd.to_datetime(portfolio["dates"]), dtype=float).dropna()
        row: dict[str, Any] = {"ticker": "PORTFOLIO", "pe": portfolio_pe, "volatility": None, "beta": None}
        row.update(_period_returns(s) if len(s) else {k: None for k in PERIODS})
        window = None
        if len(s) > 60:
            start = s.index[-1] - pd.Timedelta(days=365)
            window = s.loc[start:]
            rets = window.pct_change().dropna()
            if spy is not None:
                spy_w = spy.loc[start:]
                if len(spy_w):
                    rets = window.reindex(spy_w.index, method="ffill").pct_change().dropna()
                    common = rets.index.intersection(spy_w.index)
                    if len(common) >= 60:
                        rets = rets.reindex(common).dropna()
            if len(rets) >= 60:
                row["volatility"] = _annualized_vol(rets)
        bench = hist.get(benchmark_ticker or "^GSPC") if benchmark_ticker else None
        if window is not None and bench is not None:
            b = bench.reindex(window.index, method="ffill")
            p = window.reindex(b.index).dropna()
            b = b.reindex(p.index).dropna()
            pr, br = p.pct_change().fillna(0), b.pct_change().fillna(0)
            idx = pr.index.intersection(br.index)
            if len(idx) >= 2 and br.loc[idx].var() != 0:
                beta = pr.loc[idx].cov(br.loc[idx]) / br.loc[idx].var()
                row["beta"] = None if np.isnan(beta) else float(beta)
        rows.append(row)

    for t in BENCHMARKS:
        s = hist.get(t)
        if s is None:
            continue
        pe = _num(A._flatten_yahooquery_fundamentals_row(info_map.get(t) or {}).get("trailingPE"))
        row = {"ticker": t, "pe": pe, "volatility": None, "beta": None}
        row.update(_period_returns(s))
        if len(s) >= 60:
            start = s.index[-1] - pd.Timedelta(days=365)
            rets = s.loc[start:].pct_change().dropna()
            if len(rets) >= 60:
                row["volatility"] = _annualized_vol(rets)
                if t == "SPY":
                    row["beta"] = 1.0
                elif spy is not None and len(spy) >= 60:
                    spy_r = spy.loc[start:].pct_change().dropna()
                    idx = rets.index.intersection(spy_r.index)
                    if len(idx) >= 60:
                        tr, sr = rets.reindex(idx).dropna(), spy_r.reindex(idx).dropna()
                        corr = tr.corr(sr)
                        row["beta"] = float(corr * (tr.std() / sr.std())) if sr.std() > 0 and not np.isnan(corr) else 1.0
        rows.append(row)
    return rows
