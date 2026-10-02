"""Monte Carlo orchestration: random universes, your portfolio configs, distributions of results.

Every simulation draws ONE random universe and runs ALL portfolios (and the baselines) on it,
so differences between configurations are measured on identical data. Simulations are cut into
chunks processed in parallel by worker processes; each simulation has its own random stream
(seed, index), so the result does not depend on the number of workers or on the chunk size.
"""

from __future__ import annotations

import multiprocessing as mp
import os
import time
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from typing import Any, Callable

import numpy as np

from .calendar import TDAYS, make_calendar
from .generate import BOOTSTRAP_DEFAULTS, SYNTHETIC_DEFAULTS, bootstrap_returns, rng_for, synthetic_returns
from .simulate import build_universe, fan_points, metrics, simulate
from .strategy import Strat, parse_strategy

FORMAT = 1
METRIC_KEYS = ["total_return", "cagr", "max_dd", "vol", "sharpe", "sortino", "calmar", "turnover", "avg_holdings", "cash_pct"]
PCTS = (5, 25, 50, 75, 95)
MEM_BUDGET_MB = 400
MAX_WORK = 4e9  # n_sims * n_assets * years * series

BASELINES = [
    ("Équipondéré rebalancé (mensuel)", "Monthly"),
    ("Équipondéré sans rebalancement", "Buy & Hold"),
]


class MonteCarloCancelled(Exception):
    pass


def default_options() -> dict[str, Any]:
    return {
        "n_sims": 200, "n_assets": 20, "years": 10.0, "seed": 12345,
        "generator": "synthetic", "synthetic": dict(SYNTHETIC_DEFAULTS), "bootstrap": dict(BOOTSTRAP_DEFAULTS),
        "cost_bps": 0.0, "risk_free": 0.02,
    }


def clean_options(raw: dict[str, Any] | None) -> dict[str, Any]:
    o = default_options()
    raw = raw or {}
    for k in ("n_sims", "n_assets", "seed"):
        if raw.get(k) is not None:
            o[k] = int(raw[k])
    for k in ("years", "cost_bps", "risk_free"):
        if raw.get(k) is not None:
            o[k] = float(raw[k])
    if raw.get("generator") in ("synthetic", "bootstrap"):
        o["generator"] = raw["generator"]
    o["synthetic"].update({k: float(v) for k, v in (raw.get("synthetic") or {}).items() if k in SYNTHETIC_DEFAULTS})
    b = raw.get("bootstrap") or {}
    if "block_days" in b:
        o["bootstrap"]["block_days"] = int(b["block_days"])
    if "demean" in b:
        o["bootstrap"]["demean"] = bool(b["demean"])
    o["n_sims"] = int(min(max(o["n_sims"], 1), 50_000))
    o["n_assets"] = int(min(max(o["n_assets"], 2), 1000))
    o["years"] = float(min(max(o["years"], 1.0), 50.0))
    o["cost_bps"] = float(min(max(o["cost_bps"], 0.0), 500.0))
    return o


# ------------------------------------------------------------------------------------------------
# worker side
# ------------------------------------------------------------------------------------------------

_PANEL: dict[str, Any] = {}


def _panel(path: str) -> tuple[np.ndarray, np.ndarray]:
    hit = _PANEL.get(path)
    if hit is None:
        hit = (np.load(path, mmap_mode="r"), np.load(path.replace(".npy", "_mean.npy")))
        _PANEL.clear()
        _PANEL[path] = hit
    return hit


