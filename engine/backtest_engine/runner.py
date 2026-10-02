"""Backtest orchestration: a headless transcription of the Streamlit "Run Backtest" block.

Every step follows 1_Multi_Backtest.py (download, reindex, per-portfolio
single_backtest, today's weights, fusion portfolios, optional momentum-window
truncation, final statistics). UI calls are replaced by RunContext progress
and warnings; calculation functions come from the generated legacy module.
"""

from __future__ import annotations

import contextlib
import copy
import io
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

from . import __version__, activate_engine_home, analytics
from . import yahoo as Y
from .config import apply_date_range, normalize_portfolio_configs
from .context import BacktestError, RunContext, RunOptions
from .legacy import multi_backtest as L
from .metrics import compute_final_stats
from .serialize import allocations_to_columns, clean_number, date_key, rounded, series_to_columns, to_jsonable
from .st_shim import StopRun, st

_legacy_ma_crossings = L.precompute_ma_crossings


def _ma_crossings_frames_only(reindexed_data: dict, *args: Any, **kwargs: Any):
    """Legacy scans every loaded entry, including the "special_dynamic_ticker" string that
    stands for SP500TOP20, and crashed any MA-cross portfolio run next to it."""
    frames = {t: df for t, df in reindexed_data.items() if isinstance(df, pd.DataFrame)}
    return _legacy_ma_crossings(frames, *args, **kwargs)


L.precompute_ma_crossings = _ma_crossings_frames_only

_TOTAL_TOL = 1.0
_ALLOC_TOL = 1.0
_METRICS_CELL_BUDGET = 200_000
_VALUE_DIGITS = 4
_WEIGHT_DIGITS = 6


@dataclass
class BacktestRun:
    configs: list[dict]
    options: RunOptions
    all_results: dict[str, Any] = field(default_factory=dict)
    all_allocations: dict[str, dict] = field(default_factory=dict)
    all_metrics: dict[str, dict] = field(default_factory=dict)
    portfolio_key_map: dict[int, str] = field(default_factory=dict)
    failed: dict[str, str] = field(default_factory=dict)
    stats: dict[str, dict] = field(default_factory=dict)
    last_rebalance_dates: dict[str, Any] = field(default_factory=dict)
    today_weights: dict[str, dict] = field(default_factory=dict)
    data: dict[str, Any] = field(default_factory=dict)
    data_reindexed: dict[str, Any] = field(default_factory=dict)
    simulation_index: pd.DatetimeIndex | None = None
    display_start: pd.Timestamp | None = None
    invalid_tickers: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    duration_s: float = 0.0


def _validate(configs: list[dict]) -> None:
    errors: list[str] = []
    for cfg in configs:
        is_fusion = "fusion_portfolio" in cfg and cfg["fusion_portfolio"].get("enabled", False)
        if is_fusion:
            fusion_config = cfg["fusion_portfolio"]
            selected = fusion_config.get("selected_portfolios", [])
            allocations = fusion_config.get("allocations", {})
            if not selected:
                errors.append(f"Fusion portfolio '{cfg['name']}' has no portfolios selected")
            else:
                names = [p["name"] for p in configs]
                for pname in selected:
                    if pname not in names:
                        errors.append(f"Fusion portfolio '{cfg['name']}' references non-existent portfolio '{pname}'")
                total = sum(allocations.values())
                if abs(total - 1.0) > 0.01:
                    errors.append(f"Fusion portfolio '{cfg['name']}' total allocation is {total*100:.2f}% (must be 100%)")
        else:
            if cfg["use_momentum"]:
                total_w = sum(w["weight"] for w in cfg["momentum_windows"])
                if abs(total_w - 1.0) > (_TOTAL_TOL / 100.0):
                    errors.append(
                        f"Portfolio '{cfg['name']}' has momentum enabled but the total momentum weight is {total_w*100:.2f}% (must be 100%)"
                    )
            else:
                valid = [s for s in cfg["stocks"] if s["ticker"]]
                total_a = sum(s["allocation"] for s in valid)
                if abs(total_a - 1.0) > (_ALLOC_TOL / 100.0):
                    errors.append(
                        f"Portfolio '{cfg['name']}' is not using momentum, but the total ticker allocation is {total_a*100:.2f}% (must be 100%)"
                    )
    if errors:
        raise BacktestError("\n".join(errors))


def _collect_tickers(configs: list[dict]) -> list[str]:
    all_tickers = sorted(
        list(
            set(s["ticker"] for cfg in configs for s in cfg["stocks"] if s["ticker"])
            | set(cfg["benchmark_ticker"] for cfg in configs if "benchmark_ticker" in cfg)
        )
    )
    all_tickers = [t for t in all_tickers if t]

    base_tickers_to_add = set()
    for ticker in all_tickers:
        if "?L=" in ticker or "?E=" in ticker:
            base_ticker, _lev, _er = L.parse_ticker_parameters(ticker)
            base_tickers_to_add.add(base_ticker)
    for base_ticker in base_tickers_to_add:
        if base_ticker not in all_tickers:
            all_tickers.append(base_ticker)

    ma_refs = set()
    for cfg in configs:
        if cfg.get("use_sma_filter", False):
            if cfg.get("use_global_ma_reference") and (cfg.get("global_ma_reference_ticker") or "").strip():
                resolved_global = L.resolve_ticker_alias((cfg.get("global_ma_reference_ticker") or "").strip())
                if resolved_global and resolved_global not in all_tickers:
                    ma_refs.add(resolved_global)
            for stock in cfg.get("stocks", []):
                ma_ref = stock.get("ma_reference_ticker", "").strip()
                if ma_ref:
                    resolved = L.resolve_ticker_alias(ma_ref)
                    if resolved not in all_tickers:
                        ma_refs.add(resolved)
    for t in ma_refs:
        if t not in all_tickers:
            all_tickers.append(t)
    return all_tickers


# Local series handled by get_multiple_tickers_batch without Yahoo (its custom_list).
_LOCAL_SERIES = {"ZEROX", "GOLD_COMPLETE", "ZROZ_COMPLETE", "TLT_COMPLETE", "BTC_COMPLETE", "IEF_COMPLETE",
                 "KMLM_COMPLETE", "DBMF_COMPLETE", "TBILL_COMPLETE", "SPYSIM_COMPLETE", "GOLDSIM_COMPLETE"}
