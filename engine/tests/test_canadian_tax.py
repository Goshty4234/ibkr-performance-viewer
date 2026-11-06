"""Canadian tax ledger: ACB, loss carryforward, dividend tax, withdrawal."""

from __future__ import annotations

import pandas as pd

from backtest_engine.analytics.canadian_tax import (
    TaxLedger,
    apply_tax_day,
    strip_tax_identity,
    tax_enabled,
    tax_rates,
    withdraw_tax,
)
from backtest_engine.config import normalize_one


def _cfg(**kw):
    base = {
        "name": "T",
        "stocks": [{"ticker": "AAA", "allocation": 1}],
        "use_canadian_tax": True,
        "canadian_tax_inclusion_rate": 50,
        "canadian_tax_marginal_rate": 50,
        "canadian_tax_dividend_rate": 40,
        "canadian_tax_payment_month": 4,
        "canadian_tax_payment_day": 30,
    }
    base.update(kw)
    return base


def test_normalize_defaults_off():
    out = normalize_one({"name": "P", "stocks": [{"ticker": "SPY", "allocation": 1}]})
    assert out["use_canadian_tax"] is False
    assert out["canadian_tax_inclusion_rate"] == 50.0
    assert out["canadian_tax_marginal_rate"] == 53.0
    assert out["canadian_tax_dividend_rate"] == 38.0


def test_normalize_keeps_tax_on():
    out = normalize_one(_cfg(canadian_tax_marginal_rate=40))
    assert out["use_canadian_tax"] is True
    assert out["canadian_tax_marginal_rate"] == 40.0


def test_strip_identity_when_off():
    raw = normalize_one({"name": "P", "stocks": [{"ticker": "SPY", "allocation": 1}]})
    stripped = strip_tax_identity(raw)
    assert "use_canadian_tax" not in stripped
    assert "canadian_tax_marginal_rate" not in stripped
    on = strip_tax_identity(normalize_one(_cfg()))
    assert on["use_canadian_tax"] is True
    assert "canadian_tax_marginal_rate" in on


def test_tax_enabled():
    assert tax_enabled({}) is False
    assert tax_enabled({"use_canadian_tax": False}) is False
    assert tax_enabled({"use_canadian_tax": True}) is True


def test_rates_accept_percent_or_fraction():
    assert tax_rates({"canadian_tax_inclusion_rate": 50, "canadian_tax_marginal_rate": 0.53, "canadian_tax_dividend_rate": 38}) == (
        0.5,
        0.53,
        0.38,
    )


def test_buy_and_hold_no_cg_tax_until_sell():
    """No sales → no capital-gains tax; dividends still taxed."""
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10.0)  # $1000 cost
    led.sync_ticker("AAA", 1500.0, 15.0, 2020)  # price up, same shares → no trade
    assert abs(led.shares["AAA"] - 100) < 1e-9
    assert abs(led.cost["AAA"] - 1000) < 1e-9
    assert led._bucket(2020).realized == 0.0

    led.record_dividend(100.0, 2020)
    taxable_cg, divs, cg_tax, div_tax = led.net_taxable_for_year(2020)
    assert taxable_cg == 0.0
    assert cg_tax == 0.0
    assert divs == 100.0
    assert abs(div_tax - 40.0) < 1e-9  # 100 * 40%


def test_realized_gain_taxed_at_inclusion_times_marginal():
    led = TaxLedger.from_config(_cfg())  # 50% inclusion * 50% marginal = 25% of gain
    led.buy("AAA", 100, 10.0)
    gain = led.sell("AAA", 100, 20.0, 2021)  # +1000
    assert abs(gain - 1000) < 1e-9
    taxable_cg, _, cg_tax, _ = led.net_taxable_for_year(2021)
    assert abs(taxable_cg - 1000) < 1e-9
    assert abs(cg_tax - 250.0) < 1e-9  # 1000 * 0.5 * 0.5


