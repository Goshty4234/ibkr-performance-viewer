"""Synthetic trading calendar (NYSE-like: ~252 days a year) and rebalancing dates."""

from __future__ import annotations

from functools import lru_cache

import numpy as np
import pandas as pd
from pandas.tseries.holiday import (
    AbstractHolidayCalendar,
    GoodFriday,
    Holiday,
    USLaborDay,
    USMartinLutherKingJr,
    USMemorialDay,
    USPresidentsDay,
    USThanksgivingDay,
    nearest_workday,
)
from pandas.tseries.offsets import CustomBusinessDay

TDAYS = 252  # trading days per year, used for every annualisation


class _NyseLike(AbstractHolidayCalendar):
    rules = [
        Holiday("NewYear", month=1, day=1, observance=nearest_workday),
        USMartinLutherKingJr,
        USPresidentsDay,
        GoodFriday,
        USMemorialDay,
        Holiday("Juneteenth", month=6, day=19, observance=nearest_workday),
        Holiday("Independence", month=7, day=4, observance=nearest_workday),
        USLaborDay,
        USThanksgivingDay,
        Holiday("Christmas", month=12, day=25, observance=nearest_workday),
    ]


@lru_cache(maxsize=8)
def _dates(n: int) -> np.ndarray:
    idx = pd.date_range("2000-01-03", periods=n, freq=CustomBusinessDay(calendar=_NyseLike()))
    return idx.values.astype("datetime64[D]")


def make_calendar(years: float, max_lookback_days: int) -> tuple[np.ndarray, int]:
    """(dates, e0): dates cover a warm-up long enough for the longest window, then `years` of
    simulated life starting at index e0 (the first allocation day)."""
    n_eval = max(2, int(round(years * TDAYS)))
    guess = int(np.ceil(max_lookback_days / 365.25 * TDAYS)) + 15
    d = _dates(guess + n_eval + 5)
    e0 = int(np.searchsorted(d, d[0] + np.timedelta64(int(max_lookback_days), "D"), side="left"))
    if e0 > guess + 5:  # pragma: no cover - calendar sanity
        raise RuntimeError("warm-up longer than expected")
    return d[: e0 + n_eval], e0


def asof(d: np.ndarray, target: np.datetime64) -> int:
    """Index of the last trading day on or before `target` (-1 if before the first day)."""
    return int(np.searchsorted(d, target, side="right")) - 1


def _first_of_group(keys: np.ndarray) -> np.ndarray:
    """Positions where the group key changes (first trading day of each group)."""
    if len(keys) == 0:
        return np.array([], dtype=int)
    change = np.nonzero(keys[1:] != keys[:-1])[0] + 1
    return np.concatenate([[0], change])


def rebalance_indices(freq: str, d: np.ndarray, e0: int) -> np.ndarray:
    """First allocation at e0, then the first trading day of every period after it."""
    T = len(d)
    if freq in ("Never", "Buy & Hold", "Buy & Hold (Target)"):
        return np.array([e0], dtype=int)
    months = d.astype("datetime64[M]")
    ym = months.astype(np.int64)  # months since 1970-01
    month_of_year = (ym % 12) + 1
    if freq == "Monthly":
        key, allowed = ym, None
    elif freq == "Quarterly":
        key, allowed = ym, {1, 4, 7, 10}
    elif freq == "Semiannually":
        key, allowed = ym, {1, 7}
    elif freq == "Annually":
        key, allowed = ym, {1}
    elif freq in ("Weekly", "Biweekly"):
        wk = ((d.astype("datetime64[D]").astype(np.int64) + 3) // 7)  # week index, Monday-based
        starts = _first_of_group(wk)
        if freq == "Biweekly":
            starts = starts[::2]
        idx = starts[starts > e0]
        return np.concatenate([[e0], idx]).astype(int)
    else:
        key, allowed = ym, None  # unknown label: monthly, like the engine's fallback
    starts = _first_of_group(key)
    if allowed is not None:
        starts = starts[np.isin(month_of_year[starts], list(allowed))]
    idx = starts[starts > e0]
    return np.concatenate([[e0], idx]).astype(int)