_YF_CHUNK = 80
# yfinance still sends one chart request per ticker inside a chunk: space the chunks out.
_CHUNK_PAUSE_S = 1.5


@contextlib.contextmanager
def _no_single_fallback_when_limited(retry: Any):
    """The legacy batch retries every ticker missing from a chunk one by one. When the chunk
    was refused for rate limiting that would send 80 more requests to a server already saying
    no, so those single requests are skipped (the tickers are simply retried on the next run)."""
    inner = L.get_ticker_with_cache

    def guarded(*args: Any, **kwargs: Any):
        if retry.rate_limited:
            raise RuntimeError("Yahoo rate limit: single-ticker fallback skipped")
        return inner(*args, **kwargs)

    L.get_ticker_with_cache = guarded
    try:
        yield
    finally:
        L.get_ticker_with_cache = inner


def _derive_leveraged(t: str, base_df: Any, cache: Any) -> pd.DataFrame:
    """Same frame the legacy batch builds for "BASE?L=x?E=y": leverage applied to the base history."""
    if not isinstance(base_df, pd.DataFrame) or base_df.empty:
        return pd.DataFrame()
    _base, lev, er = L.parse_ticker_parameters(t)
    df = L.apply_daily_leverage(base_df, lev, er) if (lev != 1.0 or er != 0.0) else base_df
    cache.set(Y.price_key(t), df.copy(), expire=Y.smart_ttl(t))
    return df


def _fetch_prices(tickers: list[str], ctx: RunContext, lock: Any) -> dict:
    """get_multiple_tickers_batch with the fewest possible Yahoo requests.

    The legacy function re-downloads every requested Yahoo ticker as soon as one
    is missing from the cache, and yfinance chunks are already built from an
    unordered set with all-NaN rows dropped per ticker, so feeding it cached,
    local and missing tickers separately returns the same frames. On top of that:
    leveraged variants are derived from their cached base history, tickers Yahoo
    does not know are remembered, cache entries follow the market clock, a chunk
    another job fetched while we waited for the lock is not fetched again, and
    rate-limited chunks are retried with a back-off.
    """
    cache = Y.open_cache()
    cached, local, network, derived = [], [], [], []
    batch: dict[str, Any] = {}
    for t in tickers:
        base, _, _ = L.parse_ticker_parameters(t)
        if L.resolve_ticker_alias(base) in _LOCAL_SERIES:
            local.append(t)
        elif Y.price_key(t) in cache:
            cached.append(t)
        elif Y.missing_key(t) in cache:
            batch[t] = pd.DataFrame()
        elif base != t:
            derived.append(t)
        else:
            network.append(t)
    for t in derived:
        base, _, _ = L.parse_ticker_parameters(t)
        if base not in network and base not in cached and Y.price_key(base) not in cache and Y.missing_key(base) not in cache:
            network.append(base)
    for group in (cached, local):
        if group:
            batch.update(L.get_multiple_tickers_batch(group, period="max", auto_adjust=False))

    def waiting(delay: float) -> None:
        ctx.progress(0.05, f"Yahoo rate limit: retrying in {delay:.0f}s...")

    for i in range(0, len(network), _YF_CHUNK):
        ctx.check_cancelled()
        ctx.progress(0.05, f"Downloading data for {len(network)} tickers ({i}/{len(network)}, {len(cached)} cached)...")
        chunk = network[i:i + _YF_CHUNK]
        with lock if lock is not None else contextlib.nullcontext():
            fetched_meanwhile = [t for t in chunk if Y.price_key(t) in cache]
            todo = [t for t in chunk if t not in fetched_meanwhile]
            if fetched_meanwhile:
                batch.update(L.get_multiple_tickers_batch(fetched_meanwhile, period="max", auto_adjust=False))
            if todo:
                with Y.rate_limit_retry(waiting) as retry, _no_single_fallback_when_limited(retry):
                    got = L.get_multiple_tickers_batch(todo, period="max", auto_adjust=False)
                batch.update(got)
                found = [t for t in todo if isinstance(got.get(t), pd.DataFrame) and not got[t].empty]
                for t in found:
                    cache.touch(Y.price_key(t), expire=Y.smart_ttl(t))
                if found and not retry.rate_limited:
                    for t in todo:
                        if t not in found:
                            cache.set(Y.missing_key(t), True, expire=Y.MISSING_TTL)
        if i + _YF_CHUNK < len(network):
            if lock is not None:
                lock.yield_to_waiters()
            time.sleep(_CHUNK_PAUSE_S)

    for t in derived:
        base, _, _ = L.parse_ticker_parameters(t)
        base_df = batch.get(base)
        if base_df is None:
            base_df = cache.get(Y.price_key(base))
        batch[t] = _derive_leveraged(t, base_df, cache)
    return batch


def _download(all_tickers: list[str], configs: list[dict], ctx: RunContext, run: BacktestRun, lock: Any = None) -> dict:
    data: dict[str, Any] = {}
    invalid: list[str] = []
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        special = [t for t in all_tickers if L.is_special_dynamic_ticker(t)]
        individual = set()
        for sp in special:
            dyn = L.get_dynamic_portfolio_data(sp)
            if dyn:
                individual.update(dyn["tickers"])
        to_download = set(all_tickers) | individual
        to_download = [t for t in to_download if not L.is_special_dynamic_ticker(t)]

        ctx.progress(0.05, f"Downloading data for {len(to_download)} tickers...")
        ctx.check_cancelled()
        batch = _fetch_prices(list(to_download), ctx, lock)

        total = max(1, len(to_download) + len(special))
        for n, t in enumerate(to_download, start=1):
            ctx.progress(0.05 + 0.25 * n / total, f"Processing {t} ({n}/{total})")
            hist = batch.get(t, pd.DataFrame())
            if hist.empty:
                invalid.append(t)
                continue
            try:
                hist = hist.copy()
                hist.index = hist.index.tz_localize(None)
                hist["Price_change"] = hist["Close"].pct_change(fill_method=None).fillna(0)
                data[t] = hist
            except Exception:
                invalid.append(t)
        for sp in special:
            data[sp] = "special_dynamic_ticker"

    if invalid:
        portfolio_tickers = set(s["ticker"] for cfg in configs for s in cfg["stocks"] if s["ticker"])
        benchmark_tickers = set(cfg.get("benchmark_ticker") for cfg in configs if "benchmark_ticker" in cfg)
        p_inv = [t for t in invalid if t in portfolio_tickers and not L.is_special_dynamic_ticker(t)]
        b_inv = [t for t in invalid if t in benchmark_tickers and not L.is_special_dynamic_ticker(t)]
        if p_inv:
            ctx.warn(f"The following portfolio tickers are invalid and will be skipped: {', '.join(p_inv)}")
        if b_inv:
            ctx.warn(f"The following benchmark tickers are invalid and will be skipped: {', '.join(b_inv)}")
    run.invalid_tickers = invalid

    special_in_portfolio = [t for t in all_tickers if L.is_special_dynamic_ticker(t)]
    regular = [t for t in all_tickers if not L.is_special_dynamic_ticker(t)]
    if not data and not special_in_portfolio:
        if invalid and len(invalid) == len(regular):
            raise BacktestError(f"No valid tickers found! All regular tickers are invalid: {', '.join(invalid)}.")
        raise BacktestError("No valid tickers found! No data downloaded; aborting.")
    return data