def run_chunk(spec: dict[str, Any]) -> dict[str, Any]:
    """Simulates sims [sim0, sim0 + count) for every strategy. Pure function of its spec."""
    sim0, count, T, N = spec["sim0"], spec["count"], spec["T"], spec["N"]
    d, e0, strats = spec["d"], spec["e0"], spec["strats"]
    logret = np.empty((count, T, N))
    if spec["generator"] == "bootstrap":
        panel, col_mean = _panel(spec["panel_path"])
        for i in range(count):
            logret[i] = bootstrap_returns(rng_for(spec["seed"], sim0 + i), T, N, panel, col_mean, spec["bootstrap"])
    else:
        for i in range(count):
            logret[i] = synthetic_returns(rng_for(spec["seed"], sim0 + i), T, N, spec["synthetic"])
    u = build_universe(logret, d, e0, any(s.needs_vol for s in strats), any(s.needs_beta for s in strats))
    del logret
    Te = T - e0
    fan_idx = fan_points(Te)
    out = []
    for s in strats:
        r = simulate(s, u, spec["cost_bps"])
        m = metrics(r["E"], float(r["years"][0]), spec["risk_free"])
        m.update(turnover=r["turnover"], avg_holdings=r["avg_holdings"], cash_pct=r["cash_pct"])
        out.append({"metrics": m, "fan": r["E"][:, fan_idx].astype(np.float32)})
    return {"sim0": sim0, "series": out}


# ------------------------------------------------------------------------------------------------
# orchestration
# ------------------------------------------------------------------------------------------------

def _stats(a: np.ndarray) -> dict[str, float | int | None]:
    x = a[np.isfinite(a)]
    if x.size == 0:
        return {"n": 0, "mean": None, "sd": None, "min": None, "max": None, **{f"p{p}": None for p in PCTS}}
    q = np.percentile(x, PCTS)
    return {"n": int(x.size), "mean": float(x.mean()), "sd": float(x.std(ddof=1)) if x.size > 1 else 0.0,
            "min": float(x.min()), "max": float(x.max()), **{f"p{p}": float(v) for p, v in zip(PCTS, q)}}


def _round(a: np.ndarray, nd: int = 6) -> list[float | None]:
    return [None if not np.isfinite(v) else round(float(v), nd) for v in a]