def test_loss_offsets_same_year_gains():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10.0)
    led.buy("BBB", 100, 10.0)
    led.sell("AAA", 100, 20.0, 2022)  # +1000
    led.sell("BBB", 100, 5.0, 2022)  # -500
    taxable_cg, _, cg_tax, _ = led.net_taxable_for_year(2022)
    assert abs(taxable_cg - 500) < 1e-9
    assert abs(cg_tax - 125.0) < 1e-9


def test_loss_carryforward_offsets_future_gains():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10.0)
    led.sell("AAA", 100, 4.0, 2020)  # -600
    led.settle_year(2020)
    assert abs(led.carryforward - 600) < 1e-9

    led.buy("BBB", 50, 10.0)
    led.sell("BBB", 50, 20.0, 2021)  # +500
    taxable_cg, _, cg_tax, _ = led.net_taxable_for_year(2021)
    assert abs(taxable_cg - 0.0) < 1e-9  # fully offset by carryforward
    assert cg_tax == 0.0
    led.settle_year(2021)
    assert abs(led.carryforward - 100) < 1e-9  # 600 - 500 left


def test_carryforward_partial_then_tax():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 10, 10.0)
    led.sell("AAA", 10, 0.0, 2019)  # weird; use positive price
    # redo properly
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 10, 100.0)
    led.sell("AAA", 10, 50.0, 2019)  # -500
    led.settle_year(2019)
    led.buy("BBB", 10, 10.0)
    led.sell("BBB", 10, 110.0, 2020)  # +1000
    taxable_cg, _, cg_tax, _ = led.settle_year(2020)
    assert abs(taxable_cg - 500) < 1e-9
    assert abs(cg_tax - 125.0) < 1e-9
    assert abs(led.carryforward) < 1e-9


def test_drip_increases_acb_via_sync():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10.0)
    # Price flat at 10, value rises by $50 dividend reinvested → 5 new shares
    led.sync_ticker("AAA", 1050.0, 10.0, 2020)
    assert abs(led.shares["AAA"] - 105) < 1e-6
    assert abs(led.cost["AAA"] - 1050) < 1e-6
    assert led._bucket(2020).realized == 0.0


def test_withdraw_prefers_cash():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10.0)
    led.sell("AAA", 50, 20.0, 2020)  # gain 500 → tax 125
    led.record_dividend(0.0, 2020)
    values = {"AAA": 1000.0}  # 50 shares @ 20
    prices = {"AAA": 20.0}
    new_v, uc, ur, ev = withdraw_tax(led, 2020, values, prices, unallocated_cash=200.0, unreinvested_cash=0.0, date=pd.Timestamp("2021-04-30"))
    assert ev is not None
    assert abs(ev["amount"] - 125.0) < 1e-6
    assert abs(ev["from_cash"] - 125.0) < 1e-6
    assert abs(ev["from_sales"] - 0.0) < 1e-6
    assert abs(uc - 75.0) < 1e-6
    assert abs(new_v["AAA"] - 1000.0) < 1e-6  # no sale


def test_withdraw_sells_pro_rata_when_cash_short():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10.0)
    led.sell("AAA", 100, 30.0, 2020)  # gain 2000 → tax 500
    # After full sale, buy back into portfolio for withdrawal test of a later year…
    # Simpler: leave a position and create tax from dividends only so sale is clean.
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 100, 10.0)
    led.buy("BBB", 100, 10.0)
    led.record_dividend(1000.0, 2020)  # div tax = 400
    values = {"AAA": 1000.0, "BBB": 1000.0}
    prices = {"AAA": 10.0, "BBB": 10.0}
    new_v, uc, ur, ev = withdraw_tax(led, 2020, values, prices, 0.0, 0.0, pd.Timestamp("2021-04-30"))
    assert ev is not None
    assert abs(ev["amount"] - 400.0) < 1e-6
    assert abs(ev["from_sales"] - 400.0) < 1e-6
    assert abs(sum(new_v.values()) - 1600.0) < 1e-6
    # Pro-rata: each loses 200
    assert abs(new_v["AAA"] - 800.0) < 1e-6
    assert abs(new_v["BBB"] - 800.0) < 1e-6


