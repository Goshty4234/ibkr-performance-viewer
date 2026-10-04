"""The ticker list must not depend on the folder the engine was started from.

Regression: right after a start (or an update restart) the engine's working directory is the package
folder, and /store/tickers opened marketdata/ticker_cache relative to it: an empty store, "0 tickers",
until a run or a search switched the working directory to the data home.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

import diskcache
import pandas as pd


class StoreListIgnoresCwd(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        root = Path(self.tmp.name)
        self.home = root / "data"
        self.elsewhere = root / "package"
        self.elsewhere.mkdir()
        (self.home / "marketdata").mkdir(parents=True)
        self.env = os.environ.get("ENGINE_HOME")
        os.environ["ENGINE_HOME"] = str(self.home)
        days = pd.bdate_range("2024-01-02", periods=5)
        store = diskcache.Cache(str(self.home / "marketdata" / "ticker_cache"))
        store.set("AAPL_max_False", pd.DataFrame({"Close": [1.0, 2, 3, 4, 5], "Dividends": 0.0}, index=days))
        store.close()

    def tearDown(self) -> None:
        os.chdir(self.cwd)
        if self.env is None:
            os.environ.pop("ENGINE_HOME", None)
        else:
            os.environ["ENGINE_HOME"] = self.env
        self.tmp.cleanup()

    def test_list_from_a_foreign_working_directory(self) -> None:
        from backtest_engine import data_api

        os.chdir(self.elsewhere)
        rows = data_api.store_list()
        self.assertEqual([r["ticker"] for r in rows], ["AAPL"])
        self.assertFalse((self.elsewhere / "marketdata").exists(), "no stray store created beside the package")


if __name__ == "__main__":
    unittest.main()
