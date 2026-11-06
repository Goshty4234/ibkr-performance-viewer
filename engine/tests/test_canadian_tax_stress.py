"""Hard edge cases for in-sim Canadian tax withdrawal — nothing subtle should slip."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from backtest_engine.accel import install
from backtest_engine.analytics.canadian_tax import (
    TaxLedger,
    apply_tax_day,
    strip_tax_identity,
    withdraw_tax,
)
from backtest_engine.config import normalize_one

install()
from backtest_engine.legacy import multi_backtest as L  # noqa: E402


def _frame(idx, close, divs=None):
    s = pd.Series(np.asarray(close, dtype=float), index=idx)
    df = pd.DataFrame({
        "Close": s,
        "Open": s,
        "High": s,
        "Low": s,
        "Price_change": s.pct_change().fillna(0.0),
        "Dividends": 0.0,
    })
    if divs:
        for i, amt in divs:
            df.loc[idx[i], "Dividends"] = amt
    return df


def _cfg(**kw):
    base = {
        "name": "T",
        "stocks": [{"ticker": "AAA", "allocation": 1, "include_dividends": True}],
        "benchmark_ticker": "^GSPC",
        "initial_value": 10_000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Buy & Hold",
        "use_momentum": False,
        "use_canadian_tax": True,
        "canadian_tax_inclusion_rate": 50,
        "canadian_tax_marginal_rate": 50,
        "canadian_tax_dividend_rate": 40,
        "canadian_tax_payment_month": 4,
        "canadian_tax_payment_day": 30,
    }
    base.update(kw)
    return normalize_one(base)


def _run(cfg, idx, data):
    return L.single_backtest(cfg, idx, data)


# ---------------------------------------------------------------------------
# Flag off must be bit-identical to a portfolio that never heard of tax
# ---------------------------------------------------------------------------

def test_flag_off_series_identical_to_baseline():
    idx = pd.bdate_range("2019-01-02", periods=520)
    close = 100 * np.cumprod(1 + np.random.default_rng(0).normal(0.0004, 0.01, len(idx)))
    data = {"AAA": _frame(idx, close, [(40, 1.5), (280, 1.2)]), "^GSPC": _frame(idx, close)}
    bare = _cfg(use_canadian_tax=False, rebalancing_frequency="Annually",
                stocks=[{"ticker": "AAA", "allocation": 1, "include_dividends": True}])
    # Explicit False vs stripped identity should still run the same path
    a = _run(bare, idx, data)
    b = _run(normalize_one({k: v for k, v in bare.items() if k != "use_canadian_tax" or v}), idx, data)
    # Same engine path: finals match
    assert abs(float(a[0].iloc[-1]) - float(b[0].iloc[-1])) < 1e-9
    assert a[4] == []


def test_flag_off_never_emits_events_even_with_huge_realized_gains():
    idx = pd.bdate_range("2020-01-02", periods=400)
    a = np.linspace(50, 200, len(idx))
    b = np.linspace(200, 50, len(idx))  # forces annual rebalance turnover
    data = {
        "AAA": _frame(idx, a),
        "BBB": _frame(idx, b),
        "^GSPC": _frame(idx, (a + b) / 2),
    }
    cfg = _cfg(
        use_canadian_tax=False,
        rebalancing_frequency="Annually",
        stocks=[
            {"ticker": "AAA", "allocation": 0.5, "include_dividends": True},
            {"ticker": "BBB", "allocation": 0.5, "include_dividends": True},
        ],
    )
    out = _run(cfg, idx, data)
    assert out[4] == []


def test_strip_identity_stable_when_off():
    off = normalize_one({"name": "P", "stocks": [{"ticker": "X", "allocation": 1}]})
    assert "use_canadian_tax" in off  # normalize keeps the key
    stripped = strip_tax_identity(off)
    assert "use_canadian_tax" not in stripped
    assert "canadian_tax_marginal_rate" not in stripped
    on = strip_tax_identity(_cfg())
    assert on["use_canadian_tax"] is True


# ---------------------------------------------------------------------------
# Exact ledger math
# ---------------------------------------------------------------------------

def test_exact_tax_formula_gain_only():
    led = TaxLedger.from_config(_cfg())
    led.buy("T", 100, 10)          # cost 1000
    led.sell("T", 100, 30, 2020)   # gain 2000
    # inclusion 50% * marginal 50% = 25% of 2000 = 500
    _, _, cg, div = led.net_taxable_for_year(2020)
    assert abs(cg - 500) < 1e-9
    assert div == 0


def test_exact_tax_formula_with_carryforward_chain():
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 100, 20)
    led.sell("A", 100, 5, 2018)    # loss -1500
    led.settle_year(2018)
    assert abs(led.carryforward - 1500) < 1e-9

    led.buy("B", 50, 10)
    led.sell("B", 50, 20, 2019)    # gain +500 → fully offset
    tax_cg, _, cg_tax, _ = led.settle_year(2019)
    assert abs(tax_cg) < 1e-9
    assert abs(cg_tax) < 1e-9
    assert abs(led.carryforward - 1000) < 1e-9

    led.buy("C", 100, 10)
    led.sell("C", 100, 25, 2020)   # gain +1500 → taxable 500 → tax 125
    tax_cg, _, cg_tax, _ = led.settle_year(2020)
    assert abs(tax_cg - 500) < 1e-9
    assert abs(cg_tax - 125) < 1e-9
    assert abs(led.carryforward) < 1e-9


def test_same_year_loss_fully_offsets_gain_before_carry():
    led = TaxLedger.from_config(_cfg())
    led.buy("W", 10, 100)
    led.buy("L", 10, 100)
    led.sell("W", 10, 200, 2021)  # +1000
    led.sell("L", 10, 50, 2021)   # -500
    taxable, _, cg_tax, _ = led.net_taxable_for_year(2021)
    assert abs(taxable - 500) < 1e-9
    assert abs(cg_tax - 125) < 1e-9


def test_capital_loss_does_not_offset_dividend_tax():
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 10, 100)
    led.sell("A", 10, 50, 2020)   # -500 loss
    led.record_dividend(1000, 2020)
    taxable, divs, cg_tax, div_tax = led.settle_year(2020)
    assert taxable == 0
    assert cg_tax == 0
    assert abs(div_tax - 400) < 1e-9  # 1000 * 40%
    assert abs(led.carryforward - 500) < 1e-9


def test_zero_marginal_means_zero_cg_tax_but_div_still_due():
    led = TaxLedger.from_config(_cfg(canadian_tax_marginal_rate=0, canadian_tax_dividend_rate=40))
    led.buy("A", 10, 10)
    led.sell("A", 10, 100, 2020)  # huge gain
    led.record_dividend(50, 2020)
    _, _, cg_tax, div_tax = led.net_taxable_for_year(2020)
    assert cg_tax == 0
    assert abs(div_tax - 20) < 1e-9


# ---------------------------------------------------------------------------
# Withdrawal mechanics
# ---------------------------------------------------------------------------

def test_cash_withdrawal_does_not_change_share_lots():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10)
    led.record_dividend(500, 2020)  # div tax 200
    values = {"AAA": 1500.0}
    prices = {"AAA": 15.0}
    new_v, uc, ur, ev = withdraw_tax(led, 2020, values, prices, 500.0, 0.0, pd.Timestamp("2021-04-30"))
    assert ev["from_cash"] == 200
    assert ev["from_sales"] == 0
    assert abs(new_v["AAA"] - 1500) < 1e-9
    assert abs(led.shares["AAA"] - 100) < 1e-9
    assert abs(uc - 300) < 1e-9


def test_pro_rata_sale_keeps_relative_weights():
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 100, 10)
    led.buy("B", 100, 10)
    led.record_dividend(1000, 2020)  # tax 400
    values = {"A": 2000.0, "B": 1000.0}  # 2:1
    prices = {"A": 20.0, "B": 10.0}
    new_v, _, _, ev = withdraw_tax(led, 2020, values, prices, 0.0, 0.0, pd.Timestamp("2021-04-30"))
    assert abs(ev["from_sales"] - 400) < 1e-6
    # Remaining 2600, still 2:1
    assert abs(new_v["A"] / new_v["B"] - 2.0) < 1e-6


def test_unreinvested_cash_drained_before_unallocated():
    led = TaxLedger.from_config(_cfg())
    led.record_dividend(250, 2020)  # tax 100
    _, uc, ur, ev = withdraw_tax(
        led, 2020, {"X": 1.0}, {"X": 1.0},
        unallocated_cash=80.0, unreinvested_cash=50.0,
        date=pd.Timestamp("2021-04-30"),
    )
    assert abs(ev["from_cash"] - 100) < 1e-9
    assert abs(ur) < 1e-9          # 50 drained first
    assert abs(uc - 30) < 1e-9     # then 50 from unallocated → 80-50=30


def test_deadline_not_paid_one_session_early():
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 10, 10)
    led.sell("A", 10, 20, 2020)  # tax 25
    vals = {"Z": 1000.0}
    prices = {"Z": 10.0}
    _, _, _, events, paid = apply_tax_day(led, pd.Timestamp("2021-04-29"), vals, prices, 100, 0)
    assert events == [] and paid == 0
    _, _, _, events, paid = apply_tax_day(led, pd.Timestamp("2021-04-30"), vals, prices, 100, 0)
    assert len(events) == 1 and abs(paid - 25) < 1e-9


# ---------------------------------------------------------------------------
# Full day-loop stress
# ---------------------------------------------------------------------------

def test_equity_drop_lands_on_tax_event_date():
    idx = pd.bdate_range("2020-01-02", periods=400)
    close = np.linspace(100, 160, len(idx))
    data = {"SPY": _frame(idx, close, [(25, 3.0)]), "^GSPC": _frame(idx, close)}
    # Enough idle cash via collect_dividends so first payment can be cash-funded after drip off
    cfg = _cfg(
        rebalancing_frequency="Buy & Hold",
        collect_dividends_as_cash=True,
        stocks=[{"ticker": "SPY", "allocation": 1, "include_dividends": True}],
    )
    off = _run(_cfg(use_canadian_tax=False, collect_dividends_as_cash=True,
                    stocks=[{"ticker": "SPY", "allocation": 1, "include_dividends": True}],
                    rebalancing_frequency="Buy & Hold"), idx, data)
    on = _run(cfg, idx, data)
    assert on[4], "expected at least one tax event"
    series_off = off[0]
    series_on = on[0]
    for ev in on[4]:
        d = pd.Timestamp(ev["date"])
        # Find index of tax date
        if d not in series_on.index:
            # first session on/after
            d = series_on.index[series_on.index >= d][0]
        i = series_on.index.get_loc(d)
        if i == 0:
            continue
        # On tax day the taxed curve should be meaningfully below the untaxed one
        # (or equal only if amount somehow 0 — not our case).
        gap = float(series_off.iloc[i]) - float(series_on.iloc[i])
        assert gap > ev["amount"] * 0.5, (ev, gap)


def test_buy_hold_dividend_year_has_no_capital_gains_tax():
    """Buy & Hold: calendar year with only dividends (no voluntary sells) → cg_tax == 0.

    The day-loop redeploys dividend cash into holdings before April, so the *payment*
    may sell shares (CG booked to the payment year). The tax year itself stays CG-free.
    """
    idx = pd.bdate_range("2020-01-02", periods=400)
    close = np.linspace(100, 105, len(idx))
    data = {"SPY": _frame(idx, close, [(10, 5.0)]), "^GSPC": _frame(idx, close)}
    cfg = _cfg(
        collect_dividends_as_cash=True,
        rebalancing_frequency="Buy & Hold",
        stocks=[{"ticker": "SPY", "allocation": 1, "include_dividends": True}],
    )
    out = _run(cfg, idx, data)
    y2020 = [e for e in out[4] if e["tax_year"] == 2020]
    assert y2020, out[4]
    assert y2020[0]["cg_tax"] == 0.0
    assert y2020[0]["div_tax"] > 0


def test_idle_unallocated_cash_funds_tax_before_any_sale():
    """If unallocated cash is still sitting there on tax day, it is drained first."""
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 50, 10)
    led.sell("A", 50, 20, 2020)  # gain 500 → tax 125
    # Portfolio is all cash after the sale; pay from unallocated.
    new_v, uc, ur, ev = withdraw_tax(
        led, 2020, {}, {}, unallocated_cash=1000.0, unreinvested_cash=0.0,
        date=pd.Timestamp("2021-04-30"),
    )
    assert ev["from_cash"] == 125
    assert ev["from_sales"] == 0
    assert abs(uc - 875) < 1e-9
    assert new_v == {}


def test_annual_rebalance_produces_cg_tax_and_markers_after_april():
    idx = pd.bdate_range("2019-06-03", periods=700)
    a = np.linspace(100, 250, len(idx))
    b = np.linspace(100, 90, len(idx))
    data = {
        "AAA": _frame(idx, a),
        "BBB": _frame(idx, b),
        "^GSPC": _frame(idx, (a + b) / 2),
    }
    cfg = _cfg(
        rebalancing_frequency="Annually",
        stocks=[
            {"ticker": "AAA", "allocation": 0.5, "include_dividends": False},
            {"ticker": "BBB", "allocation": 0.5, "include_dividends": False},
        ],
        canadian_tax_dividend_rate=0,
    )
    out = _run(cfg, idx, data)
    assert out[4], "expected CG tax from annual turnover"
    for ev in out[4]:
        d = pd.Timestamp(ev["date"])
        # Payment for year Y is on/after Apr 30 Y+1, or last sim day (force settle)
        if d == out[0].index[-1]:
            continue
        assert d.month > 4 or (d.month == 4 and d.day >= 30) or d.month >= 5
        assert ev["amount"] > 0


def test_tax_on_final_strictly_below_tax_off_when_gains_exist():
    idx = pd.bdate_range("2020-01-02", periods=500)
    rng = np.random.default_rng(42)
    rets = rng.normal(0.0005, 0.012, len(idx))
    close = 100 * np.cumprod(1 + rets)
    data = {
        "AAA": _frame(idx, close),
        "BBB": _frame(idx, close * np.linspace(1.0, 0.7, len(idx))),
        "^GSPC": _frame(idx, close),
    }
    stocks = [
        {"ticker": "AAA", "allocation": 0.6, "include_dividends": False},
        {"ticker": "BBB", "allocation": 0.4, "include_dividends": False},
    ]
    off = _run(_cfg(use_canadian_tax=False, rebalancing_frequency="Quarterly", stocks=stocks,
                    canadian_tax_dividend_rate=0), idx, data)
    on = _run(_cfg(rebalancing_frequency="Quarterly", stocks=stocks, canadian_tax_dividend_rate=0), idx, data)
    assert float(on[0].iloc[-1]) < float(off[0].iloc[-1])
    assert sum(e["amount"] for e in on[4]) > 0


def test_no_additions_curve_also_drops_on_tax():
    idx = pd.bdate_range("2020-01-02", periods=400)
    close = np.linspace(100, 180, len(idx))
    data = {"SPY": _frame(idx, close, [(15, 2.0)]), "^GSPC": _frame(idx, close)}
    stocks = [{"ticker": "SPY", "allocation": 1, "include_dividends": True}]
    off = _run(_cfg(use_canadian_tax=False, stocks=stocks), idx, data)
    on = _run(_cfg(stocks=stocks), idx, data)
    assert float(on[1].iloc[-1]) < float(off[1].iloc[-1])


def test_payment_date_custom_month_day():
    led = TaxLedger.from_config(_cfg(canadian_tax_payment_month=6, canadian_tax_payment_day=15))
    led.buy("A", 10, 10)
    led.sell("A", 10, 20, 2020)
    vals, prices = {"Z": 500.0}, {"Z": 10.0}
    _, _, _, ev, paid = apply_tax_day(led, pd.Timestamp("2021-06-14"), vals, prices, 100, 0)
    assert paid == 0
    _, _, _, ev, paid = apply_tax_day(led, pd.Timestamp("2021-06-15"), vals, prices, 100, 0)
    assert abs(paid - 25) < 1e-9


def test_force_settle_commits_carryforward_on_last_day():
    """A loss in the final calendar year must still bank carryforward via force settle."""
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 100, 10)
    led.sell("A", 100, 4, 2024)  # -600
    apply_tax_day(
        led, pd.Timestamp("2024-11-01"), {"X": 100.0}, {"X": 1.0},
        0.0, 0.0, force_settle_through=2024,
    )
    assert 2024 in led.paid_years
    assert abs(led.carryforward - 600) < 1e-9


def test_tax_sale_cg_is_booked_to_payment_year_not_tax_year():
    """Selling in Apr 2021 to pay 2020 tax creates 2021 CG, paid later."""
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 100, 10)
    led.sell("A", 50, 20, 2020)  # gain 500 → tax 125; 50 shares left, cost 500
    values = {"A": 50 * 30.0}    # remaining lot now worth 1500 (price 30)
    prices = {"A": 30.0}
    # No cash → must sell to pay 125
    new_v, uc, ur, ev = withdraw_tax(led, 2020, values, prices, 0.0, 0.0, pd.Timestamp("2021-04-30"))
    assert ev["tax_year"] == 2020
    assert abs(ev["amount"] - 125) < 1e-6
    # Tax-sale CG landed in 2021 bucket
    assert led._bucket(2021).realized > 0
    assert led._bucket(2020).realized == pytest.approx(500)


def test_rates_clamp_and_percent_parsing():
    from backtest_engine.analytics.canadian_tax import tax_rates
    assert tax_rates({"canadian_tax_inclusion_rate": 150, "canadian_tax_marginal_rate": -5,
                      "canadian_tax_dividend_rate": "nope"})[0] == 1.0
    # invalid dividend falls back to default 0.38
    assert tax_rates({"canadian_tax_inclusion_rate": 50, "canadian_tax_marginal_rate": 50,
                      "canadian_tax_dividend_rate": "x"})[2] == 0.38


def test_monthly_rebalance_divergence_realizes_substantial_cg_tax():
    """Regression: share sync must see rebalance sells, otherwise CG tax stays at 0 forever."""
    idx = pd.bdate_range("2020-01-02", periods=500)
    a = np.linspace(100, 300, len(idx))
    b = np.linspace(100, 50, len(idx))
    data = {
        "AAA": _frame(idx, a),
        "BBB": _frame(idx, b),
        "^GSPC": _frame(idx, (a + b) / 2),
    }
    stocks = [
        {"ticker": "AAA", "allocation": 0.5, "include_dividends": False},
        {"ticker": "BBB", "allocation": 0.5, "include_dividends": False},
    ]
    on = _run(
        _cfg(rebalancing_frequency="Monthly", stocks=stocks, canadian_tax_dividend_rate=0),
        idx,
        data,
    )
    cg_total = sum(e["cg_tax"] for e in on[4])
    assert cg_total > 100, on[4]
    assert any(e["taxable_cg"] > 0 for e in on[4])