def _simulation_range(data: dict, configs: list[dict], options: RunOptions, ctx: RunContext) -> tuple:
    frames = [df for df in data.values() if not isinstance(df, str)]
    if frames:
        common_end = min(df.last_valid_index() for df in frames)
    else:
        common_end = pd.Timestamp.now()

    all_portfolio_tickers = set()
    for cfg in configs:
        all_portfolio_tickers.update(s["ticker"] for s in cfg["stocks"] if s["ticker"])

    non_usd_suffixes = [".TO", ".V", ".CN", ".AX", ".L", ".PA", ".AS", ".SW", ".T", ".HK", ".KS", ".TW", ".JP"]
    non_usd = [t for t in all_portfolio_tickers if any(t.endswith(sfx) for sfx in non_usd_suffixes)]
    if non_usd:
        ctx.warn(
            f"Currency warning: the following tickers are not in USD: {', '.join(non_usd)}. "
            "Currency conversion is not taken into account."
        )

    valid_portfolio_tickers = [t for t in all_portfolio_tickers if t in data]
    if not valid_portfolio_tickers:
        raise BacktestError("No valid tickers found! None of your portfolio tickers have data available.")

    if options.start_with == "all":
        vt = [data[t] for t in valid_portfolio_tickers if not isinstance(data[t], str)]
        final_start = max(df.first_valid_index() for df in vt) if vt else pd.Timestamp("1989-01-01")
    else:
        earliest = {}
        for cfg in configs:
            pt = [s["ticker"] for s in cfg.get("stocks", []) if s["ticker"]]
            vt_cfg = [data[t] for t in pt if t in data and not isinstance(data[t], str)]
            if vt_cfg:
                earliest[cfg["name"]] = min(df.first_valid_index() for df in vt_cfg)
        if earliest:
            final_start = max(earliest.items(), key=lambda x: x[1])[1]
        else:
            vt = [data[t] for t in valid_portfolio_tickers if not isinstance(data[t], str)]
            final_start = min(df.first_valid_index() for df in vt) if vt else pd.Timestamp("1989-01-01")

    if options.align_start:
        final_start = max(final_start, pd.to_datetime(options.align_start))
    for cfg in configs:
        if cfg.get("start_date_user"):
            final_start = max(final_start, pd.to_datetime(cfg["start_date_user"]))
        if cfg.get("end_date_user"):
            common_end = min(common_end, pd.to_datetime(cfg["end_date_user"]))

    original_display_start = final_start

    if options.auto_adjust_momentum_start:
        max_window = 0
        for cfg in configs:
            if cfg.get("use_momentum", False):
                windows = cfg.get("momentum_windows", [])
                sizes = [int(w.get("lookback", 0)) for w in windows if w is not None]
                if sizes:
                    max_window = max(max_window, max(sizes))
        if max_window > 0:
            adjusted = final_start - pd.Timedelta(days=max_window)
            vt = [data[t] for t in valid_portfolio_tickers if not isinstance(data[t], str)]
            if vt:
                final_start = min(adjusted, min(df.first_valid_index() for df in vt))
            else:
                final_start = adjusted

    if final_start > common_end:
        problems = []
        for ticker, df in data.items():
            if isinstance(df, pd.DataFrame):
                first_idx, last_idx = df.first_valid_index(), df.last_valid_index()
                if first_idx is not None and first_idx > common_end:
                    problems.append(f"{ticker}: starts {first_idx.date()} (after {common_end.date()})")
                elif last_idx is not None and last_idx < final_start:
                    problems.append(f"{ticker}: ends {last_idx.date()} (before {final_start.date()})")
        msg = f"Start date {final_start.date()} is after end date {common_end.date()}. Cannot proceed."
        if problems:
            msg += "\nData availability issue detected for:\n- " + "\n- ".join(problems)
        raise BacktestError(msg)

    return final_start, common_end, original_display_start


def _reindex(data: dict, simulation_index: pd.DatetimeIndex) -> dict:
    out: dict[str, Any] = {}
    for t, ticker_data in data.items():
        if isinstance(ticker_data, str):
            out[t] = ticker_data
        else:
            df = ticker_data.reindex(simulation_index)
            df["Close"] = df["Close"].ffill()
            df["Dividends"] = df["Dividends"].fillna(0)
            df["Price_change"] = df["Close"].pct_change(fill_method=None).fillna(0)
            out[t] = df
    return out


_MCAP_CHUNK = 200
_MCAP_BACKOFF_S = (5.0, 15.0, 45.0, 90.0)


