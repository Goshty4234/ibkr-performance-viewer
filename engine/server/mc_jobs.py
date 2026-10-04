"""Monte Carlo jobs (real stocks): one background thread per job; the draws fan out to a process
pool inside run_montecarlo. Results are kept in memory, gzip-compressed, for a few hours."""

from __future__ import annotations

import gzip
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .auth import is_guest
from .settings import Settings

FINISHED = ("done", "error", "cancelled")


@dataclass
class McJob:
    id: str
    user: str
    label: str
    status: str = "queued"
    progress: float = 0.0
    message: str = "En attente"
    error: str | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None
    result_gz: bytes | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


class McManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.jobs: dict[str, McJob] = {}
        self.lock = threading.Lock()
        self.slots = threading.Semaphore(1)  # one simulation at a time: it already uses every core
        self.ttl_s = getattr(settings, "result_ttl_s", 12 * 3600)

    def _sweep(self) -> None:
        now = time.time()
        for k in [k for k, j in self.jobs.items() if j.finished and now - j.finished > self.ttl_s]:
            self.jobs.pop(k, None)

    def submit(self, user: str, portfolios: list[dict], options: dict[str, Any], mc: dict[str, Any], label: str) -> McJob:
        with self.lock:
            self._sweep()
            active = [j for j in self.jobs.values() if j.user == user and j.status not in FINISHED]
            if len(active) >= (1 if is_guest(user) else 3):
                raise OverflowError("Trop de simulations Monte Carlo en cours : attends qu’une se termine.")
            job = McJob(id=uuid.uuid4().hex[:12], user=user, label=label)
            self.jobs[job.id] = job
        threading.Thread(target=self._run, args=(job, portfolios, options, mc), daemon=True, name=f"mc-{job.id}").start()
        return job

    def get(self, job_id: str, user: str) -> McJob | None:
        job = self.jobs.get(job_id)
        return job if job and job.user == user else None

    def cancel(self, job_id: str, user: str) -> McJob | None:
        job = self.get(job_id, user)
        if job and job.status not in FINISHED:
            job.cancel.set()
        return job

    def describe(self, j: McJob) -> dict:
        return {"id": j.id, "label": j.label, "status": j.status, "progress": round(j.progress, 4),
                "message": j.message, "error": j.error, "created": j.created, "finished": j.finished}

    def _run(self, job: McJob, portfolios: list[dict], options: dict[str, Any], mc: dict[str, Any]) -> None:
        from backtest_engine import engine_home
        from backtest_engine.context import BacktestError
        from backtest_engine.montecarlo import MonteCarloCancelled, run_montecarlo

        while not self.slots.acquire(timeout=0.5):
            if job.cancel.is_set():
                job.status, job.message, job.finished = "cancelled", "Annulé", time.time()
                return
        try:
            job.status, job.message = "running", "Préparation"

            def progress(p: float, msg: str) -> None:
                job.progress, job.message = p, msg

            root = engine_home() / "montecarlo"
            _clean_leftovers(root)
            res = run_montecarlo(portfolios, options, mc, job_dir=root / job.id, progress=progress,
                                 cancelled=job.cancel.is_set, workers=self.settings.workers)
            data = json.dumps(res, separators=(",", ":"), allow_nan=False).encode("utf-8")
            job.result_gz = gzip.compress(data, compresslevel=5)
            job.status, job.progress, job.message = "done", 1.0, "Terminé"
        except MonteCarloCancelled:
            job.status, job.message = "cancelled", "Annulé"
        except (ValueError, BacktestError) as exc:
            job.status, job.error, job.message = "error", str(exc), "Erreur"
        except Exception as exc:  # noqa: BLE001
            job.status, job.error, job.message = "error", f"{type(exc).__name__}: {exc}", "Erreur"
        finally:
            job.finished = time.time()
            self.slots.release()


def _clean_leftovers(root: Path) -> None:
    """Snapshots of simulations interrupted by an engine stop, and the return bases of the former
    synthetic Monte Carlo (*.npy): nothing reads them any more."""
    import shutil

    if not root.is_dir():
        return
    now = time.time()
    for p in root.iterdir():
        try:
            if p.is_dir() and now - p.stat().st_mtime > 6 * 3600:
                shutil.rmtree(p, ignore_errors=True)
            elif p.is_file() and p.suffix == ".npy":
                p.unlink()
        except OSError:
            pass
