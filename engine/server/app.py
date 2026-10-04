"""FastAPI engine used by the web app, on the user's PC or on any cloud host.

    GET    /health               engine status (no auth; used for auto-detection)
    POST   /plan                 simulation range + per-portfolio history keys, no simulation
    POST   /jobs                 queue a backtest -> {id}
    GET    /jobs                 caller's jobs
    GET    /jobs/{id}            status / progress
    GET    /jobs/{id}/summary    gzip JSON summary (format 2)
    GET    /jobs/{id}/portfolio/{i}  gzip JSON detail chunk of portfolio i
    GET    /jobs/{id}/result     whole result bundle (summary + every chunk)
    DELETE /jobs/{id}            cancel (kills the workers busy on it)
    GET    /tickers/search?q=    Yahoo symbol search
    POST   /fundamentals/pe      {tickers} -> trailing PE per ticker
    GET    /universe/{name}      sp500 | us ticker lists
    GET    /prices?ticker=&job=  close history (from the job snapshot when possible)
    POST   /montecarlo           queue a Monte Carlo study (random draws of real stocks) -> {id}
    GET    /montecarlo/{id}      status / progress
    GET    /montecarlo/{id}/result  gzip JSON (curves of every draw, distributions, head-to-head)
    DELETE /montecarlo/{id}      cancel
    POST   /update/check         portable engine: look for a newer release, download it in the background
    POST   /update/apply         portable engine: switch to the downloaded release and restart
"""

from __future__ import annotations

import inspect
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

ENGINE_ROOT = Path(__file__).resolve().parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from fastapi import Depends, FastAPI, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import Response  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from backtest_engine import API_VERSION, __version__, activate_engine_home, updater  # noqa: E402
from backtest_engine.library import Library, start_auto_clean  # noqa: E402
from backtest_engine.certs import ensure_system_ca_bundle  # noqa: E402

from .auth import current_user, is_guest  # noqa: E402
from .jobs import JobManager  # noqa: E402
from .library_api import router as library_router  # noqa: E402
from .mc_jobs import McManager  # noqa: E402
from .settings import load_settings  # noqa: E402

settings = load_settings()
ensure_system_ca_bundle(ENGINE_ROOT / ".certs")
STARTED_AT = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The ticker stores (marketdata/...) and Complete_Tickers are opened through paths relative to the
    # data home. Until a request happened to switch the working directory (a search, a run), the first
    # read of the store used the folder the engine was started from: an empty store, "0 tickers".
    activate_engine_home()
    manager = JobManager(settings)
    manager.start()
    app.state.manager = manager
    app.state.mc = McManager(settings)
    # The local library (results, IBKR files, cleaning) belongs to a PC, not to a shared cloud host.
    app.state.library = Library(settings.home) if settings.mode == "local" else None
    stop_clean = start_auto_clean(app.state.library) if app.state.library else None
    try:
        yield
    finally:
        if stop_clean:
            stop_clean.set()
        manager.shutdown()


app = FastAPI(title="Momentum Backtest Engine", version=__version__, lifespan=lifespan)
app.state.settings = settings

_allow_all = "*" in settings.allowed_origins
_cors_kwargs: dict[str, Any] = {}
if "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters:
    _cors_kwargs["allow_private_network"] = True
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if _allow_all else settings.allowed_origins,
    allow_origin_regex=None if _allow_all else settings.origin_regex,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
    max_age=600,
    **_cors_kwargs,
)


