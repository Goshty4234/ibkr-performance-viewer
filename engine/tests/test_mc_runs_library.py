"""Saved Monte Carlo runs in the local library: listing, name checks, keep-the-latest pruning."""

import gzip
import json
import time

import pytest

from backtest_engine.library import MC_KEEP, Library, LibraryError


def _save(lib: Library, user: str, rid: str, n: int = 0) -> None:
    lib.mc_put(user, rid, "result.json.gz", gzip.compress(json.dumps({"n": n}).encode()))
    lib.mc_put(user, rid, "meta.json", json.dumps({"id": rid, "n": n}).encode())


def test_keeps_only_the_latest(tmp_path):
    lib = Library(tmp_path)
    for i in range(MC_KEEP + 5):
        _save(lib, "u1", f"mc{i:03d}", i)
        time.sleep(0.01)
    runs = lib.mc_list("u1")
    assert len(runs) == MC_KEEP
    assert runs[0]["id"] == f"mc{MC_KEEP + 4:03d}" and runs[0]["meta"]["n"] == MC_KEEP + 4


def test_users_are_separate_and_delete_works(tmp_path):
    lib = Library(tmp_path)
    _save(lib, "u1", "a")
    _save(lib, "u2", "b")
    assert [r["id"] for r in lib.mc_list("u1")] == ["a"]
    assert lib.mc_get("u1", "a", "result.json.gz").is_file()
    assert lib.mc_delete("u1", "a") and not lib.mc_delete("u1", "a")
    assert lib.mc_list("u1") == [] and len(lib.mc_list("u2")) == 1


def test_bad_names_are_refused(tmp_path):
    lib = Library(tmp_path)
    for user, run, name in [("u1", "r", "../x"), ("u1", "r", "evil.txt"), ("../u", "r", "meta.json"), ("u1", "../r", "meta.json")]:
        with pytest.raises(LibraryError):
            lib.mc_put(user, run, name, b"x")


def test_unfinished_run_is_not_listed(tmp_path):
    lib = Library(tmp_path)
    lib.mc_put("u1", "half", "meta.json", b"{}")
    assert lib.mc_list("u1") == []