def _market_cap_scales(tickers: list[str], ctx: RunContext) -> dict:
    """Same map as legacy fetch_yahoo_quote_market_caps (key -> marketCap / price, 24h cache, same
    cache entries), but each quote chunk is retried with a back-off when Yahoo refuses it, and the
    run stops when caps stay unavailable: the legacy function returned an empty map and the
    "minimum market cap" portfolio then ran unfiltered."""
    import diskcache

    cache = diskcache.Cache(".streamlit/ticker_info_cache")
    keys = list(dict.fromkeys(k for k in (L._mcap_symbol_key(t) for t in tickers) if k and k != "CASH"))
    scales: dict[str, float] = {}
    missing = []
    for key in keys:
        hit = cache.get(f"yahoo_mcap_quote_v1_{key}")
        if isinstance(hit, dict) and hit.get("scale"):
            scales[key] = float(hit["scale"])
        else:
            missing.append(key)
    for i in range(0, len(missing), _MCAP_CHUNK):
        ctx.check_cancelled()
        chunk = missing[i:i + _MCAP_CHUNK]
        ctx.progress(0.33, f"Loading market caps ({len(scales)} known, {i}/{len(missing)} requested)...")
        rows = None
        last_error: Exception | None = None
        for delay in (0.0, *_MCAP_BACKOFF_S):
            if delay:
                ctx.progress(0.33, f"Yahoo refused the market caps: retrying in {delay:.0f}s...")
                time.sleep(delay)
            try:
                rows = Y.quotes(chunk, ["marketCap", "netAssets", "regularMarketPrice"])
                break
            except Exception as exc:  # noqa: BLE001 - HTTP 429 and friends
                last_error = exc
        if rows is None:
            raise BacktestError(
                f"Yahoo refuses the market caps right now ({last_error}). The minimum market cap filter cannot be "
                "applied, so the run is stopped instead of returning an unfiltered result. Try again in a few minutes."
            )
        by_symbol = {s.upper(): r for s, r in rows.items()}
        for key in chunk:
            row = by_symbol.get(key) or by_symbol.get(key.replace("-", "."))
            if not row:
                continue
            cap = row.get("marketCap") if row.get("marketCap") is not None else row.get("netAssets")
            try:
                cap, price = float(cap), float(row.get("regularMarketPrice"))
            except (TypeError, ValueError):
                continue
            if not (np.isfinite(cap) and np.isfinite(price)) or cap <= 0 or price <= 0:
                continue
            scales[key] = cap / price
            cache.set(f"yahoo_mcap_quote_v1_{key}", {"scale": cap / price, "market_cap": cap, "price": price}, expire=86400)
        if i + _MCAP_CHUNK < len(missing):
            time.sleep(1.0)
    if not scales:
        raise BacktestError("Yahoo returned no market cap for these tickers: the minimum market cap filter cannot be applied.")
    unknown = len(keys) - len(scales)
    if unknown:
        ctx.warn(f"No Yahoo market cap for {unknown} of {len(keys)} tickers: the market-cap filter always excludes them.")
    return scales


def _prefetch_universe_maps(configs: list[dict], ctx: RunContext) -> None:
    if any(cfg.get("use_sector_concentration_limit") or cfg.get("use_industry_concentration_limit") for cfg in configs):
        sector_tickers = sorted({s["ticker"] for cfg in configs for s in cfg.get("stocks", []) if s.get("ticker")})
        ctx.progress(0.31, f"Loading sector/industry for {len(sector_tickers)} tickers...")
        st.session_state.multi_backtest_sector_industry_map = L.fetch_sector_industry_map(sector_tickers)
    else:
        st.session_state.multi_backtest_sector_industry_map = {}

    if any(cfg.get("exclude_before_sp500_entry") for cfg in configs):
        ctx.progress(0.32, "Loading S&P 500 entry dates from Wikipedia...")
        payload, err = L.fetch_sp500_wikipedia_constituents()
        if err or not payload:
            ctx.warn(f"Could not load Wikipedia S&P 500 entry dates ({err}). The before-entry filter is skipped for this run.")
            date_map = {}
        else:
            date_map = payload.get("date_added") or {}
        st.session_state.multi_backtest_sp500_date_added = date_map
        for cfg in configs:
            if cfg.get("exclude_before_sp500_entry"):
                cfg["_sp500_date_added"] = date_map
    else:
        st.session_state.multi_backtest_sp500_date_added = {}

    if any(cfg.get("use_min_market_cap_filter") for cfg in configs):
        mcap_tickers = sorted(
            {s["ticker"] for cfg in configs if cfg.get("use_min_market_cap_filter") for s in cfg.get("stocks", []) if s.get("ticker")}
        )
        ctx.progress(0.33, f"Loading market caps for {len(mcap_tickers)} tickers...")
        scale_map = _market_cap_scales(mcap_tickers, ctx)
        st.session_state.multi_backtest_mcap_price_scale = scale_map
        for cfg in configs:
            if cfg.get("use_min_market_cap_filter"):
                cfg["_mcap_price_scale"] = scale_map
    else:
        st.session_state.multi_backtest_mcap_price_scale = {}


def _redistribute_excluded(today_weights_map: dict, excluded_assets: dict) -> dict:
    excluded_list = list(excluded_assets.keys())
    excluded_allocation = sum(today_weights_map.get(t, 0) for t in excluded_list)
    for t in excluded_list:
        if t in today_weights_map:
            del today_weights_map[t]
    remaining = [t for t in today_weights_map.keys() if t != "CASH"]
    if remaining:
        remaining_allocation = sum(today_weights_map.get(t, 0) for t in remaining)
        if remaining_allocation > 0:
            for t in remaining:
                proportion = today_weights_map[t] / remaining_allocation
                today_weights_map[t] += excluded_allocation * proportion
        else:
            equal = excluded_allocation / len(remaining)
            for t in remaining:
                today_weights_map[t] = equal
        return today_weights_map
    return {"CASH": 1.0}


def _cash_flows(cfg: dict, total_series: pd.Series) -> pd.Series:
    cash_flows = pd.Series(0.0, index=total_series.index)
    if len(total_series.index) > 0:
        cash_flows.iloc[0] = -cfg.get("initial_value", 0)
    dates_added = L.get_dates_by_freq(cfg.get("added_frequency"), total_series.index[0], total_series.index[-1], total_series.index)
    for d in dates_added:
        if d in cash_flows.index and d != cash_flows.index[0]:
            cash_flows.loc[d] -= cfg.get("added_amount", 0)
    if len(total_series.index) > 0:
        cash_flows.iloc[-1] += total_series.iloc[-1]
    return cash_flows