class _PnaPreflight:
    """Private Network Access: Chrome asks before letting an https:// page reach
    http://127.0.0.1. Older Starlette versions lack allow_private_network, so the
    header is also added around CORSMiddleware."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_header(message: dict) -> None:
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"access-control-allow-private-network"]
                headers.append((b"access-control-allow-private-network", b"true"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_header)


app.add_middleware(_PnaPreflight)


class _OriginGuard:
    """CORS only hides responses: a foreign page could still fire simple requests (form posts)
    at an engine on 127.0.0.1. Browser requests from origins outside the allowed list are
    refused before reaching any endpoint; callers without an Origin header (scripts) pass."""

    def __init__(self, app: Any) -> None:
        import re

        self.app = app
        self.origins = set(settings.allowed_origins)
        self.regex = re.compile(settings.origin_regex) if settings.origin_regex else None

    def _allowed(self, origin: str) -> bool:
        return _allow_all or origin in self.origins or bool(self.regex and self.regex.fullmatch(origin))

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            origin = next((v.decode("latin-1") for k, v in scope.get("headers", []) if k == b"origin"), "")
            if origin and not self._allowed(origin):
                await Response("Origin not allowed", status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(_OriginGuard)


class JobRequest(BaseModel):
    portfolios: Any = Field(..., description="Portfolio list (Streamlit export format)")
    options: dict[str, Any] | None = None
    label: str | None = None


def _manager(request: Request) -> JobManager:
    return request.app.state.manager


@app.get("/health")
def health(request: Request) -> dict:
    from backtest_engine.result_cache import static_fingerprint

    portable = updater.root() is not None
    return {
        "status": "ok",
        "engine": "momentum-backtest",
        "version": updater.build_info().get("version", __version__) if portable else __version__,
        "api": API_VERSION,
        "code": static_fingerprint()[:16],
        "mode": settings.mode,
        "auth_required": settings.auth != "none",
        "cpu_count": os.cpu_count(),
        "uptime_s": round(time.time() - STARTED_AT, 1),
        "portable": portable,
        "library": settings.mode == "local",
        **({"update": updater.status()} if portable else {}),
        **_manager(request).stats(),
    }


@app.post("/update/check")
def update_check(user: str = Depends(current_user)) -> dict:
    """Looks for a newer published engine now and downloads it in the background."""
    if not updater.enabled():
        raise HTTPException(400, "Mise à jour automatique indisponible pour ce moteur.")
    return updater.check_async()


@app.post("/update/apply")
def update_apply(request: Request, user: str = Depends(current_user)) -> dict:
    """Switches to the downloaded version and restarts the engine (a few seconds)."""
    if not updater.enabled():
        raise HTTPException(400, "Mise à jour automatique indisponible pour ce moteur.")
    if updater.status().get("state") != "ready":
        raise HTTPException(409, "Aucune mise à jour prête.")
    stats = _manager(request).stats()
    if stats.get("running") or stats.get("queued"):
        raise HTTPException(409, "Des backtests sont en cours : réessaie quand ils sont terminés.")
    try:
        updater.apply()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Mise à jour impossible : {exc}") from exc
    threading.Timer(0.3, updater.request_restart).start()
    return {"restarting": True, **updater.status()}


app.include_router(library_router)

_plan_lock = threading.Lock()


@app.post("/plan")
def plan_request(body: JobRequest, user: str = Depends(current_user)) -> dict:
    """What a launch would simulate, so the app can find identical portfolios in the history first."""
    from backtest_engine.cli import split_request
    from backtest_engine.context import BacktestError
    from backtest_engine.pipeline import plan

    portfolios, options = split_request({"portfolios": body.portfolios, "options": body.options or {}})
    # prepare() drives the process-wide Streamlit session shim: one plan at a time.
    with _plan_lock:
        try:
            return plan(portfolios, options)
        except BacktestError as exc:
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(400, f"Invalid portfolio configuration: {exc}") from exc


@app.post("/jobs")
def create_job(body: JobRequest, request: Request, user: str = Depends(current_user)) -> dict:
    from backtest_engine.cli import split_request
    from backtest_engine.config import normalize_portfolio_configs
    from backtest_engine.context import BacktestError, RunOptions

    portfolios, options = split_request({"portfolios": body.portfolios, "options": body.options or {}})
    try:
        configs = normalize_portfolio_configs(portfolios)
        RunOptions.from_dict(options)
    except BacktestError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Invalid portfolio configuration: {exc}") from exc
    label = (body.label or ", ".join(c["name"] for c in configs[:3]) + ("..." if len(configs) > 3 else ""))[:200]
    manager = _manager(request)
    try:
        job = manager.submit(user, portfolios, options, label)
    except OverflowError as exc:
        raise HTTPException(429, str(exc)) from exc
    return manager.describe(job)


@app.get("/jobs")
def list_jobs(request: Request, user: str = Depends(current_user)) -> list[dict]:
    return _manager(request).list(user)


@app.get("/jobs/{job_id}")
def get_job(job_id: str, request: Request, user: str = Depends(current_user)) -> dict:
    manager = _manager(request)
    job = manager.get(job_id, user)
    if not job:
        raise HTTPException(404, "Unknown job")
    return manager.describe(job)


def _done_job(job_id: str, request: Request, user: str):
    job = _manager(request).get(job_id, user)
    if not job:
        raise HTTPException(404, "Unknown job")
    if job.status != "done":
        raise HTTPException(409, f"Result not available (status: {job.status})")
    return job


def _gz_file(path: Path) -> Response:
    if not path.exists():
        raise HTTPException(404, "Result part not found (expired?)")
    return Response(
        content=path.read_bytes(),
        media_type="application/json",
        headers={"Content-Encoding": "gzip", "Cache-Control": "private, max-age=86400, immutable"},
    )


@app.get("/jobs/{job_id}/summary")
def get_summary(job_id: str, request: Request, user: str = Depends(current_user)) -> Response:
    return _gz_file(_done_job(job_id, request, user).dir / "summary.json.gz")


@app.get("/jobs/{job_id}/portfolio/{index}")
def get_portfolio(job_id: str, index: int, request: Request, user: str = Depends(current_user)) -> Response:
    return _gz_file(_done_job(job_id, request, user).dir / "portfolio" / f"{int(index)}.json.gz")


@app.get("/jobs/{job_id}/result")
def get_result(job_id: str, request: Request, user: str = Depends(current_user)) -> Response:
    """Whole result in one file ({format, summary, details[]}), e.g. for archiving."""
    import gzip
    import json

    from backtest_engine.pipeline import load_bundle

    job = _done_job(job_id, request, user)
    data = json.dumps(load_bundle(job.dir), separators=(",", ":"), allow_nan=False).encode("utf-8")
    return Response(
        content=gzip.compress(data, compresslevel=5),
        media_type="application/json",
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"},
    )


@app.delete("/jobs/{job_id}")
def cancel_job(job_id: str, request: Request, user: str = Depends(current_user)) -> dict:
    manager = _manager(request)
    job = manager.cancel(job_id, user)
    if not job:
        raise HTTPException(404, "Unknown job")
    return manager.describe(job)


class McRequest(BaseModel):
    portfolios: Any = Field(..., description="Portfolio list (same format as /jobs)")
    options: dict[str, Any] | None = Field(None, description="Run options (same as /jobs)")
    mc: dict[str, Any] | None = Field(None, description="Draws: universe, n_draws, n_pick, seed, start_date, end_date")
    label: str | None = None


def _mc(request: Request) -> McManager:
    return request.app.state.mc


@app.post("/montecarlo")
def mc_create(body: McRequest, request: Request, user: str = Depends(current_user)) -> dict:
    from backtest_engine.config import normalize_portfolio_configs
    from backtest_engine.montecarlo import clean_options

    portfolios = body.portfolios if isinstance(body.portfolios, list) else []
    try:
        mc = clean_options(body.mc)
        configs = normalize_portfolio_configs(portfolios)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"Invalid portfolio configuration: {exc}") from exc
    label = (body.label or "Monte Carlo : " + ", ".join(c["name"] for c in configs[:3]))[:200]
    try:
        job = _mc(request).submit(user, portfolios, body.options or {}, mc, label)
    except OverflowError as exc:
        raise HTTPException(429, str(exc)) from exc
    return _mc(request).describe(job)


@app.get("/montecarlo/{job_id}")
def mc_get(job_id: str, request: Request, user: str = Depends(current_user)) -> dict:
    job = _mc(request).get(job_id, user)
    if not job:
        raise HTTPException(404, "Unknown simulation")
    return _mc(request).describe(job)


@app.get("/montecarlo/{job_id}/result")
def mc_result(job_id: str, request: Request, user: str = Depends(current_user)) -> Response:
    job = _mc(request).get(job_id, user)
    if not job:
        raise HTTPException(404, "Unknown simulation")
    if job.status != "done" or job.result_gz is None:
        raise HTTPException(409, f"Result not available (status: {job.status})")
    return Response(content=job.result_gz, media_type="application/json",
                    headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"})


@app.delete("/montecarlo/{job_id}")
def mc_cancel(job_id: str, request: Request, user: str = Depends(current_user)) -> dict:
    job = _mc(request).cancel(job_id, user)
    if not job:
        raise HTTPException(404, "Unknown simulation")
    return _mc(request).describe(job)


_search_cache: dict[str, tuple[float, list]] = {}


@app.get("/tickers/search")
def search_tickers(q: str, user: str = Depends(current_user)) -> dict:
    q = q.strip()[:40]
    if not q:
        return {"quotes": []}
    hit = _search_cache.get(q.upper())
    if hit and time.time() - hit[0] < 3600:
        return {"quotes": hit[1]}
    try:
        import yfinance as yf

        quotes = [
            {
                "symbol": r.get("symbol"),
                "name": r.get("shortname") or r.get("longname") or "",
                "exchange": r.get("exchDisp") or r.get("exchange") or "",
                "type": r.get("typeDisp") or r.get("quoteType") or "",
            }
            for r in (yf.Search(q, max_results=10, news_count=0).quotes or [])
            if r.get("symbol")
        ]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Ticker search failed: {exc}") from exc
    if len(_search_cache) > 2000:
        _search_cache.clear()
    _search_cache[q.upper()] = (time.time(), quotes)
    return {"quotes": quotes}


class TickersBody(BaseModel):
    tickers: list[str] = Field(default_factory=list, max_length=5000)


@app.post("/fundamentals/pe")
def fundamentals_pe(body: TickersBody, user: str = Depends(current_user)) -> dict:
    from backtest_engine.data_api import pe_ratios

    try:
        return {"pe": pe_ratios(body.tickers)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"PE lookup failed: {exc}") from exc


class FundamentalsBody(BaseModel):
    weights: dict[str, float] = Field(max_length=2000)
    portfolio_value: float = Field(gt=0)
    prices: dict[str, float | None] = Field(default_factory=dict, max_length=2000)


@app.post("/allocations/fundamentals")
def allocations_fundamentals(body: FundamentalsBody, user: str = Depends(current_user)) -> dict:
    from backtest_engine.allocations_api import fundamentals

    try:
        return fundamentals(body.weights, body.portfolio_value, body.prices)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Fundamentals lookup failed: {exc}") from exc


class SeriesBody(BaseModel):
    dates: list[str] = Field(max_length=100_000)
    values: list[float | None] = Field(max_length=100_000)


class BenchmarksBody(BaseModel):
    portfolio: SeriesBody | None = None
    benchmark_ticker: str | None = Field(default=None, max_length=40)
    portfolio_pe: float | None = None


@app.post("/allocations/benchmarks")
def allocations_benchmarks(body: BenchmarksBody, user: str = Depends(current_user)) -> dict:
    from backtest_engine.allocations_api import benchmarks

    try:
        rows = benchmarks(body.portfolio.model_dump() if body.portfolio else None, body.benchmark_ticker, body.portfolio_pe)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Benchmark comparison failed: {exc}") from exc
    return {"rows": rows}


class ReturnsBody(BaseModel):
    weights: dict[str, float] = Field(max_length=2000)
    metrics: dict[str, dict[str, float | None]] | None = Field(default=None, max_length=2000)
    benchmark_ticker: str | None = Field(default=None, max_length=40)
    portfolio: SeriesBody | None = None


@app.post("/allocations/returns")
def allocations_returns(body: ReturnsBody, user: str = Depends(current_user)) -> dict:
    from backtest_engine.allocations_api import returns_summary

    try:
        rows = returns_summary(body.weights, body.metrics, body.benchmark_ticker,
                               body.portfolio.model_dump() if body.portfolio else None)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Returns summary failed: {exc}") from exc
    return {"rows": rows}


@app.post("/tickers/resolve")
def tickers_resolve(body: TickersBody, user: str = Depends(current_user)) -> dict:
    from backtest_engine.data_api import resolve_tickers

    return {"resolved": resolve_tickers(body.tickers)}


@app.post("/cache/clear")
def cache_clear(request: Request, user: str = Depends(current_user)) -> dict:
    from backtest_engine.data_api import clear_caches

    if is_guest(user):
        raise HTTPException(403, "Mode invité : réservé aux comptes.")
    if _manager(request).stats().get("running"):
        raise HTTPException(409, "Des backtests sont en cours : réessaie quand ils sont terminés.")
    _search_cache.clear()
    return clear_caches()


@app.get("/universe/{name}")
def get_universe(name: str, user: str = Depends(current_user)) -> dict:
    from backtest_engine.data_api import universe

    if name not in ("sp500", "us"):
        raise HTTPException(404, "Unknown universe")
    try:
        return universe(name)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, str(exc)) from exc


class StoreBody(BaseModel):
    tickers: list[str] = Field(default_factory=list, max_length=20_000)
    mode: str = "topup"


@app.post("/store/status")
def store_status(body: StoreBody, user: str = Depends(current_user)) -> dict:
    from backtest_engine.data_api import store_status as status

    return status(body.tickers)


@app.get("/store/tickers")
def store_tickers(user: str = Depends(current_user)) -> list[dict]:
    from backtest_engine.data_api import store_list

    return store_list()


@app.post("/store/update")
def store_update(body: StoreBody, user: str = Depends(current_user)) -> dict:
    from backtest_engine.data_api import store_update as update

    if is_guest(user):
        raise HTTPException(403, "Mode invité : réservé aux comptes.")
    if len(body.tickers) > 500:
        raise HTTPException(400, "Au plus 500 tickers par mise à jour (un backtest met à jour les autres).")
    if body.mode not in ("topup", "full"):
        raise HTTPException(400, "mode: topup ou full")
    try:
        return update(body.tickers, body.mode)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Update failed: {exc}") from exc


@app.get("/prices")
def get_prices(ticker: str, request: Request, job: str | None = None, mode: str = "stored", bars: bool = False,
               user: str = Depends(current_user)) -> Response:
    import gzip
    import json

    from backtest_engine.data_api import price_history

    job_dir = None
    if job:
        j = _manager(request).get(job, user)
        job_dir = j.dir if j else None
    try:
        data = price_history(ticker[:40], job_dir, mode if mode in ("stored", "topup", "full") else "stored", bars)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Price lookup failed: {exc}") from exc
    return Response(
        content=gzip.compress(json.dumps(data, separators=(",", ":")).encode("utf-8"), compresslevel=5),
        media_type="application/json",
        # A job snapshot never changes; the ticker store does (top-up, re-download).
        headers={"Content-Encoding": "gzip", "Cache-Control": "private, max-age=3600" if data["source"] == "job" else "no-store"},
    )


@app.get("/store/quote")
def store_quote(ticker: str, refresh: bool = False, user: str = Depends(current_user)) -> dict:
    from backtest_engine.data_api import quote_info

    if refresh and is_guest(user):
        raise HTTPException(403, "Mode invité : réservé aux comptes.")
    try:
        return quote_info(ticker[:40], refresh)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Quote lookup failed: {exc}") from exc
