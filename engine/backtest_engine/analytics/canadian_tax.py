"""Canadian capital-gains + dividend tax paid from the portfolio during a backtest.

When ``use_canadian_tax`` is on, the day loop keeps an ACB ledger, banks net capital
losses for later years, and on each tax-season session (default: first session on/after
30 April of Y+1) withdraws the tax due for calendar year Y — cash first, then pro-rata
sales. Buy & Hold with no sells pays no capital-gains tax; dividends are still taxed.

Flag off → this module is never consulted; results match the untaxed path.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd

TAX_CFG_KEYS = (
    "use_canadian_tax",
    "canadian_tax_inclusion_rate",
    "canadian_tax_marginal_rate",
    "canadian_tax_dividend_rate",
    "canadian_tax_payment_month",
    "canadian_tax_payment_day",
)


def tax_enabled(cfg: dict | None) -> bool:
    return bool(cfg) and bool(cfg.get("use_canadian_tax", False))


def strip_tax_identity(cfg: dict) -> dict:
    """Drop tax keys when the feature is off so cached/history identities stay stable."""
    if cfg.get("use_canadian_tax"):
        return cfg
    return {k: v for k, v in cfg.items() if k not in TAX_CFG_KEYS}


def _rate(cfg: dict, key: str, default: float) -> float:
    try:
        v = float(cfg.get(key, default))
    except (TypeError, ValueError):
        v = default
    if not np.isfinite(v):
        return default
    # Accept 0–1 or 0–100 (UI percents).
    if v > 1.0:
        v = v / 100.0
    return float(min(max(v, 0.0), 1.0))


def tax_rates(cfg: dict) -> tuple[float, float, float]:
    """inclusion, marginal, dividend — each in 0..1."""
    return (
        _rate(cfg, "canadian_tax_inclusion_rate", 0.50),
        _rate(cfg, "canadian_tax_marginal_rate", 0.53),
        _rate(cfg, "canadian_tax_dividend_rate", 0.38),
    )


def payment_month_day(cfg: dict) -> tuple[int, int]:
    try:
        month = int(cfg.get("canadian_tax_payment_month", 4) or 4)
    except (TypeError, ValueError):
        month = 4
    try:
        day = int(cfg.get("canadian_tax_payment_day", 30) or 30)
    except (TypeError, ValueError):
        day = 30
    month = min(max(month, 1), 12)
    day = min(max(day, 1), 28 if month == 2 else 30 if month in (4, 6, 9, 11) else 31)
    return month, day


def payment_deadline(year: int, cfg: dict) -> pd.Timestamp:
    """Deadline for calendar year ``year`` (paid in year+1 by default)."""
    month, day = payment_month_day(cfg)
    return pd.Timestamp(year=year + 1, month=month, day=day)


@dataclass
class _YearBucket:
    realized: float = 0.0
    dividends: float = 0.0


@dataclass
class TaxLedger:
    inclusion: float
    marginal: float
    dividend_rate: float
    payment_month: int
    payment_day: int
    shares: dict[str, float] = field(default_factory=dict)
    cost: dict[str, float] = field(default_factory=dict)  # total ACB
    years: dict[int, _YearBucket] = field(default_factory=dict)
    carryforward: float = 0.0  # unused net capital losses (>0)
    settled_years: set[int] = field(default_factory=set)
    settled_result: dict[int, tuple[float, float, float, float]] = field(default_factory=dict)
    paid_years: set[int] = field(default_factory=set)
    events: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_config(cls, cfg: dict) -> TaxLedger:
        incl, marg, div = tax_rates(cfg)
        month, day = payment_month_day(cfg)
        return cls(inclusion=incl, marginal=marg, dividend_rate=div, payment_month=month, payment_day=day)

    def _bucket(self, year: int) -> _YearBucket:
        b = self.years.get(year)
        if b is None:
            b = _YearBucket()
            self.years[year] = b
        return b

    def record_dividend(self, amount: float, year: int) -> None:
        if amount > 0 and np.isfinite(amount):
            self._bucket(year).dividends += float(amount)

    def buy(self, ticker: str, qty: float, price: float) -> None:
        if qty <= 0 or price <= 0 or not np.isfinite(qty) or not np.isfinite(price):
            return
        self.shares[ticker] = self.shares.get(ticker, 0.0) + qty
        self.cost[ticker] = self.cost.get(ticker, 0.0) + qty * price

    def sell(self, ticker: str, qty: float, price: float, year: int) -> float:
        """Realize a sale; returns capital gain (negative = loss)."""
        held = self.shares.get(ticker, 0.0)
        if qty <= 0 or held <= 0 or price <= 0 or not np.isfinite(qty) or not np.isfinite(price):
            return 0.0
        sold = min(qty, held)
        basis_total = self.cost.get(ticker, 0.0)
        basis = basis_total * sold / held
        proceeds = sold * price
        gain = proceeds - basis
        left = held - sold
        if left * price < 0.005:
            self.shares[ticker] = 0.0
            self.cost[ticker] = 0.0
        else:
            self.shares[ticker] = left
            self.cost[ticker] = basis_total - basis
        self._bucket(year).realized += gain
        return gain

    def sync_ticker(self, ticker: str, value: float, price: float, year: int, tol_value: float = 0.01) -> None:
        """Align share lot to ``value/price``; buys/sells any gap (rebalance / DRIP / tax sale)."""
        if not np.isfinite(price) or price <= 0:
            if np.isfinite(value) and abs(value) < tol_value and self.shares.get(ticker, 0.0) > 0:
                # Position wiped without a price: clear lots without realizing (degenerate).
                self.shares[ticker] = 0.0
                self.cost[ticker] = 0.0
            return
        target = value / price if np.isfinite(value) and value > 0 else 0.0
        held = self.shares.get(ticker, 0.0)
        delta = target - held
        if abs(delta) * price < tol_value:
            # Keep share count exact when the dollar gap is noise.
            if target <= 0 and held > 0:
                self.shares[ticker] = 0.0
                self.cost[ticker] = 0.0
            return
        if delta > 0:
            self.buy(ticker, delta, price)
        else:
            self.sell(ticker, -delta, price, year)

    def sync_portfolio(
        self,
        values: dict[str, float],
        prices: dict[str, float],
        year: int,
        tol_value: float = 0.01,
    ) -> None:
        for t, val in values.items():
            self.sync_ticker(t, float(val), float(prices.get(t, np.nan)), year, tol_value=tol_value)
        for t in list(self.shares):
            if t not in values and self.shares.get(t, 0.0) > 0:
                self.sync_ticker(t, 0.0, float(prices.get(t, np.nan)), year, tol_value=tol_value)

    def net_taxable_for_year(self, year: int) -> tuple[float, float, float, float]:
        """Return (cg_taxable_after_carry, div_income, cg_tax, div_tax) for a calendar year.

        Applies loss carryforward to that year's net realized gains only. Does not mutate
        carryforward — call :meth:`settle_year` to commit.
        """
        b = self.years.get(year) or _YearBucket()
        net = b.realized
        carry = self.carryforward
        if net > 0:
            used = min(carry, net)
            taxable_cg = net - used
        else:
            taxable_cg = 0.0
        cg_tax = max(0.0, taxable_cg) * self.inclusion * self.marginal
        div_tax = max(0.0, b.dividends) * self.dividend_rate
        return taxable_cg, b.dividends, cg_tax, div_tax

    def settle_year(self, year: int) -> tuple[float, float, float, float]:
        """Commit carryforward for ``year`` once; safe to call again (returns the same tuple)."""
        if year in self.settled_years:
            return self.settled_result[year]
        b = self.years.get(year) or _YearBucket()
        net = b.realized
        if net > 0:
            used = min(self.carryforward, net)
            self.carryforward -= used
            taxable_cg = net - used
        else:
            if net < 0:
                self.carryforward += -net
            taxable_cg = 0.0
        cg_tax = max(0.0, taxable_cg) * self.inclusion * self.marginal
        div_tax = max(0.0, b.dividends) * self.dividend_rate
        result = (taxable_cg, float(b.dividends), cg_tax, div_tax)
        self.settled_years.add(year)
        self.settled_result[year] = result
        return result

    def tax_due(self, year: int) -> float:
        _, _, cg_tax, div_tax = self.net_taxable_for_year(year)
        return cg_tax + div_tax

    def unpaid_years_due(self, on_or_before: pd.Timestamp, settle_through: int | None = None) -> list[int]:
        """Calendar years not yet paid that should be settled on ``on_or_before``.

        Normally a year Y is due on/after its payment deadline (default 30 Apr Y+1).
        When ``settle_through`` is set (last session of a backtest), every unpaid year
        ``<= settle_through`` is due immediately so the final equity reflects tax owed
        even if the calendar deadline is still in the future.
        """
        years = set(self.years)
        if settle_through is not None:
            years |= {y for y in years if y <= settle_through}
            years |= {settle_through}
        due = []
        for y in sorted(years):
            if y in self.paid_years:
                continue
            if settle_through is not None and y <= settle_through:
                due.append(y)
                continue
            deadline = pd.Timestamp(year=y + 1, month=self.payment_month, day=self.payment_day)
            if pd.Timestamp(on_or_before) >= deadline:
                due.append(y)
        return due


def withdraw_tax(
    ledger: TaxLedger,
    year: int,
    values: dict[str, float],
    prices: dict[str, float],
    unallocated_cash: float,
    unreinvested_cash: float,
    date: pd.Timestamp,
) -> tuple[dict[str, float], float, float, dict[str, Any] | None]:
    """Pay tax for ``year`` from cash then pro-rata holdings.

    Returns (new_values, new_unallocated, new_unreinvested, event_or_none).
    Capital gains from the tax sale itself are booked to ``date.year`` via sync after the call.
    """
    taxable_cg, dividends, cg_tax, div_tax = ledger.settle_year(year)
    due = cg_tax + div_tax
    ledger.paid_years.add(year)
    if due <= 0.005:
        return values, unallocated_cash, unreinvested_cash, None

    uc = float(unallocated_cash)
    ur = float(unreinvested_cash)
    cash = uc + ur
    taken_cash = min(cash, due)
    remaining = due - taken_cash
    if taken_cash > 0:
        # Drain unreinvested first (dividends sitting in cash), then unallocated.
        from_ur = min(ur, taken_cash)
        ur -= from_ur
        uc -= taken_cash - from_ur
        if uc < 0:
            uc = 0.0
        if ur < 0:
            ur = 0.0

    new_values = dict(values)
    sold_notional = 0.0
    if remaining > 0.005:
        # Pro-rata sell by current market value.
        investable = {t: v for t, v in new_values.items() if v > 0.01 and prices.get(t, 0) > 0}
        total_mv = sum(investable.values())
        if total_mv > 0:
            # Sell enough notional to cover remaining. Extra CG is taxed next year.
            frac = min(1.0, remaining / total_mv)
            for t, v in investable.items():
                sell_v = v * frac
                if sell_v <= 0:
                    continue
                p = prices[t]
                qty = sell_v / p
                ledger.sell(t, qty, p, int(date.year))
                new_values[t] = v - sell_v
                sold_notional += sell_v
            # If rounding left a gap and we sold everything, cash may still be short — accept it.
            remaining = max(0.0, remaining - sold_notional)

    paid = due - remaining
    if paid <= 0.005:
        return new_values, uc, ur, None

    event = {
        "date": date.strftime("%Y-%m-%d") if hasattr(date, "strftime") else str(date)[:10],
        "tax_year": year,
        "amount": round(paid, 2),
        "cg_tax": round(cg_tax, 2),
        "div_tax": round(div_tax, 2),
        "taxable_cg": round(taxable_cg, 2),
        "dividends": round(dividends, 2),
        "from_cash": round(taken_cash, 2),
        "from_sales": round(sold_notional, 2),
        "carryforward_after": round(ledger.carryforward, 2),
    }
    ledger.events.append(event)
    return new_values, uc, ur, event


def apply_tax_day(
    ledger: TaxLedger,
    date: pd.Timestamp,
    values: dict[str, float],
    prices: dict[str, float],
    unallocated_cash: float,
    unreinvested_cash: float,
    *,
    force_settle_through: int | None = None,
) -> tuple[dict[str, float], float, float, list[dict[str, Any]], float]:
    """Pay every unpaid year due on ``date``. Returns values/cash/events/total_paid."""
    due_years = ledger.unpaid_years_due(pd.Timestamp(date), settle_through=force_settle_through)
    events: list[dict[str, Any]] = []
    total_paid = 0.0
    uc, ur = unallocated_cash, unreinvested_cash
    vals = dict(values)
    for y in due_years:
        vals, uc, ur, ev = withdraw_tax(ledger, y, vals, prices, uc, ur, pd.Timestamp(date))
        if ev:
            events.append(ev)
            total_paid += float(ev["amount"])
        # Keep lots aligned after cash-only withdrawals (no share change) and sales.
        ledger.sync_portfolio(vals, prices, int(pd.Timestamp(date).year))
    return vals, uc, ur, events, total_paid
