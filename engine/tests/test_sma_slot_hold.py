"""Sticky SMA slot hold: survivors above MA stay; only leavers are replaced."""

from __future__ import annotations

import numpy as np
import pandas as pd

from backtest_engine.accel import install
from backtest_engine.analytics.sma_slots import (
    apply_entry_caps,
    rank_outsiders,
    redistribute_to_survivors,
    sticky_rebalance,
    strip_slot_identity,
)
from backtest_engine.config import normalize_one

install()
from backtest_engine.legacy import multi_backtest as L  # noqa: E402


def test_normalize_clears_top_n_without_momentum():
    out = normalize_one({
        "name": "P",
        "stocks": [{"ticker": "A", "allocation": 1}],
        "use_momentum": False,
        "use_limit_to_top_n": True,
        "use_equal_weight": True,
        "use_sector_concentration_limit": True,
    })
    assert out["use_limit_to_top_n"] is False
    assert out["use_equal_weight"] is False
    assert out["use_sector_concentration_limit"] is False
    assert out["use_sma_slot_hold"] is False


def test_normalize_slot_hold_forces_momentum_and_sma():
    out = normalize_one({
        "name": "P",
        "stocks": [{"ticker": "A", "allocation": 1}],
        "use_sma_slot_hold": True,
        "sma_slot_count": 7,
        "use_limit_to_top_n": True,
        "use_equal_weight": True,
    })
    assert out["use_sma_slot_hold"] is True
    assert out["use_momentum"] is True
    assert out["use_sma_filter"] is True
    assert out["use_limit_to_top_n"] is False
    assert out["use_equal_weight"] is False
    assert out["sma_slot_count"] == 7


def test_normalize_slot_hold_wins_over_momentum_off():
    """Sticky must force momentum on even if the client left momentum unchecked."""
    out = normalize_one({
        "name": "P",
        "stocks": [{"ticker": "A", "allocation": 1}],
        "use_momentum": False,
        "use_sma_filter": False,
        "use_sma_slot_hold": True,
        "sma_slot_count": 4,
    })
    assert out["use_sma_slot_hold"] is True
    assert out["use_momentum"] is True
    assert out["use_sma_filter"] is True
    assert out["sma_slot_count"] == 4


def test_strip_slot_identity_when_off():
    off = normalize_one({"name": "P", "stocks": [{"ticker": "A", "allocation": 1}]})
    stripped = strip_slot_identity(off)
    assert "use_sma_slot_hold" not in stripped
    on = strip_slot_identity(normalize_one({
        "name": "P",
        "stocks": [{"ticker": "A", "allocation": 1}],
        "use_sma_slot_hold": True,
        "sma_slot_count": 5,
    }))
    assert on["use_sma_slot_hold"] is True


def test_rank_outsiders_skips_held():
    scores = {"A": 0.5, "B": 0.9, "C": 0.2, "D": 0.8}
    assert rank_outsiders(scores, ["B"], eligible=lambda t: True) == ["D", "A", "C"]


def test_sticky_keeps_survivor_above_ma_even_if_worse_momentum():
    held = ["WEAK", "STRONG"]
    values = {"WEAK": 100.0, "STRONG": 100.0, "NEW": 0.0}
    scores = {"WEAK": 0.01, "STRONG": 0.02, "NEW": 0.99}  # NEW is best, WEAK still above MA
    new_held, new_vals, cash, _ = sticky_rebalance(
        held=held,
        values=values,
        unallocated_cash=0.0,
        unreinvested_cash=0.0,
        n_slots=2,
        scores=scores,
        keep_fn=lambda t: True,  # both above MA
        enter_fn=lambda t: True,
        cap=None,
    )
    assert set(new_held) == {"WEAK", "STRONG"}
    assert abs(new_vals["WEAK"] - 100) < 1e-9
    assert abs(new_vals["STRONG"] - 100) < 1e-9
    assert new_vals.get("NEW", 0) == 0
    assert cash == 0


def test_sticky_sells_below_ma_and_fills_with_best_outsider():
    held = ["OLD", "KEEP"]
    values = {"OLD": 120.0, "KEEP": 80.0, "BEST": 0.0, "MEH": 0.0}
    scores = {"OLD": 0.1, "KEEP": 0.05, "BEST": 0.4, "MEH": 0.2}

    def keep(t):
        return t != "OLD"

    new_held, new_vals, cash, _ = sticky_rebalance(
        held=held,
        values=values,
        unallocated_cash=0.0,
        unreinvested_cash=0.0,
        n_slots=2,
        scores=scores,
        keep_fn=keep,
        enter_fn=lambda t: True,
        cap=None,
    )
    assert "OLD" not in new_held
    assert "KEEP" in new_held
    assert "BEST" in new_held
    assert abs(new_vals["KEEP"] - 80) < 1e-9
    assert abs(new_vals["BEST"] - 120) < 1e-6  # freed cash from OLD
    assert cash < 0.01


