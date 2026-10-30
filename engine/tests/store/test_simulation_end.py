"""One series that stopped weeks ago must not freeze the simulation on that day."""

from __future__ import annotations

import unittest

import pandas as pd

from backtest_engine.context import RunContext, RunOptions
from backtest_engine.runner import _reindex, _simulation_range


def _frame(end: str) -> pd.DataFrame:
    index = pd.bdate_range("2024-01-02", end)
    return pd.DataFrame({"Close": 1.0, "Dividends": 0.0}, index=index)


class SimulationEnd(unittest.TestCase):
    def test_a_dead_ticker_does_not_set_the_end(self) -> None:
        data = {"SPY": _frame("2026-10-30"), "WBD": _frame("2026-10-05")}
        configs = [{"name": "P", "stocks": [{"ticker": "SPY"}, {"ticker": "WBD"}]}]
        _start, end, _display = _simulation_range(data, configs, RunOptions(), RunContext())
        self.assertEqual(pd.Timestamp(end).normalize(), pd.Timestamp("2026-10-30"))

    def test_a_dead_ticker_is_not_priced_after_its_last_bar(self) -> None:
        data = {"SPY": _frame("2026-10-30"), "WBD": _frame("2026-10-05")}
        out = _reindex(data, pd.date_range("2026-10-01", "2026-10-30", freq="D"))
        self.assertEqual(out["SPY"].loc["2026-10-30", "Close"], 1.0)
        self.assertTrue(pd.isna(out["WBD"].loc["2026-10-06", "Close"]))
        self.assertEqual(out["WBD"].loc["2026-10-05", "Close"], 1.0)
        # Saturday inside the live series is the Friday close, not a hole.
        self.assertEqual(out["SPY"].loc["2026-10-03", "Close"], 1.0)


if __name__ == "__main__":
    unittest.main()
