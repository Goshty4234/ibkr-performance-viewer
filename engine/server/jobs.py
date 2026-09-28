"""Job scheduler over a persistent pool of worker processes.

A job is a chain of tasks (see backtest_engine.pipeline): one `prepare`,
one `portfolio` task per portfolio, one `assemble`. Up to ENGINE_MAX_JOBS jobs
progress at once and their tasks are interleaved round-robin on the shared
pool, so a small backtest never waits behind a huge one and every idle core
works on something. Workers prefer tasks of the job they already have cached.
"""

from __future__ import annotations

import json
import multiprocessing as mp
import queue as queue_mod
import shutil
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .settings import Settings
from .worker import worker_main

FINISHED = ("done", "error", "cancelled")


@dataclass
class Worker:
    process: Any
    conn: Any
    ready: bool = False
    task: tuple | None = None  # (job_id, kind, index)
    last_job: str | None = None
    idle_since: float = field(default_factory=time.time)
    dead_seen: bool = False
    used: bool = False

    @property
    def pid(self) -> int:
        return self.process.pid


@dataclass
class Job:
    id: str
    user: str
    label: str
    portfolio_count: int
    dir: Path
    status: str = "queued"
    phase: str = "queued"  # queued | prepare | portfolios | assemble | finished
    progress: float = 0.0
    message: str = "Queued"
    error: str | None = None
    summary: dict | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    dispatched_single: bool = False
    pending: deque = field(default_factory=deque)
    running: set = field(default_factory=set)
    total: int = 0
    done: int = 0
    failed: int = 0

    def next_task(self) -> tuple[str, int] | None:
        if self.status != "running":
            return None
        if self.phase in ("prepare", "assemble"):
            if self.dispatched_single:
                return None
            self.dispatched_single = True
            return (self.phase, -1)
        if self.phase == "portfolios" and self.pending:
            i = self.pending.popleft()
            self.running.add(i)
            return ("portfolio", i)
        return None

    def public(self, queue_position: int | None = None) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "status": self.status,
            "phase": self.phase,
            "progress": round(self.progress, 4),
            "message": self.message,
            "error": self.error,
            "summary": self.summary,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "queue_position": queue_position,
            "portfolio_count": self.portfolio_count,
            "tasks_total": self.total,
            "tasks_done": self.done,
            "tasks_running": len(self.running),
        }


class JobManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.ctx = mp.get_context("spawn")
        self.events = self.ctx.Queue()
        self.jobs: dict[str, Job] = {}
        self.waiting: deque[str] = deque()
        self.active: deque[str] = deque()
        self.workers: dict[int, Worker] = {}
        self.reaping: list[Worker] = []
        self._last_stats: dict = {}
        self.lock = threading.RLock()
        self.stopping = threading.Event()
        self.threads: list[threading.Thread] = []

    # lifecycle -----------------------------------------------------------
    def start(self) -> None:
        jobs_dir = self.settings.jobs_dir
        jobs_dir.mkdir(parents=True, exist_ok=True)
        for f in jobs_dir.iterdir():
            if f.is_dir():
                shutil.rmtree(f, ignore_errors=True)
            else:
                f.unlink(missing_ok=True)
        for target in (self._event_loop, self._watchdog):
            t = threading.Thread(target=target, daemon=True)
            t.start()
            self.threads.append(t)
        with self.lock:
            self._spawn()

    def shutdown(self) -> None:
        self.stopping.set()
        with self.lock:
            for w in list(self.workers.values()):
                if w.process.is_alive():
                    w.process.terminate()
            self.workers.clear()

    # public API ----------------------------------------------------------
    def submit(self, user: str, portfolios: Any, options: dict, label: str) -> Job:
        with self.lock:
            active = sum(1 for j in self.jobs.values() if j.user == user and j.status not in FINISHED)
            if active >= self.settings.max_queue:
                raise OverflowError(f"Too many active jobs ({active}); wait for some to finish.")
            job_id = uuid.uuid4().hex
            job_dir = self.settings.jobs_dir / job_id
            job_dir.mkdir(parents=True, exist_ok=True)
            (job_dir / "request.json").write_text(json.dumps({"portfolios": portfolios, "options": options}),
                                                  encoding="utf-8")
            job = Job(id=job_id, user=user, label=label, dir=job_dir,
                      portfolio_count=len(portfolios) if isinstance(portfolios, list) else 1)
            self.jobs[job.id] = job
            self.waiting.append(job.id)
            self._schedule()
            return job

    def get(self, job_id: str, user: str) -> Job | None:
        job = self.jobs.get(job_id)
        return job if job and job.user == user else None

    def list(self, user: str) -> list[dict]:
        with self.lock:
            return [self.describe(j) for j in sorted(self.jobs.values(), key=lambda j: -j.created_at) if j.user == user]

    def describe(self, job: Job) -> dict:
        pos = None
        if job.status == "queued":
            try:
                pos = list(self.waiting).index(job.id) + 1
            except ValueError:
                pos = None
        return job.public(pos)

    def cancel(self, job_id: str, user: str) -> Job | None:
        with self.lock:
            job = self.get(job_id, user)
            if not job or job.status in FINISHED:
                return job
            self._finish(job, "cancelled", message="Cancelled")
            return job

    def stats(self) -> dict:
        """Health must answer even if the scheduler is momentarily busy."""
        if not self.lock.acquire(timeout=0.5):
            return {**self._last_stats, "stale": True}
        try:
            self._last_stats = {
                "running": len(self.active),
                "queued": len(self.waiting),
                "max_jobs": self.settings.max_jobs,
                "workers": len(self.workers),
                "workers_busy": sum(1 for w in self.workers.values() if w.task),
                "max_workers": self.settings.workers,
                "tasks_queued": sum(len(self.jobs[j].pending) for j in self.active if j in self.jobs),
            }
            return self._last_stats
        finally:
            self.lock.release()

    # internals -----------------------------------------------------------
    def _spawn(self) -> Worker | None:
        if self.stopping.is_set() or len(self.workers) >= self.settings.workers:
            return None
        parent, child = self.ctx.Pipe()
        p = self.ctx.Process(target=worker_main, args=(child, self.events, str(self.settings.home)), daemon=True)
        p.start()
        w = Worker(process=p, conn=parent)
        self.workers[p.pid] = w
        return w

    def _kill(self, w: Worker) -> None:
        # Never block or start threads here: this runs under the manager lock.
        self.workers.pop(w.pid, None)
        if w.process.is_alive():
            w.process.terminate()
        self.reaping.append(w)

    def _admit(self) -> None:
        while self.waiting and len(self.active) < self.settings.max_jobs:
            job = self.jobs[self.waiting.popleft()]
            job.status = "running"
            job.phase = "prepare"
            job.started_at = time.time()
            job.message = "Starting engine..."
            self.active.append(job.id)

    def _next_task_for(self, preferred_job: str | None) -> tuple[Job, tuple[str, int]] | None:
        if preferred_job and preferred_job in self.active:
            job = self.jobs[preferred_job]
            if job.phase == "portfolios" and job.pending:
                task = job.next_task()
                if task:
                    return job, task
        for _ in range(len(self.active)):
            job = self.jobs[self.active[0]]
            self.active.rotate(-1)
            task = job.next_task()
            if task:
                return job, task
        return None

    def _schedule(self) -> None:
        self._admit()
        while True:
            idle = [w for w in self.workers.values() if w.task is None and w.process.is_alive()]
            if not idle:
                if not any(self._has_task(self.jobs[j]) for j in self.active):
                    return
                w = self._spawn()
                if w is None:
                    return
                idle = [w]
            placed = False
            for w in sorted(idle, key=lambda w: (not w.ready, -w.idle_since)):
                picked = self._next_task_for(w.last_job)
                if picked is None:
                    return
                job, (kind, index) = picked
                try:
                    w.conn.send((kind, job.id, str(job.dir), index))
                except (BrokenPipeError, OSError):
                    self._requeue(job, kind, index)
                    self._kill(w)
                    continue
                w.task = (job.id, kind, index)
                w.last_job = job.id
                placed = True
            if not placed:
                return

    @staticmethod
    def _has_task(job: Job) -> bool:
        if job.status != "running":
            return False
        if job.phase in ("prepare", "assemble"):
            return not job.dispatched_single
        return job.phase == "portfolios" and bool(job.pending)

    def _requeue(self, job: Job, kind: str, index: int) -> None:
        if kind == "portfolio":
            job.running.discard(index)
            job.pending.appendleft(index)
        else:
            job.dispatched_single = False

    def _update_progress(self, job: Job) -> None:
        if job.phase == "portfolios":
            job.progress = 0.3 + 0.65 * (job.done / max(1, job.total))
            job.message = f"Backtesting portfolios {job.done}/{job.total}" + (
                f" ({len(job.running)} in parallel)" if len(job.running) > 1 else "")
        elif job.phase == "assemble":
            job.progress = 0.96
            job.message = "Assembling results..."

    def _finish(self, job: Job, status: str, message: str = "", error: str | None = None,
                summary: dict | None = None) -> None:
        job.status = status
        job.phase = "finished"
        job.finished_at = time.time()
        job.message = message or job.message
        job.error = error
        if summary is not None:
            job.summary = summary
        if status == "done":
            job.progress = 1.0
        job.pending.clear()
        try:
            self.active.remove(job.id)
        except ValueError:
            pass
        try:
            self.waiting.remove(job.id)
        except ValueError:
            pass
        for w in list(self.workers.values()):
            if w.task and w.task[0] == job.id:
                self._kill(w)
            elif w.last_job == job.id and w.task is None and status != "done":
                try:
                    w.conn.send(("forget", job.id, str(job.dir), -1))
                except (BrokenPipeError, OSError):
                    pass
        job.running.clear()
        if status != "done":
            shutil.rmtree(job.dir, ignore_errors=True)
        self._schedule()

    def _on_task_done(self, job: Job, kind: str, index: int, info: dict) -> None:
        if kind == "prepare":
            order = list(info.get("order", []))
            job.total = len(order)
            job.pending = deque(order)
            job.dispatched_single = False
            job.phase = "portfolios" if order else "assemble"
            (job.dir / "request.json").unlink(missing_ok=True)
        elif kind == "portfolio":
            job.running.discard(index)
            job.done += 1
            if not info.get("ok"):
                job.failed += 1
            if job.done >= job.total and not job.pending and not job.running:
                job.phase = "assemble"
                job.dispatched_single = False
        elif kind == "assemble":
            shutil.rmtree(job.dir / "data", ignore_errors=True)
            shutil.rmtree(job.dir / "pieces", ignore_errors=True)
            (job.dir / "meta.pkl").unlink(missing_ok=True)
            self._finish(job, "done", message="Backtest complete", summary=info)
            return
        self._update_progress(job)

    def _event_loop(self) -> None:
        while not self.stopping.is_set():
            try:
                kind, pid, data = self.events.get(timeout=1.0)
            except queue_mod.Empty:
                continue
            except (EOFError, OSError):
                break
            with self.lock:
                w = self.workers.get(pid)
                if kind == "ready":
                    if w:
                        w.ready = True
                    continue
                if kind == "progress":
                    job_id, frac, msg = data
                    job = self.jobs.get(job_id)
                    if job and job.status == "running" and job.phase == "prepare":
                        job.progress, job.message = 0.3 * float(frac), str(msg)
                    continue
                job_id, task_kind, index, payload = data
                if w is not None:
                    w.task = None
                    w.used = True
                    w.idle_since = time.time()
                job = self.jobs.get(job_id)
                if job and job.status == "running":
                    if kind == "task_done":
                        self._on_task_done(job, task_kind, index, payload)
                    elif kind == "task_error":
                        self._finish(job, "error", message="Failed", error=str(payload))
                self._schedule()

    def _watchdog(self) -> None:
        while not self.stopping.wait(2.0):
            now = time.time()
            with self.lock:
                for w in list(self.reaping):
                    if not w.process.is_alive():
                        self.reaping.remove(w)
                        try:
                            w.conn.close()
                        except OSError:
                            pass
                for w in list(self.workers.values()):
                    if w.process.is_alive():
                        continue
                    # A final message may still be in the queue: only act on the next tick.
                    if not w.dead_seen:
                        w.dead_seen = True
                        continue
                    self.workers.pop(w.pid, None)
                    if w.task:
                        job = self.jobs.get(w.task[0])
                        if job and job.status == "running":
                            self._finish(job, "error", message="Failed",
                                         error=f"Engine worker exited unexpectedly (code {w.process.exitcode}); "
                                               "out of memory?")
                idle = sorted((w for w in self.workers.values() if w.task is None), key=lambda w: w.idle_since)
                for w in idle:
                    if now - w.idle_since <= self.settings.worker_idle_s:
                        continue
                    # The last worker is swapped for a fresh one: pandas never returns its heap to the OS.
                    if len(self.workers) > 1 or w.used:
                        self.workers.pop(w.pid, None)
                        try:
                            w.conn.send(None)
                        except (BrokenPipeError, OSError):
                            w.process.terminate()
                expired = [j for j in self.jobs.values()
                           if j.status in FINISHED and j.finished_at and now - j.finished_at > self.settings.result_ttl_s]
                for j in expired:
                    shutil.rmtree(j.dir, ignore_errors=True)
                    self.jobs.pop(j.id, None)
                if not self.workers:
                    self._spawn()
                self._schedule()