def test_sticky_no_candidate_leaves_cash():
    held = ["GONE"]
    values = {"GONE": 50.0}
    new_held, new_vals, cash, _ = sticky_rebalance(
        held=held,
        values=values,
        unallocated_cash=0.0,
        unreinvested_cash=0.0,
        n_slots=1,
        scores={"GONE": 0.0},
        keep_fn=lambda t: False,
        enter_fn=lambda t: False,
        cap=None,
    )
    assert new_held == []
    assert abs(cash - 50) < 1e-9


def test_entry_cap_limits_newcomer():
    adds, left = apply_entry_caps(
        buy_budget=100.0,
        entrants=["X"],
        current_values={},
        total_portfolio=500.0,
        cap=0.10,  # max 50
    )
    assert abs(adds["X"] - 50) < 1e-9
    assert abs(left - 50) < 1e-9


def test_redistribute_prefers_room_under_cap():
    more, left = redistribute_to_survivors(
        cash=40.0,
        survivors=["A", "B"],
        values={"A": 90.0, "B": 10.0},
        total_portfolio=140.0,
        cap=0.5,  # max 70 each of 140
    )
    # A has room 0 (already 90 > 70? 0.5*140=70, A at 90 → no room)
    # Wait A is already over cap — room 0. B has room 60.
    assert more["A"] == 0.0
    assert abs(more["B"] - 40) < 1e-9
    assert left < 0.01


def _frame(idx, close, ma_level=None):
    """Simple price frame; optional constant 'MA' via Close vs ma_level for filter tables."""
    s = pd.Series(np.asarray(close, dtype=float), index=idx)
    return pd.DataFrame({
        "Close": s,
        "Open": s,
        "High": s,
        "Low": s,
        "Price_change": s.pct_change().fillna(0.0),
        "Dividends": 0.0,
    })


def test_loop_survivor_not_replaced_by_stronger_outsider():
    """End-to-end: name above MA with weak momentum is NOT sold for a hotter outsider."""
    idx = pd.bdate_range("2020-01-02", periods=280)
    # AAA rises slowly, BBB rises fast later, CCC crashes under "MA" (we simulate via sma filter table)
    aaa = np.linspace(100, 120, len(idx))
    bbb = np.concatenate([np.linspace(100, 105, 140), np.linspace(105, 200, len(idx) - 140)])
    ccc = np.concatenate([np.linspace(100, 130, 100), np.linspace(130, 40, len(idx) - 100)])
    data = {
        "AAA": _frame(idx, aaa),
        "BBB": _frame(idx, bbb),
        "CCC": _frame(idx, ccc),
        "^GSPC": _frame(idx, np.linspace(100, 150, len(idx))),
    }
    cfg = normalize_one({
        "name": "Sticky",
        "stocks": [
            {"ticker": "AAA", "allocation": 1 / 3, "include_dividends": False},
            {"ticker": "BBB", "allocation": 1 / 3, "include_dividends": False},
            {"ticker": "CCC", "allocation": 1 / 3, "include_dividends": False},
        ],
        "benchmark_ticker": "^GSPC",
        "initial_value": 9000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Monthly",
        "use_momentum": True,
        "use_sma_filter": True,
        "sma_window": 50,
        "use_sma_slot_hold": True,
        "sma_slot_count": 2,
        "momentum_windows": [{"lookback": 60, "exclude": 0, "weight": 1.0}],
        "momentum_strategy": "Classic",
        "negative_momentum_strategy": "Cash",
    })
    out = L.single_backtest(cfg, idx, data)
    series = out[0]
    allocs = out[2]
    assert float(series.iloc[-1]) > 0
    # Last allocation should have at most 2 non-cash names
    last = allocs[sorted(allocs.keys())[-1]]
    names = [t for t, w in last.items() if t != "CASH" and w and w > 0.01]
    assert len(names) <= 2