def test_apply_tax_day_deadline_and_markers():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 10, 10.0)
    led.sell("AAA", 10, 20.0, 2020)  # gain 100 → tax 25
    values = {"BBB": 1000.0}
    prices = {"BBB": 10.0}
    # Too early
    v, uc, ur, events, paid = apply_tax_day(led, pd.Timestamp("2021-04-29"), values, prices, 100.0, 0.0)
    assert events == []
    assert paid == 0.0
    assert 2020 not in led.paid_years
    # On deadline
    v, uc, ur, events, paid = apply_tax_day(led, pd.Timestamp("2021-04-30"), values, prices, 100.0, 0.0)
    assert len(events) == 1
    assert events[0]["tax_year"] == 2020
    assert abs(paid - 25.0) < 1e-6
    assert abs(uc - 75.0) < 1e-6


def test_force_settle_on_last_sim_day():
    """End of sim settles the current year before its April deadline so the curve shows the drag."""
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 10, 10.0)
    led.sell("AAA", 10, 20.0, 2024)  # tax 25, deadline April 2025
    values = {"X": 500.0}
    prices = {"X": 10.0}
    v, uc, ur, events, paid = apply_tax_day(
        led, pd.Timestamp("2024-10-15"), values, prices, 100.0, 0.0, force_settle_through=2024
    )
    assert len(events) == 1
    assert events[0]["tax_year"] == 2024
    assert abs(paid - 25.0) < 1e-6
    assert abs(uc - 75.0) < 1e-6


def test_unpaid_years_force_settle_ignores_deadline():
    led = TaxLedger.from_config(_cfg())
    led.buy("AAA", 10, 10.0)
    led.sell("AAA", 10, 20.0, 2024)
    due = led.unpaid_years_due(pd.Timestamp("2024-12-31"), settle_through=2024)
    assert due == [2024]
    assert led.unpaid_years_due(pd.Timestamp("2024-12-31")) == []


def test_buy_hold_portfolio_only_pays_dividend_tax():
    """No sells → equity drops only by dividend tax at season, not by phantom CG."""
    led = TaxLedger.from_config(_cfg())
    led.buy("SPY", 100, 100.0)  # $10k
    # Price doubles, still holding — unrealized, no CG.
    led.sync_ticker("SPY", 20000.0, 200.0, 2020)
    led.record_dividend(200.0, 2020)  # div tax 80
    values = {"SPY": 20000.0}
    prices = {"SPY": 200.0}
    new_v, uc, ur, events, paid = apply_tax_day(
        led, pd.Timestamp("2021-04-30"), values, prices, 0.0, 0.0
    )
    assert len(events) == 1
    assert abs(paid - 80.0) < 1e-6
    assert abs(sum(new_v.values()) - 19920.0) < 1e-6
    assert events[0]["cg_tax"] == 0.0


def test_losses_then_gains_multi_year_withdrawal():
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 100, 10.0)
    led.sell("A", 100, 5.0, 2018)  # -500 loss
    # Pay 2018 (no tax due) to bank carryforward via withdraw path
    v, uc, ur, ev = withdraw_tax(led, 2018, {"CASHish": 1.0}, {"CASHish": 1.0}, 100.0, 0.0, pd.Timestamp("2019-04-30"))
    assert ev is None
    assert abs(led.carryforward - 500) < 1e-9

    led.buy("B", 100, 10.0)
    led.sell("B", 100, 20.0, 2019)  # +1000, taxable 500 after carry → tax 125
    values = {"X": 1000.0}
    prices = {"X": 10.0}
    new_v, uc, ur, events, paid = apply_tax_day(led, pd.Timestamp("2020-04-30"), values, prices, 200.0, 0.0)
    assert abs(paid - 125.0) < 1e-6
    assert abs(uc - 75.0) < 1e-6
    assert abs(led.carryforward) < 1e-9


def test_settle_year_idempotent():
    led = TaxLedger.from_config(_cfg())
    led.buy("A", 10, 10.0)
    led.sell("A", 10, 5.0, 2020)  # -50
    a = led.settle_year(2020)
    b = led.settle_year(2020)
    assert a == b
    assert abs(led.carryforward - 50) < 1e-9
