"""Vectorized equivalent of legacy get_dates_by_freq (same dates, O(n log n))."""

from __future__ import annotations

import pandas as pd

from ..legacy import multi_backtest as L

_NONE = {"Never", "none", None, "Buy & Hold", "Buy & Hold (Target)"}


def _first_on_or_after(days: pd.DatetimeIndex, targets: list[pd.Timestamp]) -> list[pd.Timestamp]:
    if not targets:
        return []
    pos = days.searchsorted(pd.DatetimeIndex(targets), side="left")
    return [days[p] if p < len(days) else None for p in pos]


def dates_by_freq(freq: str | None, market_days: pd.DatetimeIndex) -> list[pd.Timestamp]:
    """Sorted dates; `market_days` plays the role of (start=idx[0], end=idx[-1], market_days=idx)."""
    if len(market_days) == 0:
        return []
    start, end = market_days[0], market_days[-1]
    days = pd.DatetimeIndex(sorted(market_days))
    if freq in _NONE:
        return []
    if freq == "market_day":
        return sorted(set(days))
    if freq == "calendar_day":
        return list(pd.date_range(start=start, end=end, freq="D"))
    if freq in ("Weekly", "Biweekly"):
        first_monday = start - pd.Timedelta(days=start.weekday())
        if start.weekday() > 0:
            first_monday += pd.Timedelta(weeks=1)
        step = pd.Timedelta(weeks=1 if freq == "Weekly" else 2)
        targets = []
        cur = first_monday
        while cur <= end:
            targets.append(cur)
            cur += step
        found = _first_on_or_after(days, targets)
        return sorted({d for d in found if d is not None and start <= d <= end})
    if freq == "Monthly":
        targets = [pd.Timestamp(year=y, month=m, day=1) for y in range(start.year, end.year + 1) for m in range(1, 13)]
        found = _first_on_or_after(days, targets)
        return sorted({d for d in found if d is not None and start <= d <= end})
    if freq in ("Quarterly", "Semiannually"):
        months = (1, 4, 7, 10) if freq == "Quarterly" else (1, 7)
        targets = [pd.Timestamp(year=y, month=m, day=1) for y in range(start.year, end.year + 1) for m in months]
        targets = [t for t in targets if start <= t <= end]
        found = _first_on_or_after(days, targets)
        return sorted({d for d in found if d is not None})
    if freq in ("Annually", "year"):
        targets = [pd.Timestamp(year=y, month=1, day=1) for y in range(start.year, end.year + 1)]
        found = _first_on_or_after(days, targets)
        return sorted({d for d in found if d is not None and start <= d <= end})
    return sorted(L.get_dates_by_freq(freq, start, end, market_days))
