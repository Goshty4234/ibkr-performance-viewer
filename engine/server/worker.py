"""Persistent pool worker: runs pipeline tasks of any job, one at a time.

The engine is imported once at start-up; a small per-job cache of loaded
price frames survives between tasks, so consecutive portfolios of the same
job skip the snapshot loading. Cancelling a job terminates the workers busy
on it, which the manager replaces.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any


def worker_main(conn: Any, events: Any, home: str) -> None:
    os.environ["ENGINE_HOME"] = home
    sys.stdout = open(os.devnull, "w", encoding="utf-8")  # the legacy code prints a lot

    from backtest_engine import activate_engine_home
    from backtest_engine import pipeline as P
    from backtest_engine.context import BacktestCancelled, BacktestError

    activate_engine_home()
    pid = os.getpid()
    events.put(("ready", pid, None))
    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            return
        if msg is None:
            return
        kind, job_id, job_dir, index = msg
        job_path = Path(job_dir)
        last = {"t": 0.0, "msg": ""}

        def progress(fraction: float, message: str) -> None:
            now = time.monotonic()
            if fraction >= 1.0 or message != last["msg"] or now - last["t"] > 0.5:
                last["t"], last["msg"] = now, message
                events.put(("progress", pid, (job_id, fraction, message)))

        try:
            if kind == "prepare":
                req = json.loads((job_path / "request.json").read_text(encoding="utf-8"))
                info = P.task_prepare(job_path, req["portfolios"], req["options"], progress)
            elif kind == "portfolio":
                info = P.task_portfolio(job_path, index)
            elif kind == "assemble":
                info = P.task_assemble(job_path)
            elif kind == "forget":
                P.CACHE.drop(job_path)
                continue
            else:
                raise ValueError(f"unknown task {kind!r}")
            events.put(("task_done", pid, (job_id, kind, index, info)))
        except (BacktestError, BacktestCancelled) as exc:
            events.put(("task_error", pid, (job_id, kind, index, str(exc))))
        except Exception as exc:  # noqa: BLE001
            tb = traceback.format_exc(limit=8)
            events.put(("task_error", pid, (job_id, kind, index, f"{type(exc).__name__}: {exc}\n{tb}")))