def _process_regular(i: int, cfg: dict, simulation_index, data_reindexed: dict) -> dict:
    try:
        name = cfg.get("name", f"Portfolio {i}")
        has_special = any(L.is_special_dynamic_ticker(stock["ticker"]) for stock in cfg["stocks"])
        if has_special:
            total_series, total_series_no_additions, historical_allocations, historical_metrics, today_weights_map = (
                L.single_backtest_year_aware(cfg, simulation_index, data_reindexed)
            )
        else:
            total_series, total_series_no_additions, historical_allocations, historical_metrics = L.single_backtest(
                cfg, simulation_index, data_reindexed
            )
        today_weights_map = {}
        alloc_dates: list = []
        try:
            alloc_dates = sorted(list(historical_allocations.keys()))
            if alloc_dates:
                final_d = alloc_dates[-1]
                metrics_local = historical_metrics
                use_momentum = cfg.get("use_momentum", True)
                if final_d in metrics_local:
                    if use_momentum:
                        weights = {t: v.get("Calculated_Weight", 0) for t, v in metrics_local[final_d].items()}
                        sumw = sum(w for k, w in weights.items() if k != "CASH")
                        if sumw > 0:
                            norm = {k: (w / sumw) if k != "CASH" else weights.get("CASH", 0) for k, w in weights.items()}
                        else:
                            norm = weights
                        today_weights_map = norm
                    else:
                        today_weights_map = {}
                        for stock in cfg.get("stocks", []):
                            ticker = stock.get("ticker", "").strip()
                            if ticker:
                                today_weights_map[ticker] = stock.get("allocation", 0)
                        if cfg.get("use_sma_filter", False):
                            ma_window = cfg.get("sma_window", 200)
                            ma_type = cfg.get("ma_type", "SMA")
                            current = [t for t in today_weights_map.keys() if t != "CASH"]
                            try:
                                _filtered, excluded = L.filter_assets_by_ma(
                                    current, data_reindexed, final_d, ma_window, ma_type, cfg, cfg.get("stocks", [])
                                )
                                if excluded:
                                    today_weights_map = _redistribute_excluded(today_weights_map, excluded)
                            except Exception:
                                pass
                        if "CASH" not in today_weights_map:
                            total_alloc = sum(today_weights_map.values())
                            today_weights_map["CASH"] = 1.0 - total_alloc if total_alloc < 1.0 else 0
                        if cfg.get("use_targeted_rebalancing", False):
                            current_alloc = historical_allocations.get(final_d, {})
                            targeted = cfg.get("targeted_rebalancing_settings", {})
                            exceeded = False
                            for ticker in current_alloc.keys():
                                if ticker != "CASH" and ticker in targeted and targeted[ticker].get("enabled", False):
                                    pct = current_alloc.get(ticker, 0) * 100
                                    mx = targeted[ticker].get("max_allocation", 100.0)
                                    mn = targeted[ticker].get("min_allocation", 0.0)
                                    if pct > mx or pct < mn:
                                        exceeded = True
                                        break
                            if not exceeded and current_alloc:
                                today_weights_map = current_alloc.copy()
                else:
                    final_alloc = historical_allocations.get(final_d, {})
                    noncash = {k: v for k, v in final_alloc.items() if k != "CASH"}
                    s = sum(noncash.values())
                    if s > 0:
                        norm = {k: (v / s) for k, v in noncash.items()}
                        norm["CASH"] = final_alloc.get("CASH", 0)
                    else:
                        norm = final_alloc
                        today_weights_map = norm
        except Exception:
            today_weights_map = {}
            for stock in cfg.get("stocks", []):
                ticker = stock.get("ticker", "").strip()
                if ticker:
                    today_weights_map[ticker] = stock.get("allocation", 0)
            if not cfg.get("use_momentum", True) and cfg.get("use_sma_filter", False):
                try:
                    ma_window = cfg.get("sma_window", 200)
                    ma_type = cfg.get("ma_type", "SMA")
                    current = [t for t in today_weights_map.keys() if t != "CASH"]
                    if alloc_dates:
                        final_d = alloc_dates[-1]
                        _filtered, excluded = L.filter_assets_by_ma(
                            current, data_reindexed, final_d, ma_window, ma_type, cfg, cfg.get("stocks", [])
                        )
                        if excluded:
                            today_weights_map = _redistribute_excluded(today_weights_map, excluded)
                except Exception:
                    pass
            if "CASH" not in today_weights_map:
                total_alloc = sum(today_weights_map.values())
                today_weights_map["CASH"] = 1.0 - total_alloc if total_alloc < 1.0 else 0

        if total_series is not None and len(total_series) > 0:
            return {
                "index": i - 1,
                "name": name,
                "success": True,
                "no_additions": total_series_no_additions,
                "with_additions": total_series,
                "today_weights_map": today_weights_map,
                "historical_allocations": historical_allocations,
                "historical_metrics": historical_metrics,
                "cash_flows": _cash_flows(cfg, total_series),
                "portfolio_values": total_series,
            }
        return {"index": i - 1, "name": name, "success": False, "error": "Empty results from backtest"}
    except StopRun:
        raise
    except Exception as e:
        return {"index": i - 1, "name": cfg.get("name", f"Portfolio {i}"), "success": False, "error": str(e)}


def _process_fusion(i: int, cfg: dict, all_configs: list[dict], simulation_index, data_reindexed: dict) -> dict:
    try:
        name = cfg.get("name", f"Portfolio {i}")
        if not all_configs:
            return {"index": i - 1, "name": name, "success": False, "error": "No portfolio configs available for fusion portfolio"}
        (
            total_series,
            total_series_no_additions,
            historical_allocations,
            historical_metrics,
            today_weights_map,
            current_alloc,
            current_weights_map,
        ) = L.fusion_portfolio_backtest(cfg, all_configs, simulation_index, data_reindexed)
        if total_series is not None and len(total_series) > 0:
            return {
                "index": i - 1,
                "name": name,
                "success": True,
                "no_additions": total_series_no_additions,
                "with_additions": total_series,
                "today_weights_map": today_weights_map,
                "historical_allocations": historical_allocations,
                "historical_metrics": historical_metrics,
                "current_alloc": current_alloc,
                "current_weights_map": current_weights_map,
                "cash_flows": _cash_flows(cfg, total_series),
                "portfolio_values": total_series,
            }
        return {"index": i - 1, "name": name, "success": False, "error": "Empty results from fusion backtest"}
    except StopRun:
        raise
    except Exception as e:
        return {"index": i - 1, "name": cfg.get("name", f"Portfolio {i}"), "success": False, "error": f"Fusion backtest error: {e}"}


