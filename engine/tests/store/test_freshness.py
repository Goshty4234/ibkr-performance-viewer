"""A check stamped today must not hide a last bar that is still weeks behind."""

from __future__ import annotations

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from backtest_engine.price_store import GRACE_DAYS, days_behind, up_to_date

NY = ZoneInfo("America/New_York")


class PriceFreshness(unittest.TestCase):
    def test_recent_check_does_not_hide_an_old_last_bar(self) -> None:
        now = datetime(2026, 10, 30, 18, 0, tzinfo=NY)
        meta = {"last": "2026-10-05", "checked": now.timestamp()}
        self.assertGreater(days_behind(meta, now), GRACE_DAYS)
        self.assertFalse(up_to_date(meta, now))

    def test_weekend_gap_stays_current(self) -> None:
        # Monday morning: the last settled close is the previous Friday.
        now = datetime(2026, 11, 2, 10, 0, tzinfo=NY)
        meta = {"last": "2026-10-30", "checked": now.timestamp()}
        self.assertLessEqual(days_behind(meta, now), GRACE_DAYS)
        self.assertTrue(up_to_date(meta, now))


if __name__ == "__main__":
    unittest.main()