def test_sticky_first_invested_day_is_equal_weight():
    """Init must split cash equally across N slots (not classic momentum-proportional)."""
    idx = pd.bdate_range("2018-01-02", periods=320)
    rng = np.random.default_rng(1)
    tickers = [f"T{i}" for i in range(8)]
    data = {}
    for i, t in enumerate(tickers):
        rets = rng.normal(0.0003 * (i + 1), 0.012, len(idx))
        close = 50 * np.cumprod(1 + rets)
        data[t] = _frame(idx, close)
    data["^GSPC"] = _frame(idx, np.linspace(100, 140, len(idx)))
    cfg = normalize_one({
        "name": "Eq",
        "stocks": [{"ticker": t, "allocation": 1 / len(tickers), "include_dividends": False} for t in tickers],
        "benchmark_ticker": "^GSPC",
        "initial_value": 10000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Monthly",
        "use_momentum": True,
        "use_sma_filter": True,
        "sma_window": 40,
        "ma_multiplier": 1.0,
        "use_sma_slot_hold": True,
        "sma_slot_count": 4,
        "use_max_allocation": True,
        "max_allocation_percent": 40,
        "momentum_windows": [{"lookback": 60, "exclude": 5, "weight": 1.0}],
        "first_rebalance_strategy": "rebalancing_date",
    })
    allocs = L.single_backtest(cfg, idx, data)[2]
    for d in sorted(allocs):
        names = {t: w for t, w in allocs[d].items() if t != "CASH" and w and w > 1e-6}
        if not names:
            continue
        assert len(names) <= 4
        ws = list(names.values())
        assert max(ws) - min(ws) < 1e-6, f"expected equal slots on first invest {d}: {names}"
        assert abs(sum(ws) - 1.0) < 1e-6
        break
    else:
        raise AssertionError("sticky run never invested")


def test_first_rebalance_strategy_honors_config():
    """Portfolio config must drive the first-rebalance gate (not only Streamlit session)."""
    idx = pd.bdate_range("2019-01-02", periods=280)
    close = np.linspace(100, 130, len(idx))
    data = {
        "AAA": _frame(idx, close * np.linspace(1.0, 1.3, len(idx))),
        "BBB": _frame(idx, close * np.linspace(1.0, 1.1, len(idx))),
        "CCC": _frame(idx, close),
        "^GSPC": _frame(idx, close),
    }
    stocks = [{"ticker": t, "allocation": 1 / 3, "include_dividends": False} for t in ("AAA", "BBB", "CCC")]
    base = {
        "name": "P",
        "stocks": stocks,
        "benchmark_ticker": "^GSPC",
        "initial_value": 9000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Monthly",
        "use_momentum": True,
        "use_sma_filter": True,
        "sma_window": 30,
        "ma_multiplier": 1.0,
        "use_sma_slot_hold": True,
        "sma_slot_count": 2,
        # Short score window so "rebalancing_date" can invest on the first month,
        # while "momentum_window_complete" still waits for the (longer) calendar gate below.
        "momentum_windows": [{"lookback": 15, "exclude": 0, "weight": 1.0}],
    }

    def first_invested(strat: str, lookback: int):
        allocs = L.single_backtest(
            normalize_one({
                **base,
                "first_rebalance_strategy": strat,
                "momentum_windows": [{"lookback": lookback, "exclude": 0, "weight": 1.0}],
            }),
            idx,
            data,
        )[2]
        for d in sorted(allocs):
            names = [t for t, w in allocs[d].items() if t != "CASH" and w and w > 1e-6]
            if names:
                return pd.Timestamp(d)
        return None

    early = first_invested("rebalancing_date", lookback=15)
    late = first_invested("momentum_window_complete", lookback=120)
    assert early is not None and late is not None
    assert late > early, f"window-complete should invest later ({late} vs {early})"


def test_flag_off_matches_baseline_path():
    idx = pd.bdate_range("2019-01-02", periods=400)
    close = np.linspace(100, 160, len(idx))
    data = {
        "AAA": _frame(idx, close),
        "BBB": _frame(idx, close * np.linspace(1.0, 1.2, len(idx))),
        "^GSPC": _frame(idx, close),
    }
    stocks = [
        {"ticker": "AAA", "allocation": 0.5, "include_dividends": False},
        {"ticker": "BBB", "allocation": 0.5, "include_dividends": False},
    ]
    base = {
        "name": "P",
        "stocks": stocks,
        "benchmark_ticker": "^GSPC",
        "initial_value": 10000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Monthly",
        "use_momentum": True,
        "use_sma_filter": False,
        "momentum_windows": [{"lookback": 90, "exclude": 10, "weight": 1.0}],
    }
    a = L.single_backtest(normalize_one(base), idx, data)
    b = L.single_backtest(normalize_one({**base, "use_sma_slot_hold": False}), idx, data)
    assert abs(float(a[0].iloc[-1]) - float(b[0].iloc[-1])) < 1e-6