def _store(run: BacktestRun, result: dict, extra_keys: tuple[str, ...] = ()) -> None:
    if not result["success"]:
        run.failed[result["name"]] = result.get("error", "unknown error")
        return
    base = result["name"]
    unique = base
    suffix = 1
    while unique in run.all_results or unique in run.all_allocations:
        unique = f"{base} ({suffix})"
        suffix += 1
    entry = {k: result[k] for k in ("no_additions", "with_additions", "today_weights_map", "cash_flows", "portfolio_values")}
    for k in extra_keys:
        entry[k] = result[k]
    run.all_results[unique] = entry
    run.all_allocations[unique] = result["historical_allocations"]
    run.all_metrics[unique] = result["historical_metrics"]
    run.portfolio_key_map[result["index"]] = unique


def _slice_from(series: pd.Series, start: pd.Timestamp) -> pd.Series:
    if start in series.index:
        return series.iloc[series.index.get_loc(start):].copy()
    after = series.index[series.index >= start]
    if len(after) > 0:
        return series.iloc[series.index.get_loc(after[0]):].copy()
    return series.copy()


def _truncate(run: BacktestRun, start: pd.Timestamp) -> None:
    """Momentum warm-up truncation (auto-adjust start), reinitializing values to initial_value."""
    truncated = {}
    for pname, pdata in run.all_results.items():
        pcfg = next((c for c in run.configs if c.get("name") == pname), None)
        truncated[pname] = _truncate_entry(pdata, pcfg, start)
    run.all_results = truncated
    run.all_allocations = {p: {d: a for d, a in al.items() if d >= start} for p, al in run.all_allocations.items()}
    run.all_metrics = {p: {d: m for d, m in me.items() if d >= start} for p, me in run.all_metrics.items()}


def _truncate_entry(pdata: dict, pcfg: dict | None, start: pd.Timestamp) -> dict:
    initial_value = pcfg.get("initial_value", 10000) if pcfg else 10000
    added_amount = pcfg.get("added_amount", 0) if pcfg else 0
    added_frequency = pcfg.get("added_frequency", "none") if pcfg else "none"
    out: dict[str, Any] = {}
    if "with_additions" in pdata:
        series = pdata["with_additions"]
        if isinstance(series, pd.Series) and len(series) > 0:
            ts = _slice_from(series, start)
            if len(ts) > 0:
                first_value = ts.iloc[0]
                if first_value > 0:
                    normalized = ts * (initial_value / first_value)
                    no_add = pdata.get("no_additions")
                    if isinstance(no_add, pd.Series) and len(no_add) > 0:
                        na_tr = _slice_from(no_add, start)
                        if len(na_tr) > 0:
                            na_first = na_tr.iloc[0]
                            if na_first > 0:
                                na_norm = na_tr * (initial_value / na_first)
                            else:
                                na_norm = na_tr.copy()
                                na_norm.iloc[0] = initial_value
                        if added_amount > 0 and added_frequency != "none":
                            new_dates = L._get_addition_dates_from_start_vectorized(
                                start, ts.index[-1], added_frequency, ts.index.tolist()
                            )
                            arr = np.asarray(na_norm.values, dtype=np.float64)
                            n = len(arr)
                            idxs = sorted(ts.index.get_loc(d) for d in new_dates if d in ts.index)
                            contribution = np.zeros(n, dtype=np.float64)
                            for add_idx in idxs:
                                if add_idx < n and arr[add_idx] > 0:
                                    contribution[add_idx:] += added_amount * (arr[add_idx:] / arr[add_idx])
                            rebuilt = arr + contribution
                            if n > 0:
                                rebuilt[0] = initial_value
                            ts = pd.Series(rebuilt, index=ts.index)
                        else:
                            ts = normalized
                    else:
                        ts = normalized
                else:
                    ts.iloc[0] = initial_value
            out["with_additions"] = ts
    if "no_additions" in pdata:
        series = pdata["no_additions"]
        if isinstance(series, pd.Series) and len(series) > 0:
            ts = _slice_from(series, start)
            if len(ts) > 0:
                first_value = ts.iloc[0]
                if first_value > 0:
                    ts = ts * (initial_value / first_value)
                else:
                    ts.iloc[0] = initial_value
            out["no_additions"] = ts
    if "cash_flows" in pdata and "portfolio_values" in pdata and "with_additions" in out:
        pv = out["with_additions"]
        cf = pd.Series(0.0, index=pv.index)
        if len(pv.index) > 0:
            cf.iloc[0] = -initial_value
        if added_amount > 0 and added_frequency != "none":
            for d in L._get_addition_dates_from_start_vectorized(start, pv.index[-1], added_frequency, pv.index.tolist()):
                if d in cf.index and d != cf.index[0]:
                    cf.loc[d] -= added_amount
        if len(pv.index) > 0:
            cf.iloc[-1] += pv.iloc[-1]
        out["cash_flows"] = cf
        out["portfolio_values"] = pv
    # today_weights_map is dropped here exactly like the Streamlit truncation block.
    return out


def is_fusion(cfg: dict) -> bool:
    return bool("fusion_portfolio" in cfg and cfg["fusion_portfolio"].get("enabled", False))


def _dedupe_names(configs: list[dict]) -> None:
    """Same suffixing as the Streamlit result store, applied up front so every step can key by name."""
    seen: set[str] = set()
    for cfg in configs:
        base = cfg.get("name") or "Portfolio"
        name, suffix = base, 1
        while name in seen:
            name = f"{base} ({suffix})"
            suffix += 1
        cfg["name"] = name
        seen.add(name)


@dataclass
class PreparedRun:
    """Everything a portfolio task needs; pickled once per job as the shared snapshot."""

    configs: list[dict]
    options: RunOptions
    data: dict[str, Any]
    data_keys: list[str]
    simulation_index: pd.DatetimeIndex
    display_start: pd.Timestamp
    invalid_tickers: list[str]
    warnings: list[str]
    session: dict[str, Any]
    started: float
    market: dict[str, Any] = field(default_factory=dict)

    def execution_order(self) -> list[int]:
        regular = [i for i, c in enumerate(self.configs) if not is_fusion(c)]
        fusion = [i for i, c in enumerate(self.configs) if is_fusion(c)]
        return regular + fusion


_UNIVERSE_KEYS = ("multi_backtest_sector_industry_map", "multi_backtest_sp500_date_added", "multi_backtest_mcap_price_scale")


