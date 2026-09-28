"""Server configuration, entirely from environment variables.

The same image/code runs on the user's PC and on any cloud host; only these
variables change:

    ENGINE_MODE             local | cloud                    (default: local)
    ENGINE_AUTH             none | supabase                  (default: none locally, supabase in cloud)
    SUPABASE_URL            https://<project>.supabase.co    (required when ENGINE_AUTH=supabase)
    SUPABASE_ANON_KEY       public anon key                  (required when ENGINE_AUTH=supabase)
    ENGINE_ALLOW_GUESTS     1 to accept requests without a session (site guest mode), identified by IP (default: 0)
    ENGINE_GUEST_MAX_QUEUE  active jobs per guest IP         (default: 2)
    ENGINE_ALLOWED_ORIGINS  comma list of origins, or "*"
    ENGINE_ORIGIN_REGEX     regex of allowed origins         (default: localhost + *.vercel.app)
    ENGINE_WORKERS          pooled worker processes          (default: CPU count - 1 locally, CPU count in cloud; capped by free RAM and 12)
    ENGINE_MAX_JOBS         jobs progressing concurrently    (default: 4 locally, 2 in cloud)
    ENGINE_WORKER_IDLE_S    idle seconds before a worker exits (default: 600; one warm worker is kept)
    ENGINE_MAX_QUEUE        queued jobs per user             (default: 20)
    ENGINE_RESULT_TTL_H     hours results stay downloadable  (default: 12)
    ENGINE_HOME             folder with Complete_Tickers/ and the price cache
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from backtest_engine import engine_home

DEFAULT_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$|^https://[a-z0-9-]+\.vercel\.app$"


def _int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except ValueError:
        return default


def _available_ram_gb() -> float | None:
    try:
        if os.name == "nt":
            import ctypes

            class _Mem(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            m = _Mem()
            m.dwLength = ctypes.sizeof(_Mem)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return min(m.ullAvailPhys, m.ullAvailPageFile) / 2**30
        return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / 2**30
    except Exception:  # noqa: BLE001
        return None


def _default_workers(mode: str) -> int:
    """CPU-bound pool sized by cores, capped so each worker keeps ~0.6 GB of headroom."""
    cpus = os.cpu_count() or 2
    n = cpus if mode == "cloud" else max(1, cpus - 1)
    ram = _available_ram_gb()
    if ram is not None:
        n = min(n, max(1, int(ram / 0.6)))
    return max(1, min(n, 12))


@dataclass
class Settings:
    mode: str = "local"
    auth: str = "none"
    supabase_url: str = ""
    supabase_anon_key: str = ""
    allowed_origins: list[str] = field(default_factory=list)
    origin_regex: str = DEFAULT_ORIGIN_REGEX
    workers: int = 1
    max_jobs: int = 4
    worker_idle_s: int = 600
    max_queue: int = 20
    allow_guests: bool = False
    guest_max_queue: int = 2
    result_ttl_s: int = 12 * 3600
    home: Path = field(default_factory=engine_home)

    @property
    def jobs_dir(self) -> Path:
        return self.home / ".jobs"


def load_settings() -> Settings:
    mode = os.environ.get("ENGINE_MODE", "local").strip().lower()
    mode = mode if mode in ("local", "cloud") else "local"
    auth = os.environ.get("ENGINE_AUTH", "supabase" if mode == "cloud" else "none").strip().lower()
    origins = [o.strip() for o in os.environ.get("ENGINE_ALLOWED_ORIGINS", "").split(",") if o.strip()]
    s = Settings(
        mode=mode,
        auth=auth if auth in ("none", "supabase") else "none",
        supabase_url=os.environ.get("SUPABASE_URL", os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")).rstrip("/"),
        supabase_anon_key=os.environ.get("SUPABASE_ANON_KEY", os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")),
        allowed_origins=origins,
        origin_regex=os.environ.get("ENGINE_ORIGIN_REGEX", DEFAULT_ORIGIN_REGEX),
        workers=_int("ENGINE_WORKERS", _default_workers(mode)),
        max_jobs=_int("ENGINE_MAX_JOBS", 2 if mode == "cloud" else 4),
        worker_idle_s=_int("ENGINE_WORKER_IDLE_S", 600),
        max_queue=_int("ENGINE_MAX_QUEUE", 20),
        allow_guests=os.environ.get("ENGINE_ALLOW_GUESTS", "0").strip().lower() in ("1", "true", "yes"),
        guest_max_queue=_int("ENGINE_GUEST_MAX_QUEUE", 2),
        result_ttl_s=_int("ENGINE_RESULT_TTL_H", 12) * 3600,
    )
    if s.auth == "supabase" and not (s.supabase_url and s.supabase_anon_key):
        raise RuntimeError("ENGINE_AUTH=supabase requires SUPABASE_URL and SUPABASE_ANON_KEY")
    return s
