"""Fast paths for the legacy backtest loop, with results identical to the legacy code.

The legacy single_backtest (generated from the Streamlit page) reads prices with one pandas
lookup per ticker and per calendar day (`df.loc[date, "Close"]`, `date in df.index`...), which
dominates the run time. Every frame it reads is reindexed on the simulation calendar, so the same
values sit at position i of plain numpy arrays.

`single_backtest_fast.py` is a copy of the legacy function where only those reads change (plus a
few constants hoisted out of the day loop). It is compiled inside the legacy module namespace, so
every helper it calls is the legacy one (including the engine's patches of legacy helpers).
A frame that is not aligned on the calendar keeps the legacy lookups.

The regression gate (tests/regression) runs the engine with this path and compares every
series, allocation and metric with the approved baseline. Set ENGINE_LEGACY_LOOP=1 to run the
original function instead (comparison / debugging).

When the legacy module is regenerated from a changed Streamlit page, update the copy the same way
(diff `single_backtest` against `single_backtest_fast`).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


class _Arrays:
    """Columns of one calendar-aligned frame as numpy arrays (positional reads)."""

    __slots__ = ("index", "ns", "close", "dividends", "div_values", "div_has_nan", "pchg_series", "pchg_values", "has_close")

    def __init__(self, df: pd.DataFrame) -> None:
        self.index = df.index
        # int64 nanoseconds of the index: binary searches without boxing Timestamps
        self.ns = df.index.as_unit("ns").asi8 if isinstance(df.index, pd.DatetimeIndex) and df.index.tz is None else None
        close = df["Close"]
        self.close = close.to_numpy()
        # legacy: `not df_t['Close'].dropna().empty`, asked again for every ticker at every rebalance
        self.has_close = bool(close.notna().any())
        self.dividends = df["Dividends"] if "Dividends" in df.columns else None
        dv = self.dividends.to_numpy() if self.dividends is not None else None
        self.div_values = dv if dv is not None and dv.dtype == np.float64 else None
        self.div_has_nan = bool(np.isnan(self.div_values).any()) if self.div_values is not None else True
        self.pchg_series = df["Price_change"] if "Price_change" in df.columns else None
        pv = self.pchg_series.to_numpy() if self.pchg_series is not None else None
        # Windows read these values directly when they hold no NaN (pandas' var then masks nothing).
        self.pchg_values = pv if pv is not None and pv.dtype == np.float64 and not np.isnan(pv).any() else None

    def dividend_sum(self, start: int, stop: int) -> Any:
        """df.loc[a:b, 'Dividends'].fillna(0).sum() for positions start..stop-1 (same pairwise sum)."""
        if self.div_values is None:
            return self.dividends.iloc[start:stop].fillna(0).sum()
        part = self.div_values[start:stop]
        if not self.div_has_nan:
            return part.sum()
        return np.where(np.isnan(part), 0.0, part).sum()

    def asof_pos(self, label: Any) -> int:
        """Position of DatetimeIndex.asof(label): last index entry <= label, -1 if none."""
        if self.ns is not None and isinstance(label, pd.Timestamp) and label.tz is None:
            return int(np.searchsorted(self.ns, label.value, side="right")) - 1
        return int(self.index.searchsorted(label, side="right")) - 1


def _aligned(df: Any, sim_index: pd.DatetimeIndex) -> bool:
    return isinstance(df, pd.DataFrame) and df.index is not None and df.index.is_unique and df.index.equals(sim_index)


def accel_arrays(reindexed_data: dict, sim_index: pd.DatetimeIndex, tickers: list) -> dict:
    out: dict[str, _Arrays] = {}
    for t in tickers:
        if t in out:
            continue
        df = reindexed_data.get(t)
        if _aligned(df, sim_index) and "Close" in df.columns:
            out[t] = _Arrays(df)
    return out


def _bound(a: "_Arrays", label: Any, side: str) -> int:
    if a.ns is not None and isinstance(label, pd.Timestamp) and label.tz is None:
        return int(np.searchsorted(a.ns, label.value, side=side))
    return int(a.index.searchsorted(label, side=side))


class _Window:
    """Price_change values of a date window. Behaves like the Series the legacy code built
    (len, .std(), np.var / np.cov) and only builds that Series when something else is asked."""

    __slots__ = ("_a", "_lo", "_hi", "values")

    def __init__(self, a: "_Arrays", lo: int, hi: int) -> None:
        self._a, self._lo, self._hi = a, lo, hi
        self.values = a.pchg_values[lo:hi]

    def __len__(self) -> int:
        return len(self.values)

    def __array__(self, dtype: Any = None, copy: Any = None) -> np.ndarray:
        return self.values if dtype is None else self.values.astype(dtype)

    def series(self) -> pd.Series:
        return self._a.pchg_series.iloc[self._lo:self._hi]

    def std(self) -> Any:
        return _pandas_std(self.values, 1)

    def var(self, ddof: int = 1, **_kw: Any) -> Any:
        return _pandas_var(self.values, ddof)


def accel_window(acc: dict, t: str, df: pd.DataFrame, start: Any, end: Any) -> Any:
    """df.loc[(df.index >= start) & (df.index <= end), 'Price_change'] for a sorted, unique index."""
    a = acc.get(t)
    if a is None or a.pchg_series is None or df is None or df.index is not a.index:
        mask = (df.index >= start) & (df.index <= end)
        return df.loc[mask, "Price_change"]
    lo = _bound(a, start, "left")
    hi = _bound(a, end, "right")
    if a.pchg_values is None or not _STATS_OK:
        return a.pchg_series.iloc[lo:hi]
    return _Window(a, lo, hi)


# Series.var / Series.std of a float64 window without NaN, with pandas' own two-pass formula
# (nanops.nanvar). Only used after _self_check() proved it bit-identical to the pandas installed.
def _pandas_var(values: np.ndarray, ddof: int) -> Any:
    count = np.float64(values.size)
    d = count - ddof
    if count <= ddof:
        return np.float64(np.nan)
    avg = values.sum(dtype=np.float64) / count
    sqr = (avg - values) ** 2
    return sqr.sum(dtype=np.float64) / d


def _pandas_std(values: np.ndarray, ddof: int) -> Any:
    return np.sqrt(_pandas_var(values, ddof))


def _self_check() -> bool:
    rng = np.random.default_rng(7)
    try:
        for n in (0, 1, 2, 3, 7, 64, 250, 335, 1001):
            for _ in range(6):
                x = rng.standard_t(3, n) * 0.02
                if n > 5:
                    x[rng.integers(0, n, 3)] = 0.0
                s = pd.Series(x, index=pd.date_range("2000-01-01", periods=n, freq="D"), name="Price_change")
                if not _same(s.std(), _pandas_std(x, 1)) or not _same(s.var(ddof=0), _pandas_var(x, 0)) \
                        or not _same(np.var(s), _pandas_var(x, 0)):
                    return False
    except Exception:  # noqa: BLE001
        return False
    return True


def _same(a: Any, b: Any) -> bool:
    a, b = float(a), float(b)
    return (np.isnan(a) and np.isnan(b)) or a == b


_STATS_OK = _self_check()


class _Day:
    """Per-ticker values the day loop reads, already resolved like the legacy branches."""

    __slots__ = ("close", "div", "pchg", "leveraged", "base_close", "first_ok")

    def __init__(self) -> None:
        self.close = self.div = self.pchg = self.base_close = self.first_ok = None
        self.leveraged = False


def accel_day_readers(acc: dict, reindexed_data: dict, tickers: list, sim_index: pd.DatetimeIndex,
                      parse_ticker_parameters: Any) -> dict:
    out: dict[str, _Day] = {}
    for t in tickers:
        df = reindexed_data.get(t)
        if not _aligned(df, sim_index) or "Close" not in df.columns or "Price_change" not in df.columns:
            continue
        close = df["Close"].to_numpy()
        pchg = df["Price_change"].to_numpy()
        if close.dtype != np.float64 or pchg.dtype != np.float64:
            continue  # unusual frame: keep the legacy lookups for this ticker
        d = _Day()
        # Lists of numpy float64 scalars: the very objects .loc returned (not Python floats: built-in
        # sum() adds exact Python floats with compensated summation, numpy scalars plainly).
        d.close = list(close)
        d.pchg = list(pchg)
        # Legacy daily-allocation test: reindexed_data[t].loc[date] is the row, its first value tested with pd.isna.
        d.first_ok = (~pd.isna(df.iloc[:, 0].to_numpy())).tolist() if df.shape[1] > 0 else [False] * len(df)
        if "?L=" in t or "?E=" in t:
            d.leveraged = True
            base_ticker, _lev, _er = parse_ticker_parameters(t)
            if base_ticker in reindexed_data:
                base_df = reindexed_data[base_ticker]
                if not _aligned(base_df, sim_index) or "Close" not in base_df.columns:
                    continue  # unusual base frame: keep the legacy lookups for this ticker
                bc = base_df["Close"].to_numpy()
                if bc.dtype != np.float64:
                    continue
                d.base_close = list(bc)
                if "Dividends" in base_df.columns:
                    bd = base_df["Dividends"].to_numpy()
                    if bd.dtype != np.float64:
                        continue
                    d.div = list(bd)
        elif "Dividends" in df.columns:
            dv = df["Dividends"].to_numpy()
            if dv.dtype != np.float64:
                continue
            d.div = list(dv)
        out[t] = d
    return out


_SRC = Path(__file__).with_name("single_backtest_fast.py")
_installed = False


def install(original_ma_crossings: Any = None) -> None:
    """Compiles the fast copy inside the legacy namespace and makes it the engine's single_backtest;
    swaps the MA filter table for the array version. ENGINE_LEGACY_LOOP=1 keeps the legacy functions."""
    global _installed
    if _installed:
        return
    from ..legacy import multi_backtest as L

    ns = L.__dict__
    ns["_accel_legacy_ma_crossings"] = original_ma_crossings or L.precompute_ma_crossings
    ns.setdefault("precompute_ma_filters_legacy", L.precompute_ma_filters)
    ns.setdefault("get_dates_by_freq_legacy", L.get_dates_by_freq)
    ns["_accel_arrays"] = accel_arrays
    ns["_accel_window"] = accel_window
    ns["_accel_day_readers"] = lambda acc, data, tickers, idx: accel_day_readers(acc, data, tickers, idx, L.parse_ticker_parameters)
    code = compile(_SRC.read_text(encoding="utf-8"), str(_SRC), "exec")
    exec(code, ns)  # noqa: S102 - engine source file, defines single_backtest_fast in the legacy module
    ns.setdefault("single_backtest_legacy", L.single_backtest)
    if not legacy_mode():
        L.single_backtest = ns["single_backtest_fast"]
        L.precompute_ma_filters = make_ma_filters(ns["precompute_ma_filters_legacy"], L.resolve_ticker_alias)
        L.get_dates_by_freq = make_dates_by_freq(ns["get_dates_by_freq_legacy"])
    _installed = True


def legacy_mode() -> bool:
    return os.environ.get("ENGINE_LEGACY_LOOP") == "1"


def ma_crossings_impl(original: Any) -> Any:
    return original if legacy_mode() else fast_ma_crossings


# ---------------------------------------------------------------------------------------------
# MA filter / MA cross tables: same dicts as the legacy precompute_* functions, built from arrays.
# ---------------------------------------------------------------------------------------------

def _plain_sorted_index(idx: Any) -> bool:
    return isinstance(idx, pd.DatetimeIndex) and idx.is_unique and idx.is_monotonic_increasing and not idx.hasnans


def _float_columns(df: pd.DataFrame) -> bool:
    """Close and MA_* columns are float arrays (the positional comparisons then match .loc reads)."""
    return all(df[c].dtype.kind == 'f' for c in df.columns if c == 'Close' or str(c).startswith('MA_'))


def make_ma_filters(legacy_fn: Any, resolve_ticker_alias: Any):
    """precompute_ma_filters with one searchsorted per (reference frame) instead of a boolean mask per
    (date, ticker). Falls back to the legacy function for frames it cannot read positionally."""

    def precompute_ma_filters(reindexed_data, ma_window, ma_type='SMA', ma_multiplier=1.48, stocks_config=None, config=None):
        frames = [df for df in reindexed_data.values() if df is not None and isinstance(df, pd.DataFrame)]
        if not frames or not all(_plain_sorted_index(df.index) and _float_columns(df) for df in frames):
            return legacy_fn(reindexed_data, ma_window, ma_type, ma_multiplier, stocks_config, config)
        ma_col_name = f"MA_{ma_type}_{ma_window}"
        global_ref = None
        if config and config.get('use_global_ma_reference') and (config.get('global_ma_reference_ticker') or '').strip():
            global_ref = resolve_ticker_alias((config.get('global_ma_reference_ticker') or '').strip())
        include_in_ma: dict = {}
        ma_reference: dict = {}
        if stocks_config:
            for stock in stocks_config:
                ticker = stock.get('ticker')
                if ticker:
                    include_in_ma[ticker] = stock.get('include_in_sma_filter', True)
                    if global_ref:
                        ma_reference[ticker] = global_ref
                    else:
                        ref = stock.get('ma_reference_ticker', '').strip()
                        if ref:
                            ref = resolve_ticker_alias(ref)
                        ma_reference[ticker] = ref if ref else ticker

        all_dates = frames[0].index
        for df in frames[1:]:
            if not df.index.equals(all_dates):
                all_dates = all_dates.union(df.index)
        n = len(all_dates)
        required_days = int(ma_window * ma_multiplier)

        # Per reference frame: the value each date gets (np.bool_ comparison, or True by default).
        by_ref: dict[str, list] = {}

        def column_for(ref: str) -> list:
            got = by_ref.get(ref)
            if got is not None:
                return got
            df_ref = reindexed_data.get(ref)
            if df_ref is None or not isinstance(df_ref, pd.DataFrame) or ma_col_name not in df_ref.columns or 'Close' not in df_ref.columns:
                col = [True] * n
            else:
                count = df_ref.index.searchsorted(all_dates, side='right')
                close = df_ref['Close'].to_numpy()
                ma = df_ref[ma_col_name].to_numpy()
                pos = np.maximum(count - 1, 0)
                price = close[pos]
                mav = ma[pos]
                bad = (count < required_days) | (count == 0) | pd.isna(price) | pd.isna(mav)
                cmp = price >= mav
                col = [True if b else c for b, c in zip(bad.tolist(), cmp)]
            by_ref[ref] = col
            return col

        per_ticker: list[tuple[str, list | None]] = []
        for ticker, df in reindexed_data.items():
            if df is None or not isinstance(df, pd.DataFrame) or 'Close' not in df.columns:
                per_ticker.append((ticker, None))
                continue
            if not include_in_ma.get(ticker, True):
                per_ticker.append((ticker, None))
                continue
            per_ticker.append((ticker, column_for(ma_reference.get(ticker, ticker))))

        dates = list(all_dates)
        filter_results = {}
        for k, date in enumerate(dates):
            row = {}
            for ticker, col in per_ticker:
                row[ticker] = True if col is None else col[k]
            filter_results[date] = row
        return filter_results

    return precompute_ma_filters


def fast_ma_crossings(reindexed_data, ma_window, ma_type='SMA', tolerance_percent=2.0, confirmation_days=3):
    """Same table as legacy precompute_ma_crossings ({date: {ticker: cross}}, same insertion order)."""
    ma_col_name = f"MA_{ma_type}_{ma_window}"
    crossings_data: dict = {}
    tolerance_ratio = 1 + (tolerance_percent / 100.0)
    inv = 1.0 / tolerance_ratio
    for ticker, df in reindexed_data.items():
        if df is None or ma_col_name not in df.columns:
            continue
        prices = df['Close'].to_numpy()
        ma_values = df[ma_col_name].to_numpy()
        if prices.dtype.kind != 'f' or ma_values.dtype.kind != 'f':
            from ..legacy import multi_backtest as L
            part = L.__dict__["_accel_legacy_ma_crossings"]({ticker: df}, ma_window, ma_type, tolerance_percent, confirmation_days)
            for date, hits in part.items():
                crossings_data.setdefault(date, {}).update(hits)
            continue
        n = len(prices)
        if n < 2:
            continue
        valid = ~(np.isnan(prices) | np.isnan(ma_values))
        with np.errstate(divide='ignore', invalid='ignore'):
            ratio = prices / ma_values
        above = ratio >= tolerance_ratio
        below = ratio <= inv
        hit = valid & (above | below)
        hit[0] = False
        if confirmation_days != 0:
            ok = hit.copy()
            for j in range(1, confirmation_days + 1):
                prev_valid = np.zeros(n, dtype=bool)
                prev_ratio = np.full(n, np.nan)
                if j < n:
                    prev_valid[j:] = valid[:-j]
                    prev_ratio[j:] = ratio[:-j]
                fail = ~prev_valid
                fail |= above & (prev_ratio < tolerance_ratio)
                fail |= below & (prev_ratio > inv)
                ok &= ~fail
            hit = ok
        pos = np.flatnonzero(hit)
        if not len(pos):
            continue
        dates = df.index.take(pos).tolist()  # Timestamps, built in one pass
        hit_prices = list(prices[pos])        # numpy float64 scalars, like prices.iloc[i]
        hit_mas = list(ma_values[pos])
        hit_above = above[pos].tolist()
        for date, p, m, up in zip(dates, hit_prices, hit_mas, hit_above):
            if date not in crossings_data:
                crossings_data[date] = {}
            crossings_data[date][ticker] = {
                'type': 'above' if up else 'below',
                'price': p,
                'ma': m,
                'ratio': p / m,
            }
    return crossings_data


# ---------------------------------------------------------------------------------------------
# Rebalancing / contribution calendars: legacy get_dates_by_freq scans the whole calendar for
# every month (or week). Same dates with a binary search for "first market day on or after".
# ---------------------------------------------------------------------------------------------

def make_dates_by_freq(legacy_fn: Any):
    import bisect

    def get_dates_by_freq(freq, start, end, market_days):
        if freq in ("market_day", "calendar_day", "Never", "none", None, "Buy & Hold", "Buy & Hold (Target)") or freq not in (
            "Weekly", "Biweekly", "Monthly", "Quarterly", "Semiannually", "Annually", "year"):
            return legacy_fn(freq, start, end, market_days)
        if isinstance(market_days, pd.DatetimeIndex) and market_days.is_monotonic_increasing and not market_days.hasnans:
            days = market_days  # already sorted: binary search on the index itself
            n = len(days)

            def first_on_or_after(target):
                pos = int(days.searchsorted(target, side="left"))
                return days[pos] if pos < n else None
        else:
            days = sorted(market_days)
            n = len(days)

            def first_on_or_after(target):
                pos = bisect.bisect_left(days, target)
                return days[pos] if pos < n else None

        dates = []
        if freq in ("Weekly", "Biweekly"):
            step = pd.Timedelta(weeks=1 if freq == "Weekly" else 2)
            first_monday = start - pd.Timedelta(days=start.weekday())
            if start.weekday() > 0:
                first_monday += pd.Timedelta(weeks=1)
            current_date = first_monday
            while current_date <= end:
                md = first_on_or_after(current_date)
                if md and md >= start and md <= end:
                    dates.append(md)
                current_date += step
            return set(dates)
        if freq == "Monthly":
            for year in range(start.year, end.year + 1):
                for month in range(1, 13):
                    md = first_on_or_after(pd.Timestamp(year=year, month=month, day=1))
                    if md and md >= start and md <= end:
                        dates.append(md)
            return set(dates)
        if freq in ("Quarterly", "Semiannually"):
            months = [1, 4, 7, 10] if freq == "Quarterly" else [1, 7]
            for year in range(start.year, end.year + 1):
                for month in months:
                    period_start = pd.Timestamp(year=year, month=month, day=1)
                    if period_start >= start and period_start <= end:
                        md = first_on_or_after(period_start)
                        if md:
                            dates.append(md)
            return set(dates)
        for year in range(start.year, end.year + 1):  # Annually / year
            md = first_on_or_after(pd.Timestamp(year=year, month=1, day=1))
            if md and md >= start and md <= end:
                dates.append(md)
        return set(dates)

    return get_dates_by_freq