def prepare(raw_configs: Any, options: RunOptions | dict | None = None, ctx: RunContext | None = None,
            download_lock: Any = None, with_market: bool = False) -> PreparedRun:
    started = time.time()
    activate_engine_home()
    ctx = ctx or RunContext()
    options = options if isinstance(options, RunOptions) else RunOptions.from_dict(options)

    configs = normalize_portfolio_configs(copy.deepcopy(raw_configs))
    _dedupe_names(configs)
    apply_date_range(configs, options)
    st.session_state.reset(options.session_state())
    st.session_state.multi_backtest_portfolio_configs = configs
    st.messages.clear()

    stub = BacktestRun(configs=configs, options=options)
    _validate(configs)

    ctx.progress(0.0, "Initializing multi-portfolio backtest...")
    ctx.check_cancelled()
    all_tickers = _collect_tickers(configs)
    if not all_tickers:
        raise BacktestError("No valid tickers found! Please add at least one ticker to your portfolios.")

    data = _download(all_tickers, configs, ctx, stub, lock=download_lock)
    market: dict[str, Any] = {}
    if with_market:
        with download_lock if download_lock is not None else contextlib.nullcontext():
            market = analytics.fetch_market()
    st.session_state.multi_backtest_raw_data = data

    final_start, common_end, original_display_start = _simulation_range(data, configs, options, ctx)
    simulation_index = pd.date_range(start=final_start, end=common_end, freq="D")
    _prefetch_universe_maps(configs, ctx)

    return PreparedRun(
        configs=configs,
        options=options,
        data=data,
        data_keys=list(data.keys()),
        simulation_index=simulation_index,
        display_start=original_display_start,
        invalid_tickers=stub.invalid_tickers,
        warnings=list(ctx.warnings),
        session={k: st.session_state.get(k) for k in _UNIVERSE_KEYS},
        started=started,
        market=market,
    )


def install_session(prep: PreparedRun, raw_data: dict) -> None:
    """Session state a portfolio task sees in a fresh worker process."""
    st.session_state.reset(prep.options.session_state())
    st.session_state.multi_backtest_portfolio_configs = prep.configs
    st.session_state.multi_backtest_raw_data = raw_data
    for k, v in prep.session.items():
        st.session_state[k] = v
    st.messages.clear()


def tickers_for(prep: PreparedRun, index: int) -> list[str]:
    """Data keys portfolio `index` reads (its fusion members included), in snapshot order."""
    cfg = prep.configs[index]
    group = [cfg]
    if is_fusion(cfg):
        wanted = set(cfg["fusion_portfolio"].get("selected_portfolios", []))
        group += [c for c in prep.configs if c.get("name") in wanted and not is_fusion(c)]
        if not wanted:
            group = [c for c in prep.configs if not is_fusion(c)]
    if any(L.is_special_dynamic_ticker(s.get("ticker", "")) for c in group for s in c.get("stocks", [])):
        return list(prep.data_keys)
    # Legacy precompute_ma_crossings scans every loaded frame: a cross on any ticker of
    # the run triggers a rebalance, so MA-cross portfolios must see the full data set.
    if any(c.get("ma_cross_rebalance", False) for c in group):
        return list(prep.data_keys)
    needed = set(_collect_tickers(group))
    return [k for k in prep.data_keys if k in needed]


def ma_seed(prep: PreparedRun, index: int) -> list[tuple[Any, str, float]]:
    """MA columns the shared frames already carry when portfolio `index` starts in a sequential run.

    Legacy precompute_ma_columns adds MA_{type}_{window} to every frame only if
    the column is missing, so the first earlier portfolio using a (type, window)
    fixes its values (its ma_multiplier) for every later portfolio.
    """
    seen: dict[tuple[str, Any], tuple[Any, str, float]] = {}
    for i in prep.execution_order():
        if i == index:
            break
        cfg = prep.configs[i]
        if is_fusion(cfg):
            continue
        if cfg.get("use_sma_filter", False) or cfg.get("ma_cross_rebalance", False):
            window = cfg.get("sma_window", 200)
            ma_type = cfg.get("ma_type", "SMA")
            key = (ma_type, f"MA_{ma_type}_{window}")
            if key not in seen:
                seen[key] = (window, ma_type, cfg.get("ma_multiplier", 1.48))
    return list(seen.values())


def isolate_frames(data_reindexed: dict, seed: list[tuple[Any, str, float]]) -> dict:
    """Task-local shallow copies (legacy only adds columns) with the sequential-run MA state."""
    frames = {k: (v.copy(deep=False) if isinstance(v, pd.DataFrame) else v) for k, v in data_reindexed.items()}
    for window, ma_type, multiplier in seed:
        L.precompute_ma_columns(frames, window, ma_type, multiplier)
    return frames


def run_one(prep: PreparedRun, index: int, data_reindexed: dict, raw_data: dict) -> dict:
    """Backtest + post-processing + final stats for one portfolio (0-based index)."""
    cfg = prep.configs[index]
    name = cfg["name"]
    first_msg = len(st.messages)
    fusion = is_fusion(cfg)
    if fusion:
        regular_configs = [c for c in prep.configs if not is_fusion(c)]
        res = _process_fusion(index + 1, cfg, regular_configs, prep.simulation_index, data_reindexed)
        extra: tuple[str, ...] = ("current_alloc", "current_weights_map")
    else:
        res = _process_regular(index + 1, cfg, prep.simulation_index, data_reindexed)
        extra = ()
    outcome: dict[str, Any] = {"index": index, "name": name, "fusion": fusion, "success": bool(res["success"])}
    if not res["success"]:
        outcome["error"] = res.get("error", "unknown error")
        outcome["messages"] = [m for lvl, m in st.messages[first_msg:] if lvl == "error"]
        return outcome

    entry = {k: res[k] for k in ("no_additions", "with_additions", "today_weights_map", "cash_flows", "portfolio_values")}
    for k in extra:
        entry[k] = res[k]
    allocations = res["historical_allocations"]
    metrics = res["historical_metrics"]
    if not prep.options.auto_adjust_momentum_start:
        entry.pop("cash_flows", None)
        entry.pop("portfolio_values", None)
    today = entry.get("today_weights_map", {})
    dates = sorted(allocations.keys())
    last_reb = (dates[-2] if len(dates) > 1 else dates[-1]) if dates else None
    if prep.options.auto_adjust_momentum_start:
        start = prep.display_start
        entry = _truncate_entry(entry, cfg, start)
        allocations = {d: a for d, a in allocations.items() if d >= start}
        metrics = {d: m for d, m in metrics.items() if d >= start}
    outcome.update(
        entry=entry,
        allocations=allocations,
        metrics=metrics,
        today_weights=today,
        last_rebalance=last_reb,
        stats=compute_final_stats(name, entry, cfg, raw_data),
        messages=[m for lvl, m in st.messages[first_msg:] if lvl == "error"],
    )
    return outcome


