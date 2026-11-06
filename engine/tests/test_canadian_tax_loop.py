"""End-to-end: taxed single_backtest_fast drops equity and emits tax_events."""

from __future__ import annotations

import numpy as np
import pandas as pd

from backtest_engine.accel import install
from backtest_engine.config import normalize_one

install()
from backtest_engine.legacy import multi_backtest as L  # noqa: E402


def _frame(idx: pd.DatetimeIndex, close: np.ndarray, div_on: int | None = None, div_amt: float = 0.0) -> pd.DataFrame:
    s = pd.Series(close, index=idx)
    df = pd.DataFrame({
        "Close": s,
        "Open": s,
        "High": s,
        "Low": s,
        "Price_change": s.pct_change().fillna(0.0),
        "Dividends": 0.0,
    })
    if div_on is not None and div_amt:
        df.loc[idx[div_on], "Dividends"] = div_amt
    return df


def test_tax_off_matches_higher_final_than_tax_on():
    idx = pd.bdate_range("2020-01-02", periods=400)
    close_a = np.linspace(100, 200, len(idx))
    close_b = np.linspace(100, 110, len(idx))
    data = {
        "AAA": _frame(idx, close_a, 20, 1.0),
        "BBB": _frame(idx, close_b, 20, 1.0),
        "^GSPC": _frame(idx, np.linspace(100, 150, len(idx))),
    }
    base = {
        "name": "P",
        "stocks": [
            {"ticker": "AAA", "allocation": 0.5, "include_dividends": True},
            {"ticker": "BBB", "allocation": 0.5, "include_dividends": True},
        ],
        "benchmark_ticker": "^GSPC",
        "initial_value": 10000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Annually",
        "use_momentum": False,
    }
    off = L.single_backtest(normalize_one(base), idx, data)
    on_cfg = normalize_one({
        **base,
        "use_canadian_tax": True,
        "canadian_tax_inclusion_rate": 50,
        "canadian_tax_marginal_rate": 50,
        "canadian_tax_dividend_rate": 40,
    })
    on = L.single_backtest(on_cfg, idx, data)
    assert len(on) == 5
    assert float(on[0].iloc[-1]) < float(off[0].iloc[-1]) - 1
    assert len(on[4]) >= 1
    assert all("date" in e and e["amount"] > 0 for e in on[4])


def test_buy_and_hold_first_year_is_dividends_only():
    """No voluntary sells in year Y → year-Y tax is dividends only.

    Paying that tax by selling may create a small CG booked to Y+1 (real life).
    """
    idx = pd.bdate_range("2020-01-02", periods=400)
    close = np.linspace(100, 200, len(idx))
    data = {"SPY": _frame(idx, close, 30, 2.0), "^GSPC": _frame(idx, close)}
    base = {
        "name": "BH",
        "stocks": [{"ticker": "SPY", "allocation": 1.0, "include_dividends": True}],
        "benchmark_ticker": "^GSPC",
        "initial_value": 10000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Buy & Hold",
        "use_momentum": False,
    }
    on = L.single_backtest(
        normalize_one({
            **base,
            "use_canadian_tax": True,
            "canadian_tax_inclusion_rate": 50,
            "canadian_tax_marginal_rate": 50,
            "canadian_tax_dividend_rate": 40,
        }),
        idx,
        data,
    )
    y2020 = [e for e in on[4] if e["tax_year"] == 2020]
    assert len(y2020) == 1
    assert y2020[0]["cg_tax"] == 0.0
    assert y2020[0]["div_tax"] > 0


def test_buy_and_hold_no_dividends_no_tax_drag():
    idx = pd.bdate_range("2020-01-02", periods=300)
    close = np.linspace(100, 180, len(idx))
    data = {"SPY": _frame(idx, close), "^GSPC": _frame(idx, close)}
    base = {
        "name": "BH0",
        "stocks": [{"ticker": "SPY", "allocation": 1.0, "include_dividends": True}],
        "benchmark_ticker": "^GSPC",
        "initial_value": 10000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Buy & Hold",
        "use_momentum": False,
    }
    off = L.single_backtest(normalize_one(base), idx, data)
    on = L.single_backtest(
        normalize_one({**base, "use_canadian_tax": True, "canadian_tax_marginal_rate": 50}),
        idx,
        data,
    )
    # No dividends, no sells → identical curves (force-settle finds nothing to pay).
    assert abs(float(off[0].iloc[-1]) - float(on[0].iloc[-1])) < 0.02
    assert on[4] == []
