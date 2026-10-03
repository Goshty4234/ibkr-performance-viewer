"""The user's local library: everything the site would otherwise keep online, stored in the data home.

    <home>/backtests/<user>/<run>/   summary.json.gz, portfolio/<i>.json.gz, allocations/<i>.json.gz, meta.json
    <home>/ibkr/<user>/              statements imported in the IBKR viewer (raw CSV files)
    <home>/configs/<user>.json       backup copy of the saved configurations

Plain files, no database: deleting a folder deletes exactly what it holds. The browser is the only
writer; the engine just stores bytes, lists them, measures them and cleans them. Nothing here is
interpreted, so a newer site can add file kinds without a new engine (apart from the name check).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Iterator

USER_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
RUN_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
RUN_FILE_RE = re.compile(r"^(summary\.json\.gz|meta\.json|portfolio/\d{1,4}\.json\.gz|allocations/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,79})$")
IBKR_FILE_RE = re.compile(r"^[^\\/:*?\"<>|\x00-\x1f]{1,180}$")
CONFIG_FILE = "configs.json"
MAX_FILE_BYTES = 400 * 1024 * 1024

DEFAULT_SETTINGS: dict[str, Any] = {"auto_clean_days": 30, "keep_pinned": True}

# Friendly names of the folders of the data home, for the usage report.
FOLDER_LABELS: dict[str, str] = {
    "backtests": "Mes backtests (résultats complets)",
    "ibkr": "IBKR viewer (relevés CSV)",
    "configs": "Copie de sauvegarde des configurations",
    ".streamlit": "Prix et fiches des tickers (cache)",
    "cache": "Résultats de portfolios déjà calculés (cache)",
    "jobs": "Backtests récents en cours/terminés (temporaire)",
    "montecarlo": "Bases de rendements pour le Monte Carlo",
    "Complete_Tickers": "Listes de tickers fournies avec le moteur",
    "config": "Réglages du moteur",
}


class LibraryError(ValueError):
    """Bad name or path: the caller asked for something outside the library."""


def _check(value: str, rx: re.Pattern[str], what: str) -> str:
    if not isinstance(value, str) or not rx.match(value) or value in (".", ".."):
        raise LibraryError(f"{what} invalide")
    return value


def dir_size(path: Path) -> tuple[int, int]:
    """(bytes, files) under path; a missing path or an unreadable file counts for nothing."""
    total = files = 0
    stack = [path]
    while stack:
        cur = stack.pop()
        try:
            with os.scandir(cur) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(Path(e.path))
                        elif e.is_file(follow_symlinks=False):
                            total += e.stat(follow_symlinks=False).st_size
                            files += 1
                    except OSError:
                        continue
        except OSError:
            continue
    return total, files


def _atomic_write(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".part-", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class Library:
    def __init__(self, home: Path) -> None:
        self.home = Path(home)
        self._lock = threading.Lock()

    # ---- paths --------------------------------------------------------------------------------
    def run_dir(self, user: str, run: str) -> Path:
        return self.home / "backtests" / _check(user, USER_RE, "utilisateur") / _check(run, RUN_RE, "run")

    def run_file(self, user: str, run: str, name: str) -> Path:
        _check(name, RUN_FILE_RE, "fichier")
        return self.run_dir(user, run) / name

    def ibkr_dir(self, user: str) -> Path:
        return self.home / "ibkr" / _check(user, USER_RE, "utilisateur")

    def ibkr_file(self, user: str, name: str) -> Path:
        _check(name, IBKR_FILE_RE, "fichier")
        if name.startswith(".") or name.endswith((" ", ".")):
            raise LibraryError("fichier invalide")
        return self.ibkr_dir(user) / name

    # ---- runs ---------------------------------------------------------------------------------
    def put_run_file(self, user: str, run: str, name: str, data: bytes) -> int:
        if len(data) > MAX_FILE_BYTES:
            raise LibraryError("fichier trop gros")
        _atomic_write(self.run_file(user, run, name), data)
        return len(data)

    def get_run_file(self, user: str, run: str, name: str) -> Path | None:
        p = self.run_file(user, run, name)
        return p if p.is_file() else None

    def delete_run(self, user: str, run: str) -> bool:
        d = self.run_dir(user, run)
        if not d.is_dir():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True

    def _meta(self, run_dir: Path) -> dict[str, Any] | None:
        try:
            m = json.loads((run_dir / "meta.json").read_text(encoding="utf-8"))
            return m if isinstance(m, dict) else None
        except (OSError, ValueError):
            return None

    def list_runs(self, user: str) -> list[dict[str, Any]]:
        base = self.home / "backtests" / _check(user, USER_RE, "utilisateur")
        out: list[dict[str, Any]] = []
        try:
            entries = sorted(base.iterdir())
        except OSError:
            return out
        for d in entries:
            if not d.is_dir() or not RUN_RE.match(d.name):
                continue
            size, n = dir_size(d)
            portfolios = sorted(int(p.name.split(".")[0]) for p in (d / "portfolio").glob("*.json.gz") if p.name.split(".")[0].isdigit())
            try:
                mtime = d.stat().st_mtime
            except OSError:
                mtime = 0.0
            out.append({
                "id": d.name,
                "bytes": size,
                "files": n,
                "summary": (d / "summary.json.gz").is_file(),
                "portfolios": portfolios,
                "mtime": mtime,
                "meta": self._meta(d),
            })
        return out

    # ---- IBKR ---------------------------------------------------------------------------------
    def put_ibkr(self, user: str, name: str, data: bytes) -> int:
        if len(data) > MAX_FILE_BYTES:
            raise LibraryError("fichier trop gros")
        _atomic_write(self.ibkr_file(user, name), data)
        return len(data)

    def list_ibkr(self, user: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        try:
            for p in sorted(self.ibkr_dir(user).iterdir()):
                if p.is_file() and not p.name.startswith(".part-"):
                    st = p.stat()
                    out.append({"name": p.name, "bytes": st.st_size, "mtime": st.st_mtime})
        except OSError:
            pass
        return out

    def delete_ibkr(self, user: str, name: str) -> bool:
        p = self.ibkr_file(user, name)
        if not p.is_file():
            return False
        p.unlink()
        return True

    # ---- configurations backup ----------------------------------------------------------------
    def put_configs(self, user: str, data: bytes) -> int:
        _check(user, USER_RE, "utilisateur")
        if len(data) > 64 * 1024 * 1024:
            raise LibraryError("fichier trop gros")
        _atomic_write(self.home / "configs" / f"{user}.json", data)
        return len(data)

    def get_configs(self, user: str) -> Path | None:
        p = self.home / "configs" / f"{_check(user, USER_RE, 'utilisateur')}.json"
        return p if p.is_file() else None

    # ---- settings -----------------------------------------------------------------------------
    @property
    def settings_path(self) -> Path:
        return self.home / "config" / "storage.json"

    def settings(self) -> dict[str, Any]:
        s = dict(DEFAULT_SETTINGS)
        try:
            raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                if isinstance(raw.get("auto_clean_days"), int) and 0 <= raw["auto_clean_days"] <= 3650:
                    s["auto_clean_days"] = raw["auto_clean_days"]
                if isinstance(raw.get("keep_pinned"), bool):
                    s["keep_pinned"] = raw["keep_pinned"]
        except (OSError, ValueError):
            pass
        return s

    def set_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        s = self.settings()
        days = patch.get("auto_clean_days")
        if isinstance(days, int) and not isinstance(days, bool):
            s["auto_clean_days"] = max(0, min(3650, days))
        if isinstance(patch.get("keep_pinned"), bool):
            s["keep_pinned"] = patch["keep_pinned"]
        _atomic_write(self.settings_path, json.dumps(s).encode("utf-8"))
        return s

    # ---- usage --------------------------------------------------------------------------------
    def usage(self) -> dict[str, Any]:
        folders: list[dict[str, Any]] = []
        total = 0
        try:
            tops = sorted(self.home.iterdir())
        except OSError:
            tops = []
        for p in tops:
            if not p.is_dir() or p.name in ("__pycache__",):
                continue
            size, n = dir_size(p)
            total += size
            folders.append({"name": p.name, "label": FOLDER_LABELS.get(p.name, p.name), "bytes": size, "files": n})
        folders.sort(key=lambda f: -f["bytes"])
        try:
            du = shutil.disk_usage(self.home)
            disk = {"free": du.free, "total": du.total}
        except OSError:
            disk = {"free": None, "total": None}
        return {"home": str(self.home), "total": total, "folders": folders, "disk": disk, "settings": self.settings()}

    # ---- cleaning -----------------------------------------------------------------------------
    def _iter_run_dirs(self, user: str | None) -> Iterator[tuple[str, Path]]:
        base = self.home / "backtests"
        try:
            users = [base / _check(user, USER_RE, "utilisateur")] if user else sorted(p for p in base.iterdir() if p.is_dir())
        except OSError:
            return
        for u in users:
            try:
                for d in sorted(u.iterdir()):
                    if d.is_dir() and RUN_RE.match(d.name):
                        yield u.name, d
            except OSError:
                continue

    def _run_age_s(self, d: Path, now: float) -> float:
        meta = self._meta(d) or {}
        created = meta.get("created_at")
        if isinstance(created, str):
            try:
                from datetime import datetime

                ts = datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
                return now - ts
            except ValueError:
                pass
        try:
            return now - d.stat().st_mtime
        except OSError:
            return 0.0

    def clean_runs(self, older_than_days: int | None, keep_pinned: bool = True, user: str | None = None, now: float | None = None) -> dict[str, int]:
        """Deletes runs older than the limit (None = every run). Pinned runs are kept unless asked."""
        now = time.time() if now is None else now
        removed = freed = 0
        for _u, d in self._iter_run_dirs(user):
            meta = self._meta(d) or {}
            if keep_pinned and meta.get("pinned") is True:
                continue
            if older_than_days is not None and self._run_age_s(d, now) < older_than_days * 86400:
                continue
            size, _ = dir_size(d)
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
            freed += size
        return {"removed": removed, "freed": freed}

    def clean_ibkr(self, user: str | None = None) -> dict[str, int]:
        base = self.home / "ibkr"
        removed = freed = 0
        try:
            targets = [self.ibkr_dir(user)] if user else [p for p in base.iterdir() if p.is_dir()]
        except OSError:
            return {"removed": 0, "freed": 0}
        for t in targets:
            size, n = dir_size(t)
            if n:
                shutil.rmtree(t, ignore_errors=True)
                removed += n
                freed += size
        return {"removed": removed, "freed": freed}

    def clean_cache(self, now: float | None = None, older_than_days: int | None = None) -> dict[str, int]:
        """Temporary folders only (computed-portfolio cache, finished job files)."""
        now = time.time() if now is None else now
        removed = freed = 0
        for name in ("cache", "jobs"):
            root = self.home / name
            if not root.is_dir():
                continue
            for p in sorted(root.rglob("*"), key=lambda q: len(q.parts), reverse=True):
                try:
                    if p.is_file() and (older_than_days is None or now - p.stat().st_mtime >= older_than_days * 86400):
                        freed += p.stat().st_size
                        p.unlink()
                        removed += 1
                    elif p.is_dir() and not any(p.iterdir()):
                        p.rmdir()
                except OSError:
                    continue
        return {"removed": removed, "freed": freed}

    def auto_clean(self, now: float | None = None) -> dict[str, int] | None:
        """The scheduled cleaning: runs older than the configured age; None when switched off."""
        s = self.settings()
        if s["auto_clean_days"] <= 0:
            return None
        with self._lock:
            return self.clean_runs(s["auto_clean_days"], keep_pinned=s["keep_pinned"], now=now)


def start_auto_clean(lib: Library, interval_s: float = 6 * 3600, first_delay_s: float = 30.0) -> threading.Event:
    """Background thread: cleans shortly after start, then every few hours. Set the event to stop."""
    stop = threading.Event()

    def loop() -> None:
        if stop.wait(first_delay_s):
            return
        while True:
            try:
                lib.auto_clean()
            except Exception:  # noqa: BLE001 - cleaning must never take the engine down
                pass
            if stop.wait(interval_s):
                return

    threading.Thread(target=loop, name="library-auto-clean", daemon=True).start()
    return stop
