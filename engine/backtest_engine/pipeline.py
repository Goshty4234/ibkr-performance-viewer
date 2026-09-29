"""Parallel execution of one backtest request as independent tasks.

    prepare     download (network chunks under a cross-process lock, cached
                and local series without it), simulation range,
                universe maps -> snapshot on disk (one pickle per ticker)
    portfolio   one per portfolio (regular and fusion alike): loads only the
                tickers it reads, runs the backtest, statistics and analytics,
                writes portfolio/<i>.json.gz and a small summary piece
    assemble    market data + benchmarks + summary.json.gz

Any process can run any task of any job: the server pool interleaves tasks
of concurrent jobs, the CLI and the parity harness run them in-process or in
a local process pool. Workers keep a small per-job cache of loaded frames.
"""

from __future__ import annotations

import dataclasses
import gzip
import json
import os
import pickle
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

import pandas as pd

from . import analytics, engine_home, result_cache
from .context import RunContext
from .results import Axis, build_summary, dump_gz, load_gz, portfolio_detail, portfolio_summary
from .runner import (BacktestRun, PreparedRun, _reindex, assemble, install_session, isolate_frames, is_fusion, ma_seed,
                     prepare, run_one, tickers_for)
from .serialize import date_key

_DROP_COLUMNS = {"Open", "High", "Low", "Volume", "Adj Close", "Stock Splits", "Capital Gains"}
_MAX_FRAMES = int(os.environ.get("ENGINE_WORKER_FRAMES", "800"))


