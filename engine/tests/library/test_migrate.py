"""The hidden-looking .streamlit folder becomes marketdata without losing the ticker cache."""

import sys
import tempfile
import unittest
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[2]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from backtest_engine import DATA_README, migrate_layout  # noqa: E402


class MigrateTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _put(self, rel: str, data: bytes) -> None:
        p = self.home / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)

    def test_old_folder_is_renamed_with_its_content(self) -> None:
        self._put(".streamlit/ticker_cache/00/a.val", b"price")
        self._put(".streamlit/quote_store/SPY.json", b"q")
        migrate_layout(self.home)
        self.assertFalse((self.home / ".streamlit").exists())
        self.assertEqual((self.home / "marketdata/ticker_cache/00/a.val").read_bytes(), b"price")
        self.assertEqual((self.home / "marketdata/quote_store/SPY.json").read_bytes(), b"q")

    def test_both_exist_nothing_is_lost(self) -> None:
        (self.home / "marketdata/ticker_cache").mkdir(parents=True)  # recreated empty by a run
        self._put("marketdata/ticker_cache/new.val", b"new")
        self._put(".streamlit/ticker_cache/old.val", b"old")
        self._put(".streamlit/ticker_cache/new.val", b"stale")
        self._put(".streamlit/sec_store/x", b"s")
        migrate_layout(self.home)
        self.assertFalse((self.home / ".streamlit").exists())
        self.assertEqual((self.home / "marketdata/ticker_cache/old.val").read_bytes(), b"old")
        self.assertEqual((self.home / "marketdata/ticker_cache/new.val").read_bytes(), b"new")  # current wins
        self.assertEqual((self.home / "marketdata/sec_store/x").read_bytes(), b"s")

    def test_idempotent_and_no_op_without_old_folder(self) -> None:
        self._put("marketdata/ticker_cache/a.val", b"p")
        migrate_layout(self.home)
        migrate_layout(self.home)
        self.assertEqual((self.home / "marketdata/ticker_cache/a.val").read_bytes(), b"p")
        self.assertFalse((self.home / ".streamlit").exists())

    def test_other_renames_still_work(self) -> None:
        self._put(".jobs/j1/result", b"r")
        migrate_layout(self.home)
        self.assertEqual((self.home / "jobs/j1/result").read_bytes(), b"r")

    def test_readme_no_longer_mentions_streamlit(self) -> None:
        migrate_layout(self.home)
        text = (self.home / "LISEZ-MOI.txt").read_text(encoding="utf-8")
        self.assertEqual(text, DATA_README)
        self.assertNotIn("streamlit", text.lower())
        self.assertIn("marketdata", text)


if __name__ == "__main__":
    unittest.main()
