"""A check stamped today must not hide a last bar that is still weeks behind."""

from __future__ import annotations

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

import pandas as pd

from backtest_engine.price_store import (
    DELISTED_RECHECK_S,
    GRACE_DAYS,
    days_behind,
    delisted_hold,
    names_to_delist,
    up_to_date,
)

NY = ZoneInfo("America/New_York")


class PriceFreshness(unittest.TestCase):
    def test_recent_check_does_not_hide_an_old_last_bar(self) -> None:
        now = datetime(2026, 10, 30, 18, 0, tzinfo=NY)
        meta = {"last": "2026-10-05", "checked": now.timestamp()}
        self.assertGreater(days_behind(meta, now), GRACE_DAYS)
        self.assertFalse(up_to_date(meta, now))

    def test_morning_check_is_enough_the_same_afternoon(self) -> None:
        morning = datetime(2026, 10, 30, 9, 0, tzinfo=NY)
        afternoon = datetime(2026, 10, 30, 15, 0, tzinfo=NY)
        meta = {"last": "2026-10-29", "checked": morning.timestamp()}
        self.assertTrue(up_to_date(meta, afternoon))

    def test_one_stopped_name_is_delisted_when_the_book_is_current(self) -> None:
        lasts = {f"T{i}": pd.Timestamp("2026-10-30") for i in range(10)}
        lasts["WBD"] = pd.Timestamp("2026-10-05")
        self.assertEqual(names_to_delist(lasts, yahoo_reached=True, rate_limited=False), ["WBD"])

    def test_a_whole_group_still_behind_is_not_called_delisted(self) -> None:
        lasts = {f"T{i}": pd.Timestamp("2026-10-05") for i in range(8)}
        lasts["SPY"] = pd.Timestamp("2026-10-30")
        self.assertEqual(names_to_delist(lasts, yahoo_reached=True, rate_limited=False), [])

    def test_rate_limit_does_not_mark_delisted(self) -> None:
        lasts = {"SPY": pd.Timestamp("2026-10-30"), "WBD": pd.Timestamp("2026-10-05")}
        self.assertEqual(names_to_delist(lasts, yahoo_reached=True, rate_limited=True), [])

    def test_delisted_name_is_not_fetched_again_the_same_month(self) -> None:
        now = datetime(2026, 10, 30, 15, 0, tzinfo=NY).timestamp()
        meta = {"delisted": True, "delisted_at": now - 3600}
        self.assertTrue(delisted_hold(meta, now))
        self.assertFalse(delisted_hold({"delisted": True, "delisted_at": now - DELISTED_RECHECK_S - 1}, now))

    def test_weekend_gap_stays_current(self) -> None:
        # Monday morning: the last settled close is the previous Friday.
        now = datetime(2026, 11, 2, 10, 0, tzinfo=NY)
        meta = {"last": "2026-10-30", "checked": now.timestamp()}
        self.assertLessEqual(days_behind(meta, now), GRACE_DAYS)
        self.assertTrue(up_to_date(meta, now))


if __name__ == "__main__":
    unittest.main()