def plan_chunks(S: int, T: int, N: int, strats: list[Strat], workers: int) -> list[tuple[int, int]]:
    mult = 3 + (2 if any(s.needs_vol for s in strats) else 0) + (3 if any(s.needs_beta for s in strats) else 0)
    per_sim = T * N * 8 * mult + 1
    size = max(1, int(MEM_BUDGET_MB * 1e6 // per_sim))
    size = min(size, max(1, int(np.ceil(S / max(1, workers * 3)))))
    return [(a, min(size, S - a)) for a in range(0, S, size)]


def run_montecarlo(
    portfolios: list[dict],
    options: dict[str, Any] | None = None,
    *,
    progress: Callable[[float, str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
    workers: int | None = None,
    panel_path: str | None = None,
) -> dict[str, Any]:
    from ..config import normalize_one

    t_start = time.perf_counter()
    o = clean_options(options)
    if not portfolios:
        raise ValueError("Aucun portfolio à simuler.")
    cfgs = [normalize_one(p) for p in portfolios]
    strats: list[Strat] = [parse_strategy(c, o["risk_free"]) for c in cfgs]
    if o["generator"] == "bootstrap" and not panel_path:
        raise ValueError("Rééchantillonnage de vrais rendements : aucune base de prix fournie.")
    base = [Strat(name=n, mode="equal", freq=f) for n, f in BASELINES]
    allstrats = strats + base
    S, N = o["n_sims"], o["n_assets"]
    if S * N * o["years"] * len(allstrats) > MAX_WORK:
        raise ValueError("Simulation trop grosse : réduis le nombre de simulations, d’actions ou d’années.")

    d, e0 = make_calendar(o["years"], max([s.max_days for s in strats] + [30]) + 10)
    T = len(d)
    Te = T - e0
    workers = max(1, int(workers or max(1, (os.cpu_count() or 2) - 1)))
    chunks = plan_chunks(S, T, N, allstrats, workers)
    specs = [{
        "sim0": a, "count": n, "T": T, "N": N, "d": d, "e0": e0, "strats": allstrats, "seed": o["seed"],
        "generator": o["generator"], "synthetic": o["synthetic"], "bootstrap": o["bootstrap"],
        "panel_path": panel_path, "cost_bps": o["cost_bps"], "risk_free": o["risk_free"],
    } for a, n in chunks]

    results: list[dict] = []
    done = 0

    def tick() -> None:
        if progress:
            progress(done / len(specs), f"Simulations {min(S, sum(r['series'][0]['fan'].shape[0] for r in results))}/{S}")
        if cancelled and cancelled():
            raise MonteCarloCancelled()

    if workers == 1 or len(specs) == 1:
        for sp in specs:
            tick()
            results.append(run_chunk(sp))
            done += 1
        tick()
    else:
        ctx = mp.get_context("spawn")
        pool = ProcessPoolExecutor(max_workers=min(workers, len(specs)), mp_context=ctx)
        try:
            pending = {pool.submit(run_chunk, sp) for sp in specs}
            while pending:
                fin, pending = wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)
                for f in fin:
                    results.append(f.result())
                    done += 1
                tick()
        except BaseException:
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        pool.shutdown(wait=True)

    results.sort(key=lambda r: r["sim0"])
    series_out: list[dict[str, Any]] = []
    dates_eval = d[e0:]
    fan_idx = fan_points(Te)
    arrays: list[dict[str, np.ndarray]] = []
    for k, st in enumerate(allstrats):
        met = {key: np.concatenate([r["series"][k]["metrics"][key] for r in results]) for key in METRIC_KEYS}
        fan = np.concatenate([r["series"][k]["fan"] for r in results], axis=0).astype(np.float64)
        arrays.append(met)
        band = {f"p{p}": _round(np.percentile(fan, p, axis=0), 5) for p in PCTS}
        series_out.append({
            "id": f"s{k}", "name": st.name, "kind": "portfolio" if k < len(strats) else "baseline",
            "warnings": st.warnings,
            "metrics": {key: _round(v) for key, v in met.items()},
            "summary": {key: _stats(v) for key, v in met.items()},
            "fan": band,
        })

    # paired comparison with the first baseline (same universes) and between portfolios
    b0 = arrays[len(strats)]
    for k in range(len(strats)):
        m = arrays[k]
        ok = np.isfinite(m["cagr"]) & np.isfinite(b0["cagr"])
        sh = np.isfinite(m["sharpe"]) & np.isfinite(b0["sharpe"])
        series_out[k]["probabilities"] = {
            "positive_cagr": float((m["cagr"] > 0).mean()),
            "lost_money": float((m["total_return"] < 0).mean()),
            "drawdown_over_50": float((m["max_dd"] < -0.5).mean()),
            "beats_baseline_cagr": float((m["cagr"][ok] > b0["cagr"][ok]).mean()) if ok.any() else None,
            "beats_baseline_sharpe": float((m["sharpe"][sh] > b0["sharpe"][sh]).mean()) if sh.any() else None,
            "smaller_drawdown_than_baseline": float((m["max_dd"][ok] > b0["max_dd"][ok]).mean()) if ok.any() else None,
        }
    P = len(strats)
    pair = [[None if i == j else float((arrays[i]["cagr"] > arrays[j]["cagr"]).mean()) for j in range(P)] for i in range(P)]

    elapsed = time.perf_counter() - t_start
    if progress:
        progress(1.0, "Terminé")
    return {
        "format": FORMAT,
        "options": {**o, "workers": workers, "chunks": len(specs)},
        "calendar": {"eval_days": int(Te), "start": str(dates_eval[0]), "end": str(dates_eval[-1]),
                     "fan_dates": [str(dates_eval[i]) for i in fan_idx], "tdays_per_year": TDAYS},
        "series": series_out,
        "pairwise_cagr": {"names": [s.name for s in strats], "matrix": pair},
        "elapsed_s": round(elapsed, 3),
        "universe_note": (
            "Univers : " + ("vrais rendements quotidiens rééchantillonnés par blocs." if o["generator"] == "bootstrap"
                            else "actions simulées (facteur de marché, queues épaisses, régimes de crise, chocs extrêmes).")
        ),
    }