class FileLock:
    """Cross-process lock (O_EXCL file) with stale-lock recovery.

    Waiters leave a marker file so a holder that takes the lock repeatedly
    (chunked downloads) can hand it over instead of starving other jobs.
    """

    _MARKER_STALE_S = 60.0

    def __init__(self, path: Path, stale_s: float = 1800.0, poll_s: float = 0.25) -> None:
        self.path = path
        self.stale_s = stale_s
        self.poll_s = poll_s

    def __enter__(self) -> "FileLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        marker: Path | None = None
        touched = 0.0
        try:
            while True:
                try:
                    fd = os.open(str(self.path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    os.write(fd, str(os.getpid()).encode())
                    os.close(fd)
                    return self
                except FileExistsError:
                    now = time.time()
                    if now - touched > 5.0:
                        marker = marker or self.path.with_name(f"{self.path.name}.wait.{os.getpid()}.{threading.get_ident()}")
                        marker.touch()
                        touched = now
                    try:
                        if now - self.path.stat().st_mtime > self.stale_s:
                            self.path.unlink(missing_ok=True)
                            continue
                    except FileNotFoundError:
                        continue
                    time.sleep(self.poll_s)
        finally:
            if marker is not None:
                marker.unlink(missing_ok=True)

    def __exit__(self, *exc: Any) -> None:
        self.path.unlink(missing_ok=True)

    def yield_to_waiters(self) -> None:
        """Called between two holds: pause long enough for a waiting job to grab the lock."""
        now = time.time()
        for m in self.path.parent.glob(f"{self.path.name}.wait.*"):
            try:
                if now - m.stat().st_mtime < self._MARKER_STALE_S:
                    time.sleep(self.poll_s * 3)
                    return
                m.unlink(missing_ok=True)
            except FileNotFoundError:
                continue


def download_lock() -> FileLock:
    return FileLock(engine_home() / ".streamlit" / "download.lock")


def _trim(value: Any) -> Any:
    if isinstance(value, pd.DataFrame):
        drop = [c for c in value.columns if c in _DROP_COLUMNS]
        return value.drop(columns=drop) if drop else value
    return value


def _dump(obj: Any, path: Path) -> None:
    tmp = path.with_name(path.name + ".part")
    with open(tmp, "wb") as fh:
        pickle.dump(obj, fh, protocol=pickle.HIGHEST_PROTOCOL)
    tmp.replace(path)


def _load(path: Path) -> Any:
    with open(path, "rb") as fh:
        return pickle.load(fh)


# snapshot -------------------------------------------------------------------

def write_snapshot(job_dir: Path, prep: PreparedRun, keep_raw: bool = False) -> dict[str, Any]:
    ddir = job_dir / "data"
    ddir.mkdir(parents=True, exist_ok=True)
    (job_dir / "portfolio").mkdir(exist_ok=True)
    (job_dir / "pieces").mkdir(exist_ok=True)
    files: dict[str, Any] = {}
    trimmed: dict[str, Any] = {}
    for n, (key, value) in enumerate(prep.data.items()):
        value = _trim(value)
        trimmed[key] = value
        if isinstance(value, str):
            files[key] = ("str", value)
        else:
            name = f"{n:05d}.pkl"
            _dump(value, ddir / name)
            files[key] = ("file", name)
    meta = {"prep": dataclasses.replace(prep, data={}), "files": files, "keep_raw": keep_raw}
    _dump(meta, job_dir / "meta.pkl")
    return trimmed


class _JobEntry:
    def __init__(self, job_dir: Path, meta: dict) -> None:
        self.job_dir = job_dir
        self.prep: PreparedRun = meta["prep"]
        self.files: dict[str, Any] = meta["files"]
        self.keep_raw: bool = meta.get("keep_raw", False)
        self.raw: dict[str, Any] = {}
        self.reindexed: "OrderedDict[str, Any]" = OrderedDict()
        self._axis: Axis | None = None
        self._digests: dict[str, str] = {}
        self._session_digest: str | None = None

    def digest(self, key: str) -> str:
        d = self._digests.get(key)
        if d is None:
            d = self._digests[key] = result_cache.frame_digest(self._raw(key))
        return d

    def session_digest(self) -> str:
        if self._session_digest is None:
            self._session_digest = result_cache.object_digest(self.prep.session)
        return self._session_digest

    @property
    def axis(self) -> Axis:
        if self._axis is None:
            self._axis = Axis(self.prep.simulation_index)
        return self._axis

    def _raw(self, key: str) -> Any:
        if key not in self.raw:
            kind, value = self.files[key]
            self.raw[key] = value if kind == "str" else _load(self.job_dir / "data" / value)
        return self.raw[key]

    def frames(self, keys: list[str]) -> tuple[dict, dict]:
        raw: dict[str, Any] = {}
        reindexed: dict[str, Any] = {}
        for k in keys:
            if k not in self.files:
                continue
            raw[k] = self._raw(k)
            if k not in self.reindexed:
                self.reindexed[k] = _reindex({k: raw[k]}, self.prep.simulation_index)[k]
            else:
                self.reindexed.move_to_end(k)
            reindexed[k] = self.reindexed[k]
        if len(self.reindexed) > _MAX_FRAMES:
            wanted = set(keys)
            for k in list(self.reindexed.keys()):
                if len(self.reindexed) <= _MAX_FRAMES:
                    break
                if k not in wanted:
                    del self.reindexed[k]
                    self.raw.pop(k, None)
        return raw, reindexed


class JobCache:
    def __init__(self, max_jobs: int = 2) -> None:
        self.max_jobs = max_jobs
        self.entries: "OrderedDict[str, _JobEntry]" = OrderedDict()

    def get(self, job_dir: Path) -> _JobEntry:
        key = str(job_dir)
        entry = self.entries.get(key)
        if entry is None:
            entry = _JobEntry(job_dir, _load(job_dir / "meta.pkl"))
            self.entries[key] = entry
            while len(self.entries) > self.max_jobs:
                self.entries.popitem(last=False)
        else:
            self.entries.move_to_end(key)
        return entry

    def seed(self, job_dir: Path, trimmed: dict[str, Any]) -> None:
        entry = self.get(job_dir)
        entry.raw.update(trimmed)

    def drop(self, job_dir: Path) -> None:
        self.entries.pop(str(job_dir), None)


CACHE = JobCache()


# tasks ----------------------------------------------------------------------

def task_prepare(job_dir: Path, portfolios: Any, options: Any, progress: Callable[[float, str], None] | None = None,
                 keep_raw: bool = False) -> dict[str, Any]:
    job_dir.mkdir(parents=True, exist_ok=True)
    prep = prepare(portfolios, options, RunContext(progress_fn=progress), download_lock=download_lock(), with_market=True)
    trimmed = write_snapshot(job_dir, prep, keep_raw)
    CACHE.seed(job_dir, trimmed)
    return {
        "order": prep.execution_order(),
        "names": [c["name"] for c in prep.configs],
        "tickers": sum(1 for v in trimmed.values() if not isinstance(v, str)),
    }


def _reuse_key(entry: _JobEntry, index: int, keys: list[str], seed: list) -> str | None:
    prep = entry.prep
    cfg = prep.configs[index]
    group = [cfg]
    if is_fusion(cfg):
        group += [c for c in prep.configs if not is_fusion(c)]
    sim = prep.simulation_index
    return result_cache.task_key({
        "configs": group,
        "options": prep.options.to_dict(),
        "axis": [str(sim[0]) if len(sim) else None, str(sim[-1]) if len(sim) else None, len(sim)],
        "display_start": str(prep.display_start),
        "ma_seed": seed,
        "session": entry.session_digest(),
        # The snapshot order comes from a set (varies per process); fresh runs already see either order.
        "data": sorted([k, entry.digest(k)] for k in keys if k in entry.files),
    })


# The requested dates only act through the effective range (runner._simulation_range): the
# start is covered by "start"/"display_start" below, the end is compared by the app.
_NOT_IDENTITY = ("end_date", "align_start", "start_date")
_NOT_IDENTITY_CFG = ("end_date_user", "start_date_user")


def history_key(prep: PreparedRun, index: int) -> str | None:
    """Identity of portfolio `index`'s result apart from where it ends.

    Two runs whose keys match and whose simulations end on the same day give identical results
    for this portfolio, so the web app can reuse a saved one (and align a new run's end on it).
    Price contents are not part of it: bars that were final when the earlier run was made do not
    change, and the app only reuses runs made after their last bar settled.
    """
    cfg = prep.configs[index]
    group = [cfg]
    if is_fusion(cfg):
        wanted = set(cfg["fusion_portfolio"].get("selected_portfolios", []))
        group += [c for c in prep.configs if not is_fusion(c) and (not wanted or c.get("name") in wanted)]
    sim = prep.simulation_index
    return result_cache.task_key({
        "kind": "history",
        "configs": [{k: v for k, v in c.items() if k not in _NOT_IDENTITY_CFG} for c in group],
        "options": {k: v for k, v in prep.options.to_dict().items() if k not in _NOT_IDENTITY},
        "start": str(sim[0]) if len(sim) else None,
        "display_start": str(prep.display_start),
        "ma_seed": ma_seed(prep, index),
        "session": result_cache.object_digest(prep.session),
        "data": sorted(tickers_for(prep, index)),
    })


def plan(portfolios: Any, options: Any) -> dict[str, Any]:
    """Simulation range and history keys of a request, without simulating (prices come from cache)."""
    prep = prepare(portfolios, options, RunContext(), download_lock=download_lock())
    sim = prep.simulation_index
    return {
        "simulation": {
            "start": date_key(sim[0]) if len(sim) else None,
            "end": date_key(sim[-1]) if len(sim) else None,
            "display_start": date_key(prep.display_start) if prep.display_start is not None else None,
        },
        "portfolios": [{"name": c["name"], "history_key": history_key(prep, i)} for i, c in enumerate(prep.configs)],
    }


def _write_reused(job_dir: Path, index: int, rec: dict[str, Any]) -> int:
    piece = rec["piece"]
    detail_gz: bytes = rec["detail_gz"]
    if rec.get("index") != index:
        piece = dict(piece, index=index)
        detail = json.loads(gzip.decompress(detail_gz))
        detail["index"] = index
        size = dump_gz(detail, job_dir / "portfolio" / f"{index}.json.gz")
    else:
        path = job_dir / "portfolio" / f"{index}.json.gz"
        tmp = path.with_name(path.name + ".part")
        tmp.write_bytes(detail_gz)
        tmp.replace(path)
        size = len(detail_gz)
    _dump({"piece": piece, "messages": rec.get("messages", []), "detail_bytes": size}, job_dir / "pieces" / f"{index}.pkl")
    return size


def task_portfolio(job_dir: Path, index: int) -> dict[str, Any]:
    t0 = time.perf_counter()
    entry = CACHE.get(job_dir)
    prep = entry.prep
    cfg = prep.configs[index]
    keys = tickers_for(prep, index)
    seed = ma_seed(prep, index)
    key = _reuse_key(entry, index, keys, seed) if result_cache.ENABLED and not entry.keep_raw else None
    hkey = history_key(prep, index)
    if key:
        rec = result_cache.load(key)
        if rec is not None:
            _write_reused(job_dir, index, dict(rec, piece=dict(rec["piece"], history_key=hkey)))
            return {"ok": bool(rec["piece"].get("ok")), "name": cfg["name"], "reused": True,
                    "seconds": round(time.perf_counter() - t0, 3)}
    raw, reindexed = entry.frames(keys)
    reindexed = isolate_frames(reindexed, seed)
    install_session(prep, raw)
    outcome = run_one(prep, index, reindexed, raw)
    s_extra, d_extra = analytics.portfolio_extras(prep, cfg, outcome, raw, reindexed)
    piece = portfolio_summary(cfg, outcome, entry.axis, s_extra)
    piece["history_key"] = hkey
    detail_path = job_dir / "portfolio" / f"{index}.json.gz"
    size = dump_gz(portfolio_detail(outcome, d_extra), detail_path)
    messages = outcome.get("messages", [])
    _dump({"piece": piece, "messages": messages, "detail_bytes": size}, job_dir / "pieces" / f"{index}.pkl")
    if key and outcome["success"]:
        result_cache.save(key, {"index": index, "piece": piece, "messages": messages, "detail_gz": detail_path.read_bytes()})
    if entry.keep_raw:
        (job_dir / "raw").mkdir(exist_ok=True)
        _dump(outcome, job_dir / "raw" / f"{index}.pkl")
    return {"ok": bool(outcome["success"]), "name": outcome["name"], "seconds": round(time.perf_counter() - t0, 3)}


def task_assemble(job_dir: Path) -> dict[str, Any]:
    entry = CACHE.get(job_dir)
    prep = entry.prep
    pieces: list[dict] = []
    messages: list[str] = []
    detail_bytes = 0
    for i in prep.execution_order():
        path = job_dir / "pieces" / f"{i}.pkl"
        if not path.exists():
            continue
        rec = _load(path)
        pieces.append(rec["piece"])
        messages += rec.get("messages", [])
        detail_bytes += rec.get("detail_bytes", 0)
    bench_keys: list[str] = []
    for cfg in prep.configs:
        b = cfg.get("benchmark_ticker")
        if b and b not in bench_keys and b in entry.files and entry.files[b][0] == "file":
            bench_keys.append(b)
    raw, reindexed = entry.frames(bench_keys)
    benchmarks = {b: reindexed[b]["Close"] for b in bench_keys if isinstance(reindexed.get(b), pd.DataFrame)}
    market = analytics.market_data(prep, entry.axis, pieces)
    run_extra = analytics.run_extras(prep, pieces, entry.axis)
    run_extra["benchmark_returns"] = analytics.benchmark_returns(raw, bench_keys, entry.axis, prep.display_start)
    duration = time.time() - prep.started
    summary = build_summary(prep, entry.axis, pieces, messages, benchmarks, duration, market, run_extra)
    size = dump_gz(summary, job_dir / "summary.json.gz")
    CACHE.drop(job_dir)
    return {
        "format": 2,
        "duration_s": round(duration, 3),
        "portfolios": sum(1 for p in pieces if p.get("ok")),
        "count": len(pieces),
        "failed": [p["name"] for p in pieces if not p.get("ok")],
        "warnings": summary["warnings"][:20],
        "simulation": summary["simulation"],
        "size_bytes": size + detail_bytes,
        "summary_bytes": size,
    }


# local runs (CLI, tests) --------------------------------------------------------

def _worker_init(home: str, hook: str | None, hook_args: tuple) -> None:
    os.environ["ENGINE_HOME"] = home
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
    from . import activate_engine_home

    activate_engine_home()
    if hook:
        mod, fn = hook.split(":")
        getattr(__import__(mod, fromlist=[fn]), fn)(*hook_args)


def run_local(portfolios: Any, options: Any, job_dir: Path | None = None, workers: int = 1,
              progress: Callable[[float, str], None] | None = None, keep_raw: bool = False,
              worker_hook: str | None = None, worker_hook_args: tuple = ()) -> tuple[Path, dict]:
    """Prepare in this process, then run portfolio tasks inline or in a local process pool."""
    job_dir = Path(job_dir or tempfile.mkdtemp(prefix="bt-"))

    def prep_progress(f: float, m: str) -> None:
        if progress:
            progress(0.3 * f, m)

    info = task_prepare(job_dir, portfolios, options, prep_progress, keep_raw)
    order = info["order"]
    total = max(1, len(order))
    done = 0

    def step(res: dict) -> None:
        nonlocal done
        done += 1
        if progress:
            progress(0.3 + 0.65 * done / total, f"Backtested {res['name']} ({done}/{total})")

    if workers <= 1 or len(order) <= 1:
        for i in order:
            step(task_portfolio(job_dir, i))
    else:
        import multiprocessing as mp
        from concurrent.futures import ProcessPoolExecutor, as_completed

        with ProcessPoolExecutor(max_workers=min(workers, len(order)), mp_context=mp.get_context("spawn"),
                                 initializer=_worker_init,
                                 initargs=(str(engine_home()), worker_hook, worker_hook_args)) as ex:
            for fut in as_completed([ex.submit(task_portfolio, job_dir, i) for i in order]):
                step(fut.result())
    if progress:
        progress(0.97, "Assembling results...")
    result = task_assemble(job_dir)
    if progress:
        progress(1.0, "Backtest complete")
    return job_dir, result


def load_bundle(job_dir: Path) -> dict[str, Any]:
    """Single-file form (CLI / GitHub Actions): {format, summary, details[]}."""
    summary = load_gz(job_dir / "summary.json.gz")
    details = []
    for p in summary["portfolios"]:
        path = job_dir / "portfolio" / f"{p['index']}.json.gz"
        details.append(load_gz(path) if path.exists() else None)
    return {"format": 2, "summary": summary, "details": details}


def load_run(job_dir: Path) -> BacktestRun:
    """Rebuild a BacktestRun from raw outcomes (runs made with keep_raw=True)."""
    prep: PreparedRun = _load(job_dir / "meta.pkl")["prep"]
    outcomes = [_load(p) for p in sorted((job_dir / "raw").glob("*.pkl"))]
    return assemble(prep, outcomes, raw_data={})
