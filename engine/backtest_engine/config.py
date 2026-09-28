"""Portfolio config normalization, mirroring the Streamlit JSON import.

`normalize_portfolio_configs` reproduces paste_all_json_callback (Multi-Backtest
JSON import) plus the defaults the page adds on load, so a JSON exported from
Streamlit runs with exactly the same settings here.
"""

from __future__ import annotations

import copy
import datetime as dt
from typing import Any

from .context import BacktestError, RunOptions


def parse_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        cleaned = value.strip().lower()
        if cleaned in {"true", "1", "yes", "y", "on"}:
            return True
        if cleaned in {"false", "0", "no", "n", "off"}:
            return False
        return default
    if isinstance(value, (int, float)):
        return value != 0
    return default


def parse_date(value: Any) -> dt.date | None:
    if value is None:
        return None
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str):
        try:
            return dt.datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            try:
                return dt.datetime.fromisoformat(value).date()
            except ValueError:
                return None
    return None


_FREQ_MAP = {
    "Never": "Never",
    "Buy & Hold": "Buy & Hold",
    "Buy & Hold (Target)": "Buy & Hold (Target)",
    "Weekly": "Weekly",
    "Biweekly": "Biweekly",
    "Monthly": "Monthly",
    "Quarterly": "Quarterly",
    "Semiannually": "Semiannually",
    "Annually": "Annually",
    "none": "Never",
    "week": "Weekly",
    "2weeks": "Biweekly",
    "month": "Monthly",
    "3months": "Quarterly",
    "6months": "Semiannually",
    "year": "Annually",
}

FREQUENCIES = [
    "Never",
    "Buy & Hold",
    "Buy & Hold (Target)",
    "Weekly",
    "Biweekly",
    "Monthly",
    "Quarterly",
    "Semiannually",
    "Annually",
]


def map_frequency(freq: Any) -> str:
    if freq is None:
        return "Never"
    return _FREQ_MAP.get(freq, "Monthly")


def _momentum_strategy(value: Any) -> str:
    mapping = {"Classic momentum": "Classic", "Relative momentum": "Relative Momentum"}
    value = mapping.get(value, value)
    return value if value in ("Classic", "Relative Momentum", "Near-Zero Symmetry") else "Classic"


def _negative_strategy(value: Any) -> str:
    value = {"Go to cash": "Cash"}.get(value, value)
    return value if value in ("Cash", "Equal weight", "Relative momentum", "Near-Zero Symmetry") else "Cash"


def _stocks(cfg: dict) -> list[dict]:
    stocks = cfg.get("stocks", [])
    if not stocks and "tickers" in cfg:
        tickers = cfg.get("tickers", []) or []
        allocs = cfg.get("allocs", []) or []
        divs = cfg.get("divs", []) or []
        stocks = []
        for i, t in enumerate(tickers):
            if t and str(t).strip():
                allocation = 0.0
                if i < len(allocs) and allocs[i] is not None:
                    a = float(allocs[i])
                    allocation = a / 100.0 if a > 1.0 else a
                stocks.append(
                    {
                        "ticker": str(t).strip(),
                        "allocation": allocation,
                        "include_dividends": bool(divs[i]) if i < len(divs) and divs[i] is not None else True,
                    }
                )
    return copy.deepcopy(stocks)


def _momentum_windows(cfg: dict) -> list[dict]:
    windows = copy.deepcopy(cfg.get("momentum_windows", []) or [])
    for w in windows:
        if "weight" in w:
            weight = w["weight"]
            if isinstance(weight, (int, float)) and weight > 1.0:
                weight = min(weight, 100.0) / 100.0
            elif isinstance(weight, (int, float)):
                weight = max(0.0, min(weight, 1.0))
            else:
                weight = 0.1
            w["weight"] = weight
        if isinstance(w, dict):
            w["discard_if_negative"] = parse_bool(w.get("discard_if_negative", False))
            w["discard_unless_recent_positive"] = parse_bool(w.get("discard_unless_recent_positive", False))
    return windows