def assemble(prep: PreparedRun, outcomes: list[dict], data_reindexed: dict | None = None,
             raw_data: dict | None = None) -> BacktestRun:
    run = BacktestRun(configs=prep.configs, options=prep.options)
    run.data = raw_data if raw_data is not None else prep.data
    run.data_reindexed = data_reindexed or {}
    run.simulation_index = prep.simulation_index
    run.display_start = prep.display_start
    run.invalid_tickers = prep.invalid_tickers
    by_index = {o["index"]: o for o in outcomes}
    messages: list[str] = []
    for i in prep.execution_order():
        o = by_index.get(i)
        if o is None:
            continue
        messages += o.get("messages", [])
        if not o["success"]:
            run.failed[o["name"]] = o.get("error", "unknown error")
            continue
        name = o["name"]
        run.all_results[name] = o["entry"]
        run.all_allocations[name] = o["allocations"]
        run.all_metrics[name] = o["metrics"]
        run.portfolio_key_map[i] = name
        run.today_weights[name] = o["today_weights"]
        run.stats[name] = o["stats"]
    for cfg in prep.configs:
        o = next((x for x in outcomes if x["name"] == cfg["name"]), None)
        run.last_rebalance_dates[cfg["name"]] = o.get("last_rebalance") if o and o["success"] else None

    warnings = list(prep.warnings)
    warnings += [f"Portfolio '{n}' failed: {e}" for n, e in run.failed.items()]
    for msg in messages:
        if msg not in warnings and len(warnings) < 50:
            warnings.append(msg)
    run.warnings = warnings
    run.duration_s = time.time() - prep.started
    return run


def run_backtest(raw_configs: Any, options: RunOptions | dict | None = None, ctx: RunContext | None = None) -> BacktestRun:
    ctx = ctx or RunContext()
    prep = prepare(raw_configs, options, ctx)
    data_reindexed = _reindex(prep.data, prep.simulation_index)
    order = prep.execution_order()
    total = max(1, len(order))
    outcomes = []
    for done, i in enumerate(order):
        ctx.check_cancelled()
        cfg = prep.configs[i]
        label = "Fusion" if is_fusion(cfg) else "Backtesting"
        ctx.progress(0.35 + 0.6 * done / total, f"{label} {cfg['name']} ({done + 1}/{total})")
        outcomes.append(run_one(prep, i, data_reindexed, prep.data))
    ctx.progress(0.96, "Computing statistics...")
    run = assemble(prep, outcomes, data_reindexed)
    ctx.progress(1.0, "Backtest complete")
    return run


def _metrics_payload(metrics: dict) -> tuple[Any, bool]:
    dates = sorted(metrics.keys())
    cells = sum(len(v) if isinstance(v, dict) else 1 for v in metrics.values())
    truncated = False
    if cells > _METRICS_CELL_BUDGET and dates:
        per_date = max(1, cells // len(dates))
        keep = max(1, _METRICS_CELL_BUDGET // per_date)
        dates = dates[-keep:]
        truncated = True
    return {date_key(d): to_jsonable(metrics[d]) for d in dates}, truncated


def _json_config(cfg: dict) -> dict:
    return {k: to_jsonable(v) for k, v in cfg.items() if not k.startswith("_")}


def to_payload(run: BacktestRun) -> dict:
    """JSON-safe result consumed by the web UI."""
    portfolios = []
    for idx, cfg in enumerate(run.configs):
        name = cfg["name"]
        res = run.all_results.get(name)
        if res is None:
            portfolios.append({"index": idx, "name": name, "ok": False, "error": run.failed.get(name, "No result")})
            continue
        with_add = res.get("with_additions")
        no_add = res.get("no_additions")
        metrics, metrics_truncated = _metrics_payload(run.all_metrics.get(name, {}))
        stats = run.stats.get(name, {"values": {}, "display": {}})
        last_reb = run.last_rebalance_dates.get(name)
        portfolios.append(
            {
                "index": idx,
                "name": name,
                "ok": True,
                "config": _json_config(cfg),
                "series": {
                    "dates": [date_key(d) for d in with_add.index] if isinstance(with_add, pd.Series) else [],
                    "with_additions": rounded(with_add.to_numpy(dtype=float), _VALUE_DIGITS) if isinstance(with_add, pd.Series) else [],
                    "no_additions": rounded(no_add.reindex(with_add.index).to_numpy(dtype=float), _VALUE_DIGITS)
                    if isinstance(no_add, pd.Series) and isinstance(with_add, pd.Series)
                    else [],
                },
                "stats": to_jsonable(stats["values"]),
                "stats_display": to_jsonable(stats["display"]),
                "today_weights": to_jsonable(run.today_weights.get(name, {})),
                "current_alloc": to_jsonable(res.get("current_alloc")) if "current_alloc" in res else None,
                "allocations": allocations_to_columns(run.all_allocations.get(name, {}), _WEIGHT_DIGITS),
                "metrics_history": metrics,
                "metrics_truncated": metrics_truncated,
                "last_rebalance_date": date_key(last_reb) if last_reb is not None else None,
            }
        )

    benchmarks = {}
    display_start = run.display_start
    for cfg in run.configs:
        b = cfg.get("benchmark_ticker")
        if b and b not in benchmarks and isinstance(run.data_reindexed.get(b), pd.DataFrame):
            close = run.data_reindexed[b]["Close"]
            if display_start is not None:
                close = close[close.index >= display_start]
            benchmarks[b] = series_to_columns(close, _VALUE_DIGITS)

    sim = run.simulation_index
    return {
        "engine_version": __version__,
        "options": run.options.to_dict(),
        "duration_s": round(run.duration_s, 3),
        "simulation": {
            "start": date_key(sim[0]) if sim is not None and len(sim) else None,
            "end": date_key(sim[-1]) if sim is not None and len(sim) else None,
            "display_start": date_key(display_start) if display_start is not None else None,
        },
        "invalid_tickers": run.invalid_tickers,
        "warnings": run.warnings,
        "portfolios": portfolios,
        "benchmarks": benchmarks,
    }
