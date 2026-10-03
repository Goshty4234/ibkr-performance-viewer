"""Local library: path safety, atomic writes, listing, usage, cleaning, auto-clean."""

from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from backtest_engine.library import Library, LibraryError, start_auto_clean

U = "117980c8-88a7-4c38-8e50-d0de81574787"
R = "0a1b2c3d-1111-2222-3333-444455556666"
DAY = 86400


def iso(ts: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.lib = Library(self.home)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def make_run(self, run: str, age_days: float = 0, pinned: bool = False, payload: int = 100) -> None:
        now = time.time()
        self.lib.put_run_file(U, run, "summary.json.gz", b"s" * payload)
        self.lib.put_run_file(U, run, "portfolio/0.json.gz", b"p" * payload)
        self.lib.put_run_file(U, run, "portfolio/3.json.gz", b"q" * payload)
        meta = {"id": run, "label": "x", "pinned": pinned, "created_at": iso(now - age_days * DAY)}
        self.lib.put_run_file(U, run, "meta.json", json.dumps(meta).encode())


class Safety(Base):
    def test_rejects_traversal_and_odd_names(self) -> None:
        bad_files = ["../x", "portfolio/../../x", "summary.json", "portfolio/a.json.gz", "/etc/passwd",
                     "portfolio/0.json.gz/../../../x", "allocations/..", "a\\b", ""]
        for name in bad_files:
            with self.assertRaises(LibraryError, msg=name):
                self.lib.put_run_file(U, R, name, b"x")
        for user in ("..", "a/b", "", "a b", "guest:1234", "x" * 65, "."):
            with self.assertRaises(LibraryError, msg=user):
                self.lib.put_run_file(user, R, "summary.json.gz", b"x")
        for run in ("..", "a/b", ""):
            with self.assertRaises(LibraryError, msg=run):
                self.lib.put_run_file(U, run, "summary.json.gz", b"x")
        for name in ("../a.csv", "a/b.csv", ".hidden", "bad:name.csv", "end.", ""):
            with self.assertRaises(LibraryError, msg=name):
                self.lib.put_ibkr(U, name, b"x")
        self.assertEqual(list(self.home.rglob("*")), [])  # nothing escaped or half-written

    def test_nothing_written_outside_home(self) -> None:
        outside = self.home.parent / "escape.txt"
        with self.assertRaises(LibraryError):
            self.lib.put_run_file(U, R, "../../../escape.txt", b"x")
        self.assertFalse(outside.exists())

    def test_allowed_names(self) -> None:
        for name in ("summary.json.gz", "meta.json", "portfolio/12.json.gz", "allocations/3.json.gz", "allocations/a-b_c.json.gz"):
            self.lib.put_run_file(U, R, name, b"ok")
            self.assertEqual(self.lib.get_run_file(U, R, name).read_bytes(), b"ok")


class Storage(Base):
    def test_atomic_overwrite_leaves_no_temp(self) -> None:
        self.lib.put_run_file(U, R, "summary.json.gz", b"one")
        self.lib.put_run_file(U, R, "summary.json.gz", b"two-two")
        self.assertEqual(self.lib.get_run_file(U, R, "summary.json.gz").read_bytes(), b"two-two")
        self.assertEqual([p.name for p in self.lib.run_dir(U, R).iterdir()], ["summary.json.gz"])

    def test_missing_file_is_none(self) -> None:
        self.assertIsNone(self.lib.get_run_file(U, R, "summary.json.gz"))
        self.assertEqual(self.lib.list_runs(U), [])

    def test_list_runs(self) -> None:
        self.make_run(R, payload=10)
        runs = self.lib.list_runs(U)
        self.assertEqual(len(runs), 1)
        r = runs[0]
        self.assertEqual((r["id"], r["summary"], r["portfolios"]), (R, True, [0, 3]))
        self.assertEqual(r["meta"]["pinned"], False)
        self.assertGreaterEqual(r["bytes"], 30)

    def test_delete_run(self) -> None:
        self.make_run(R)
        self.assertTrue(self.lib.delete_run(U, R))
        self.assertFalse(self.lib.delete_run(U, R))
        self.assertEqual(self.lib.list_runs(U), [])

    def test_ibkr_roundtrip(self) -> None:
        self.lib.put_ibkr(U, "U123_20240101_20241231.csv", b"a,b\n1,2\n")
        self.lib.put_ibkr(U, "Relevé été.csv", b"x")
        names = [f["name"] for f in self.lib.list_ibkr(U)]
        self.assertEqual(sorted(names), ["Relevé été.csv", "U123_20240101_20241231.csv"])
        self.assertTrue(self.lib.delete_ibkr(U, "Relevé été.csv"))
        self.assertFalse(self.lib.delete_ibkr(U, "Relevé été.csv"))

    def test_configs_backup(self) -> None:
        self.assertIsNone(self.lib.get_configs(U))
        self.lib.put_configs(U, b'{"a":1}')
        self.assertEqual(self.lib.get_configs(U).read_bytes(), b'{"a":1}')


class Usage(Base):
    def test_usage_by_folder(self) -> None:
        self.make_run(R, payload=1000)
        self.lib.put_ibkr(U, "a.csv", b"x" * 500)
        (self.home / ".streamlit" / "ticker_cache").mkdir(parents=True)
        (self.home / ".streamlit" / "ticker_cache" / "SPY.pkl").write_bytes(b"z" * 4000)
        u = self.lib.usage()
        by = {f["name"]: f for f in u["folders"]}
        self.assertEqual(by[".streamlit"]["bytes"], 4000)
        self.assertEqual(by["ibkr"]["bytes"], 500)
        self.assertGreaterEqual(by["backtests"]["bytes"], 3000)
        self.assertEqual(u["total"], sum(f["bytes"] for f in u["folders"]))
        self.assertEqual(u["folders"][0]["name"], ".streamlit")  # biggest first
        self.assertTrue(by["backtests"]["label"])
        self.assertEqual(u["settings"], {"auto_clean_days": 30, "keep_pinned": True})


class Cleaning(Base):
    def test_clean_runs_by_age_and_pin(self) -> None:
        self.make_run("old-1", age_days=45)
        self.make_run("old-pinned", age_days=90, pinned=True)
        self.make_run("recent", age_days=5)
        res = self.lib.clean_runs(30)
        self.assertEqual(res["removed"], 1)
        left = sorted(r["id"] for r in self.lib.list_runs(U))
        self.assertEqual(left, ["old-pinned", "recent"])
        res = self.lib.clean_runs(30, keep_pinned=False)
        self.assertEqual(res["removed"], 1)
        self.assertEqual([r["id"] for r in self.lib.list_runs(U)], ["recent"])

    def test_clean_all_runs(self) -> None:
        self.make_run("a")
        self.make_run("b", pinned=True)
        self.assertEqual(self.lib.clean_runs(None)["removed"], 1)  # pinned survive by default
        self.assertEqual(self.lib.clean_runs(None, keep_pinned=False)["removed"], 1)
        self.assertEqual(self.lib.list_runs(U), [])

    def test_run_without_meta_uses_file_time(self) -> None:
        self.lib.put_run_file(U, "nometa", "summary.json.gz", b"x")
        self.assertEqual(self.lib.clean_runs(30)["removed"], 0)  # just written
        self.assertEqual(self.lib.clean_runs(30, now=time.time() + 40 * DAY)["removed"], 1)

    def test_clean_ibkr(self) -> None:
        self.lib.put_ibkr(U, "a.csv", b"1")
        self.lib.put_ibkr(U, "b.csv", b"22")
        self.assertEqual(self.lib.clean_ibkr(U), {"removed": 2, "freed": 3})
        self.assertEqual(self.lib.list_ibkr(U), [])

    def test_clean_cache_only_temp_folders(self) -> None:
        (self.home / "cache" / "portfolios").mkdir(parents=True)
        (self.home / "cache" / "portfolios" / "k.json").write_bytes(b"x" * 10)
        (self.home / "jobs" / "j1").mkdir(parents=True)
        (self.home / "jobs" / "j1" / "summary.json.gz").write_bytes(b"x" * 5)
        (self.home / ".streamlit").mkdir()
        (self.home / ".streamlit" / "keep.pkl").write_bytes(b"k")
        self.make_run(R)
        self.assertEqual(self.lib.clean_cache(), {"removed": 2, "freed": 15})
        self.assertTrue((self.home / ".streamlit" / "keep.pkl").exists())
        self.assertEqual(len(self.lib.list_runs(U)), 1)

    def test_auto_clean_settings(self) -> None:
        self.make_run("old", age_days=40)
        self.make_run("new", age_days=1)
        self.assertEqual(self.lib.auto_clean()["removed"], 1)
        self.lib.set_settings({"auto_clean_days": 0})
        self.make_run("old2", age_days=400)
        self.assertIsNone(self.lib.auto_clean())  # off
        self.assertEqual(len(self.lib.list_runs(U)), 2)
        self.lib.set_settings({"auto_clean_days": 7, "keep_pinned": False})
        self.assertEqual(self.lib.settings(), {"auto_clean_days": 7, "keep_pinned": False})
        self.assertEqual(self.lib.auto_clean()["removed"], 1)

    def test_settings_validation(self) -> None:
        self.lib.set_settings({"auto_clean_days": 99999, "keep_pinned": "yes"})
        self.assertEqual(self.lib.settings(), {"auto_clean_days": 3650, "keep_pinned": True})
        self.lib.set_settings({"auto_clean_days": -5})
        self.assertEqual(self.lib.settings()["auto_clean_days"], 0)
        self.lib.set_settings({"auto_clean_days": True})  # bool is not a number of days
        self.assertEqual(self.lib.settings()["auto_clean_days"], 0)
        self.lib.settings_path.write_text("{broken", encoding="utf-8")
        self.assertEqual(self.lib.settings(), {"auto_clean_days": 30, "keep_pinned": True})

    def test_background_thread_cleans_and_stops(self) -> None:
        self.make_run("old", age_days=60)
        stop = start_auto_clean(self.lib, interval_s=3600, first_delay_s=0.05)
        deadline = time.time() + 3
        while time.time() < deadline and self.lib.list_runs(U):
            time.sleep(0.05)
        stop.set()
        self.assertEqual(self.lib.list_runs(U), [])


if __name__ == "__main__":
    unittest.main()