def normalize_one(cfg: dict) -> dict:
    if not isinstance(cfg, dict) or "name" not in cfg:
        raise BacktestError("Invalid portfolio configuration structure (missing name).")
    try:
        min_cap = float(cfg.get("min_market_cap_billions", 10.0) or 10.0)
    except Exception:
        min_cap = 10.0
    out = {
        "name": cfg.get("name", "New Portfolio"),
        "stocks": _stocks(cfg),
        "benchmark_ticker": cfg.get("benchmark_ticker", "^GSPC"),
        "initial_value": cfg.get("initial_value", 10000),
        "added_amount": cfg.get("added_amount", 1000),
        "added_frequency": map_frequency(cfg.get("added_frequency", "Monthly")),
        "rebalancing_frequency": map_frequency(cfg.get("rebalancing_frequency", "Monthly")),
        "start_date_user": parse_date(cfg.get("start_date_user")),
        "end_date_user": parse_date(cfg.get("end_date_user")),
        "start_with": cfg.get("start_with", "all"),
        "first_rebalance_strategy": cfg.get("first_rebalance_strategy", "rebalancing_date"),
        "use_momentum": parse_bool(cfg.get("use_momentum", True), True),
        "momentum_strategy": _momentum_strategy(cfg.get("momentum_strategy", "Classic")),
        "negative_momentum_strategy": _negative_strategy(cfg.get("negative_momentum_strategy", "Cash")),
        "momentum_windows": _momentum_windows(cfg),
        "use_minimal_threshold": parse_bool(cfg.get("use_minimal_threshold", False)),
        "minimal_threshold_percent": cfg.get("minimal_threshold_percent", 4.0),
        "use_max_allocation": parse_bool(cfg.get("use_max_allocation", False)),
        "max_allocation_percent": cfg.get("max_allocation_percent", 20.0),
        "calc_beta": parse_bool(cfg.get("calc_beta", False)),
        "calc_volatility": parse_bool(cfg.get("calc_volatility", True), True),
        "beta_window_days": cfg.get("beta_window_days", 365),
        "exclude_days_beta": cfg.get("exclude_days_beta", 30),
        "vol_window_days": cfg.get("vol_window_days", 365),
        "exclude_days_vol": cfg.get("exclude_days_vol", 30),
        "collect_dividends_as_cash": parse_bool(cfg.get("collect_dividends_as_cash", False)),
        "idle_cash_earns_treasury_yield": parse_bool(cfg.get("idle_cash_earns_treasury_yield", False)),
        "exclude_from_cashflow_sync": parse_bool(cfg.get("exclude_from_cashflow_sync", False)),
        "exclude_from_rebalancing_sync": parse_bool(cfg.get("exclude_from_rebalancing_sync", False)),
        "use_targeted_rebalancing": parse_bool(cfg.get("use_targeted_rebalancing", False)),
        "targeted_rebalancing_settings": copy.deepcopy(cfg.get("targeted_rebalancing_settings", {}) or {}),
        "use_sma_filter": parse_bool(cfg.get("use_sma_filter", False)),
        "sma_window": cfg.get("sma_window", 200),
        "ma_type": cfg.get("ma_type", "SMA"),
        "ma_multiplier": cfg.get("ma_multiplier", 1.48),
        "use_global_ma_reference": parse_bool(cfg.get("use_global_ma_reference", False)),
        "global_ma_reference_ticker": (cfg.get("global_ma_reference_ticker") or "").strip(),
        "ma_cross_rebalance": parse_bool(cfg.get("ma_cross_rebalance", False)),
        "ma_tolerance_percent": cfg.get("ma_tolerance_percent", 2.0),
        "ma_confirmation_days": cfg.get("ma_confirmation_days", 3),
        "use_equal_weight": parse_bool(cfg.get("use_equal_weight", False)),
        "equal_weight_n_tickers": cfg.get("equal_weight_n_tickers", 10),
        "use_limit_to_top_n": parse_bool(cfg.get("use_limit_to_top_n", False)),
        "limit_to_top_n_tickers": cfg.get("limit_to_top_n_tickers", 10),
        "use_sector_concentration_limit": parse_bool(cfg.get("use_sector_concentration_limit", False)),
        "max_tickers_per_sector": cfg.get("max_tickers_per_sector", 4),
        "use_industry_concentration_limit": parse_bool(cfg.get("use_industry_concentration_limit", False)),
        "max_tickers_per_industry": cfg.get("max_tickers_per_industry", 2),
        "unknown_counts_as_category": parse_bool(cfg.get("unknown_counts_as_category", True), True),
        "exclude_before_sp500_entry": parse_bool(cfg.get("exclude_before_sp500_entry", False)),
        "use_min_market_cap_filter": parse_bool(cfg.get("use_min_market_cap_filter", False)),
        "min_market_cap_billions": min_cap,
        "fusion_portfolio": copy.deepcopy(
            cfg.get("fusion_portfolio", {"enabled": False, "selected_portfolios": [], "allocations": {}})
        ),
    }
    for extra in ("auto_adjust_momentum_start",):
        if extra in cfg:
            out[extra] = cfg[extra]
    return apply_page_defaults(out)


def apply_page_defaults(portfolio: dict) -> dict:
    """Defaults the Streamlit page adds to every portfolio on load (page init loop)."""
    defaults = {
        "use_minimal_threshold": False,
        "minimal_threshold_percent": 4.0,
        "use_max_allocation": False,
        "max_allocation_percent": 20.0,
        "use_sma_filter": False,
        "sma_window": 200,
        "ma_type": "SMA",
        "ma_multiplier": 1.48,
        "ma_cross_rebalance": False,
        "ma_tolerance_percent": 2.0,
        "ma_confirmation_days": 3,
        "use_global_ma_reference": False,
        "global_ma_reference_ticker": "",
        "idle_cash_earns_treasury_yield": False,
    }
    for k, v in defaults.items():
        portfolio.setdefault(k, v)
    for stock in portfolio.get("stocks", []):
        stock.setdefault("include_in_sma_filter", True)
    return portfolio


def normalize_portfolio_configs(raw: Any) -> list[dict]:
    if isinstance(raw, dict) and "portfolios" in raw:
        raw = raw["portfolios"]
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        raise BacktestError("JSON must be a list of portfolio configurations.")
    return [normalize_one(cfg) for cfg in raw]


def options_from_streamlit_json(raw: Any) -> dict:
    """Global options embedded in the first portfolio of a Streamlit export."""
    if isinstance(raw, dict) and "portfolios" in raw:
        raw = raw["portfolios"]
    if not isinstance(raw, list) or not raw or not isinstance(raw[0], dict):
        return {}
    first = raw[0]
    out: dict[str, Any] = {}
    start_with = first.get("start_with")
    if start_with is not None:
        out["start_with"] = "oldest" if start_with == "first" else (start_with if start_with in ("all", "oldest") else "all")
    if "first_rebalance_strategy" in first:
        out["first_rebalance_strategy"] = first["first_rebalance_strategy"]
    if "auto_adjust_momentum_start" in first:
        out["auto_adjust_momentum_start"] = parse_bool(first["auto_adjust_momentum_start"])
    return out


def apply_date_range(configs: list[dict], options: RunOptions) -> None:
    """Sidebar custom dates overwrite every portfolio's start/end dates."""
    start = parse_date(options.start_date)
    end = parse_date(options.end_date)
    if start is None and end is None:
        return
    for cfg in configs:
        cfg["start_date_user"] = start
        cfg["end_date_user"] = end
