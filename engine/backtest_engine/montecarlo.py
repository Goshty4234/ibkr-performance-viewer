"""Monte Carlo on real stocks.

The universe is a list of real tickers (S&P 500, US-listed stocks, the tickers of the portfolios or
any list). Each draw takes N of them at random; every portfolio then runs on exactly those N
stocks, through the normal backtest engine, as if the user had typed them in Construire. The next
draw takes another N. Comparing two portfolios draw by draw (same stocks, same dates) shows whether
an option really helps or only won on one particular set of stocks.

A draw is a normal run: same portfolio settings (momentum, filters, S&P 500 entry date, minimum
market cap, MA filter...), same run options, same statistics. Only the stocks change, and they
join the portfolio when their history starts ("start with oldest"), since random stocks rarely
share an IPO date. An equal-weight portfolio of the drawn stocks (monthly rebalance) is added as
a reference.

Execution: the universe prices are loaded once (prices from the ticker store, one pickle per
ticker in a temporary snapshot); draws run in parallel worker processes, each draw reading only
the frames it needs. Draws are generated from the seed up front, so the result does not depend on
the number of workers.
"""

from __future__ import annotations

import contextlib
import copy
import dataclasses
import io
import math
import multiprocessing as mp
import os
import re
import shutil
import sys
import time
from collections import OrderedDict
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd

FORMAT = 4
BASELINE_NAME = "Équipondéré des actions tirées (mensuel)"
PCTS = (5, 25, 50, 75, 95)
# Statistics kept per draw (Construire's "values", in its units: percent for returns and drawdowns).
STAT_KEYS = ("CAGR", "Total Return", "MaxDrawdown", "Volatility", "Sharpe", "Sortino", "UlcerIndex", "UPI", "Beta", "MWRR",
             "Final Value (with)", "Final Value (no_additions)")
EXTRA_KEYS = ("holdings", "cash")
MIN_HISTORY_DAYS = 365
STALE_DAYS = 10
MAX_DRAWS = 2000
MAX_PICK = 500


class MonteCarloCancelled(Exception):
    pass


# ------------------------------------------------------------------------------------------------
# options and universe
# ------------------------------------------------------------------------------------------------

def default_options() -> dict[str, Any]:
    return {"n_draws": 50, "n_pick": 30, "seed": 12345, "universe": {"source": "sp500", "tickers": []},
            "start_date": None, "end_date": None, "baseline": True, "points": 400,
            "filters": {"sp500_entry": False, "min_cap": False, "min_cap_billions": 10.0}}


def _date(v: Any) -> str | None:
    if not v:
        return None
    try:
        return pd.Timestamp(str(v)).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def clean_options(raw: dict[str, Any] | None) -> dict[str, Any]:
    o = default_options()
    raw = raw or {}
    for k in ("n_draws", "n_pick", "seed", "points"):
        if raw.get(k) is not None:
            o[k] = int(raw[k])
    o["n_draws"] = min(max(o["n_draws"], 1), MAX_DRAWS)
    o["n_pick"] = min(max(o["n_pick"], 1), MAX_PICK)
    o["points"] = min(max(o["points"], 50), 2000)
    o["start_date"] = _date(raw.get("start_date"))
    o["end_date"] = _date(raw.get("end_date"))
    if raw.get("baseline") is not None:
        o["baseline"] = bool(raw["baseline"])
    f = raw.get("filters") if isinstance(raw.get("filters"), dict) else {}
    try:
        cap = float(f.get("min_cap_billions", 10.0))
    except (TypeError, ValueError):
        cap = 10.0
    o["filters"] = {"sp500_entry": bool(f.get("sp500_entry")), "min_cap": bool(f.get("min_cap")),
                    "min_cap_billions": min(max(cap, 0.0), 10_000.0)}
    u = raw.get("universe") or {}
    src = u.get("source") if u.get("source") in ("sp500", "us", "portfolios", "list") else "sp500"
    tickers = [str(t).strip().upper() for t in (u.get("tickers") or []) if str(t).strip()]
    o["universe"] = {"source": src, "tickers": list(dict.fromkeys(tickers))[:20_000]}
    if o["start_date"] and o["end_date"] and o["start_date"] >= o["end_date"]:
        raise ValueError("La date de début doit précéder la date de fin.")
    return o


def resolve_universe(o: dict[str, Any], portfolios: list[dict]) -> tuple[list[str], str]:
    src = o["universe"]["source"]
    if src in ("sp500", "us"):
        from .data_api import universe

        tickers = universe(src)["tickers"]
        label = "S&P 500 (composition actuelle)" if src == "sp500" else "Actions cotées aux États-Unis"
    elif src == "portfolios":
        tickers = []
        for p in portfolios:
            for s in p.get("stocks") or []:
                t = str(s.get("ticker") or "").strip()
                if t and t.upper() != "CASH":
                    tickers.append(t)
        label = "Tickers des portfolios"
    else:
        tickers = list(o["universe"]["tickers"])
        label = "Liste personnalisée"
    tickers = [t for t in dict.fromkeys(tickers) if t]
    if not tickers:
        raise ValueError("L’univers est vide : choisis le S&P 500, une liste de tickers ou des portfolios avec des actions.")
    return tickers, label


def draw_lists(universe: list[str], n_draws: int, n_pick: int, seed: int) -> list[list[str]]:
    """n_draws sets of n_pick distinct tickers; a ticker can appear in several draws."""
    rng = np.random.default_rng(seed)
    n = len(universe)
    return [[universe[i] for i in sorted(rng.choice(n, size=n_pick, replace=False).tolist())] for _ in range(n_draws)]


def _stock(t: str, n: int, template: dict[str, dict]) -> dict:
    src = template.get(t) or {}
    out = {"ticker": t, "allocation": 1.0 / n, "include_dividends": src.get("include_dividends", True)}
    for k in ("include_in_sma_filter", "ma_reference_ticker", "max_allocation_percent"):
        if k in src:
            out[k] = src[k]
    out.setdefault("include_in_sma_filter", True)
    return out


def with_stocks(cfg: dict, tickers: list[str]) -> dict:
    """Shallow copy of a normalized config holding `tickers` (equal allocations for non-momentum
    portfolios). Per-ticker settings typed in the portfolio are kept for the tickers it listed."""
    template = {s.get("ticker"): s for s in cfg.get("stocks") or [] if isinstance(s, dict)}
    out = dict(cfg)
    out["stocks"] = [_stock(t, len(tickers), template) for t in tickers]
    return out


# ------------------------------------------------------------------------------------------------
# which portfolios make sense in a Monte Carlo
# ------------------------------------------------------------------------------------------------
# A draw replaces the stocks of every portfolio by N stocks picked at random. That only means
# something when the portfolio is a *rule* applied to whatever stocks it is given (momentum), or a
# plain equal-weight basket (every stock the same weight: any N stocks do the same job). A portfolio
# whose weights ARE the strategy (60/40, one ticker, fixed unequal weights) would silently become
# something else, so it is left out and the reason is shown.

def classify(cfg: dict, n_pick: int) -> dict[str, Any]:
    """Verdict for one normalized portfolio: included (momentum / equal weight) or excluded, with the reason."""
    from . import runner as R

    out: dict[str, Any] = {"name": cfg.get("name"), "status": "excluded", "kind": None, "reason": None, "notes": []}

    def no(kind: str, why: str) -> dict[str, Any]:
        out.update(status="excluded", kind=kind, reason=why)
        return out

    if R.is_fusion(cfg):
        return no("fusion", "Portfolio fusionné : il combine d’autres portfolios au lieu de détenir des actions, "
                            "il n’y a rien à remplacer par un tirage.")
    if cfg.get("use_targeted_rebalancing"):
        return no("targeted", "Rééquilibrage ciblé : ses seuils sont liés à tes tickers précis et ne s’appliqueraient "
                              "à aucune des actions tirées (il ne rééquilibrerait jamais).")

    tickers = [str(s.get("ticker") or "").strip() for s in cfg.get("stocks") or [] if isinstance(s, dict)]
    real = [s for s in cfg.get("stocks") or [] if isinstance(s, dict) and str(s.get("ticker") or "").strip()
            and str(s.get("ticker")).strip().upper() != "CASH"]
    notes: list[str] = out["notes"]

    distinct = {str(s.get("ticker")).strip().upper() for s in real}
    if cfg.get("use_momentum"):
        if len(distinct) == 1:
            return no("single", f"Momentum sur un seul titre ({next(iter(distinct))}) : il n’y a rien à classer, ce n’est "
                                "pas une stratégie de sélection, et un tirage le remplacerait par un autre panier.")
        out.update(status="included", kind="momentum")
        top = cfg.get("limit_to_top_n_tickers") if cfg.get("use_limit_to_top_n") else None
        if isinstance(top, (int, float)) and top >= n_pick:
            notes.append(f"Limite « top {int(top)} » ≥ {n_pick} actions par tirage : elle ne filtre rien ici.")
        eq = cfg.get("equal_weight_n_tickers") if cfg.get("use_equal_weight") else None
        if isinstance(eq, (int, float)) and eq >= n_pick:
            notes.append(f"Équipondération sur {int(eq)} titres ≥ {n_pick} actions par tirage : tout le panier est détenu.")
        cap = cfg.get("max_allocation_percent") if cfg.get("use_max_allocation") else None
        if isinstance(cap, (int, float)) and cap > 0 and cap * n_pick < 100:
            notes.append(f"Plafond de {cap:g} % par titre avec seulement {n_pick} actions : une partie reste en cash.")
        return out

    # static allocations: only an equal-weight basket survives
    if any(t.upper() == "CASH" for t in tickers):
        return no("static", "Allocation fixe avec une part de CASH : cette part n’a pas d’équivalent dans un panier tiré au hasard.")
    if len(distinct) < 2:
        what = f" ({real[0]['ticker']})" if real else ""
        return no("single", f"Un seul titre{what} sans momentum : un tirage le remplacerait par un panier de {n_pick} actions, "
                            "ce ne serait plus ton portfolio.")
    allocs = []
    for s in real:
        try:
            allocs.append(float(s.get("allocation") or 0.0))
        except (TypeError, ValueError):
            allocs.append(0.0)
    top_a = max(allocs)
    if top_a <= 0:
        return no("static", "Aucune pondération renseignée.")
    if max(allocs) - min(allocs) > 1e-3 * top_a:
        return no("static", "Pondérations fixes inégales (ex. 60/40) : ce sont elles, la stratégie. Remplacer les titres par des "
                            "actions tirées au hasard ne les représenterait plus.")
    out.update(status="included", kind="equal_weight")
    notes.append(f"Pondérations égales ({len(real)} titres) : traité comme un panier équipondéré, chaque tirage met "
                 f"1/{n_pick} (≈ {100 / n_pick:.1f} %) sur chacune des {n_pick} actions tirées.")
    if cfg.get("rebalancing_frequency") in ("Never", "Buy & Hold", "Buy & Hold (Target)"):
        notes.append("Sans rééquilibrage : équipondéré au départ seulement, les poids dérivent ensuite.")
    return out


def none_eligible(verdicts: list[dict[str, Any]]) -> str:
    why = " ".join(f"« {v['name']} » : {v['reason']}" for v in verdicts)
    return ("Aucun des portfolios choisis n’a de sens en Monte Carlo (il faut du momentum ou une pondération égale "
            f"entre les titres). {why}")


def check_portfolios(portfolios: list[dict], mc_options: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Verdicts of the portfolios as the Monte Carlo would see them (used by the site before launching)."""
    from .config import normalize_portfolio_configs

    o = clean_options(mc_options)
    raw = [p for p in portfolios if isinstance(p, dict)]
    if not raw:
        return []
    return [classify(c, o["n_pick"]) for c in normalize_portfolio_configs(copy.deepcopy(raw))]


def baseline_config(first: dict) -> dict:
    return {
        "name": BASELINE_NAME,
        "stocks": [],
        "benchmark_ticker": first.get("benchmark_ticker") or "^GSPC",
        "initial_value": 10000,
        "added_amount": 0,
        "added_frequency": "Never",
        "rebalancing_frequency": "Monthly",
        "use_momentum": False,
    }


# ------------------------------------------------------------------------------------------------
# preparation (job thread): prices of the whole universe, simulation window, snapshot
# ------------------------------------------------------------------------------------------------

def prepare(job_dir: Path, portfolios: list[dict], run_options: dict[str, Any], o: dict[str, Any],
            progress: Callable[[float, str], None] | None = None,
            cancelled: Callable[[], bool] | None = None) -> dict[str, Any]:
    from . import activate_engine_home
    from . import runner as R
    from .config import apply_date_range, normalize_portfolio_configs
    from .context import BacktestCancelled, BacktestError, RunContext, RunOptions
    from .pipeline import download_lock, write_snapshot
    from .st_shim import st

    activate_engine_home()
    say = progress or (lambda _f, _m: None)

    def check() -> None:
        if cancelled and cancelled():
            raise BacktestCancelled()

    ctx = RunContext(progress_fn=lambda f, m: say(0.02 + 0.2 * f, _fr(m)), cancel_fn=cancelled)
    ctx.price_update = str((run_options or {}).get("price_update") or "topup")
    universe, label = resolve_universe(o, portfolios)
    if len(universe) < o["n_pick"]:
        raise ValueError(f"L’univers ne compte que {len(universe)} tickers : impossible d’en tirer {o['n_pick']} par tirage.")

    opts_dict = {**(run_options or {}), "start_with": "oldest", "start_date": o["start_date"], "end_date": o["end_date"]}
    opts_dict.pop("price_update", None)
    options = RunOptions.from_dict(opts_dict)

    raw = [p for p in portfolios if isinstance(p, dict)]
    if not raw:
        raise ValueError("Aucun portfolio à simuler.")
    base_all = normalize_portfolio_configs(copy.deepcopy(raw))
    verdicts = [classify(c, o["n_pick"]) for c in base_all]
    base = [c for c, v in zip(base_all, verdicts) if v["status"] == "included"]
    if not base:
        raise ValueError(none_eligible(verdicts))
    names = {c["name"] for c in base}
    if o["baseline"] and BASELINE_NAME not in names:
        base += normalize_portfolio_configs([baseline_config(base[0])])
    # Universe filters of the study apply to every portfolio and to the reference alike: a stock that is not yet in
    # the S&P 500 (or under the minimum cap) on a date is simply not held then, so a draw can hold fewer stocks.
    for c in base:
        if o["filters"]["sp500_entry"]:
            c["exclude_before_sp500_entry"] = True
        if o["filters"]["min_cap"]:
            c["use_min_market_cap_filter"] = True
            c["min_market_cap_billions"] = o["filters"]["min_cap_billions"]
    configs = [c if R.is_fusion(c) else with_stocks(c, universe) for c in base]
    R._dedupe_names(configs)
    apply_date_range(configs, options)
    st.session_state.reset(options.session_state())
    st.session_state.multi_backtest_portfolio_configs = configs
    st.messages.clear()
    R._validate(configs)

    say(0.02, f"Prix de {len(universe)} actions de l’univers…")
    stub = R.BacktestRun(configs=configs, options=options)
    with contextlib.redirect_stdout(io.StringIO()):
        data = R._download(R._collect_tickers(configs), configs, ctx, stub, lock=download_lock())
    check()

    # Universe tickers usable over the window: with prices, not stopped long before the others,
    # with at least a year of history inside the window.
    frames = {t: data[t] for t in universe if isinstance(data.get(t), pd.DataFrame) and not data[t].empty}
    if not frames:
        raise BacktestError("Aucun ticker de l’univers n’a de prix.")
    end_cap = pd.Timestamp(o["end_date"]) if o["end_date"] else None
    lasts = {t: df["Close"].last_valid_index() for t, df in frames.items()}
    firsts = {t: df["Close"].first_valid_index() for t, df in frames.items()}
    ref_end = max(v for v in lasts.values() if v is not None)
    if end_cap is not None:
        ref_end = min(ref_end, end_cap)
    stale = sorted(t for t, v in lasts.items() if v is None or v < ref_end - pd.Timedelta(days=STALE_DAYS))
    short = sorted(t for t, v in firsts.items() if t not in stale and (v is None or v > ref_end - pd.Timedelta(days=MIN_HISTORY_DAYS)))
    kept = [t for t in universe if t in frames and t not in stale and t not in short]
    missing = [t for t in universe if t not in frames]
    if len(kept) < o["n_pick"]:
        raise BacktestError(f"Seulement {len(kept)} tickers de l’univers ont un historique utilisable sur la période : "
                            f"impossible d’en tirer {o['n_pick']}.")
    drop = set(stale) | set(short)
    data = {k: v for k, v in data.items() if k not in drop}
    configs = [c if R.is_fusion(c) else with_stocks(c, kept) for c in configs]
    st.session_state.multi_backtest_portfolio_configs = configs
    final_start, common_end, display_start = R._simulation_range(data, configs, options, ctx)
    simulation_index = pd.date_range(start=final_start, end=common_end, freq="D")
    say(0.24, "Données de l’univers (secteurs, entrée S&P 500, capitalisations)…")
    with contextlib.redirect_stdout(io.StringIO()):
        R._prefetch_universe_maps(configs, ctx)
    check()
    prep = R.PreparedRun(
        configs=configs, options=options, data=data, data_keys=list(data.keys()), simulation_index=simulation_index,
        display_start=display_start, invalid_tickers=stub.invalid_tickers, warnings=list(ctx.warnings),
        session={k: st.session_state.get(k) for k in R._UNIVERSE_KEYS}, started=time.time(),
    )
    say(0.27, "Instantané des prix pour les processus de calcul…")
    write_snapshot(job_dir, prep)
    return {
        "universe": kept, "label": label, "missing": missing, "stale": stale, "short": short,
        "start": simulation_index[0], "end": simulation_index[-1], "display_start": display_start,
        "warnings": list(ctx.warnings), "portfolios": verdicts,
    }


_FR = (
    (re.compile(r"^Downloading data for (\d+) tickers"), r"Prix de \1 tickers…"),
    (re.compile(r"^Processing \S+ \((\d+)/(\d+)\)"), r"Lecture des prix (\1/\2)"),
    (re.compile(r"^Updating recent days for (\d+) stored tickers \((\d+)/\d+\)"), r"Mise à jour des derniers jours : \2/\1 tickers"),
    (re.compile(r"^Yahoo rate limit: retrying in (\d+)s"), r"Yahoo limite les requêtes : nouvel essai dans \1 s"),
    (re.compile(r"^Loading sector/industry for (\d+) tickers"), r"Secteurs et industries de \1 tickers…"),
    (re.compile(r"^Loading S&P 500 entry dates"), r"Dates d’entrée dans le S&P 500…"),
    (re.compile(r"^Loading market caps for (\d+) tickers"), r"Capitalisations de \1 tickers…"),
)


def _fr(message: str) -> str:
    """French progress lines for the steps shared with Construire (which reports in English)."""
    for rx, repl in _FR:
        m = rx.match(message)
        if m:
            return m.expand(repl)
    return message


# ------------------------------------------------------------------------------------------------
# worker side: one draw = one normal run of every portfolio on the drawn stocks
# ------------------------------------------------------------------------------------------------

class _Snapshot:
    """Lazy reader of a job snapshot (meta + one pickle per ticker), with a small frame cache."""

    def __init__(self, job_dir: Path, max_frames: int = 200) -> None:
        from .pipeline import _load

        self.job_dir = job_dir
        meta = _load(job_dir / "meta.pkl")
        self.prep = meta["prep"]
        self.files: dict[str, Any] = meta["files"]
        self.cache: "OrderedDict[str, Any]" = OrderedDict()
        self.max_frames = max_frames

    def raw(self, key: str) -> Any:
        from .pipeline import _load

        hit = self.cache.get(key)
        if hit is None:
            kind, value = self.files[key]
            hit = value if kind == "str" else _load(self.job_dir / "data" / value)
            self.cache[key] = hit
            while len(self.cache) > self.max_frames:
                self.cache.popitem(last=False)
        else:
            self.cache.move_to_end(key)
        return hit


_SNAP: dict[str, _Snapshot] = {}


def _snapshot(job_dir: str) -> _Snapshot:
    snap = _SNAP.get(job_dir)
    if snap is None:
        _SNAP.clear()
        snap = _SNAP[job_dir] = _Snapshot(Path(job_dir))
    return snap


def _sample(series: pd.Series, grid: pd.DatetimeIndex) -> list[float | None]:
    if not isinstance(series, pd.Series) or series.empty:
        return [None] * len(grid)
    s = series.astype(float)
    first = s.iloc[0]
    if not first or not math.isfinite(first):
        return [None] * len(grid)
    v = s.reindex(grid).to_numpy() / first
    return [round(float(x), 5) if math.isfinite(x) else None for x in v]


def _holdings_cash(allocations: dict) -> tuple[float | None, float | None]:
    if not allocations:
        return None, None
    n = held = cash = 0.0
    keys = sorted(allocations.keys())
    for d in keys[::7]:  # weekly sample of the daily allocation snapshots
        row = allocations[d]
        if not isinstance(row, dict):
            continue
        n += 1
        cash += float(row.get("CASH", 0.0) or 0.0)
        held += sum(1 for t, w in row.items() if t != "CASH" and isinstance(w, (int, float)) and w > 1e-4)
    return (held / n, cash / n) if n else (None, None)


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def run_draw(job_dir: str, draw: int, tickers: list[str], grid: list[str]) -> dict[str, Any]:
    """Every portfolio of the job on `tickers`: the same steps as a normal run of those stocks."""
    from . import runner as R
    from .context import BacktestError, RunContext
    from .st_shim import st

    t0 = time.perf_counter()
    snap = _snapshot(job_dir)
    up = snap.prep
    cfgs = [c if R.is_fusion(c) else with_stocks(c, tickers) for c in up.configs]
    keys = [k for k in R._collect_tickers(cfgs) if k in snap.files]
    raw = {k: snap.raw(k) for k in keys}
    gidx = pd.DatetimeIndex(grid)
    out: dict[str, Any] = {"draw": draw, "tickers": tickers, "series": []}
    st.session_state.reset(up.options.session_state())
    st.session_state.multi_backtest_portfolio_configs = cfgs
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            final_start, common_end, display_start = R._simulation_range(raw, cfgs, up.options, RunContext())
    except BacktestError as exc:
        out["error"] = str(exc)
        out["seconds"] = round(time.perf_counter() - t0, 3)
        return out
    sim = pd.date_range(start=final_start, end=common_end, freq="D")
    reindexed = R._reindex(raw, sim)
    prep = dataclasses.replace(up, configs=cfgs, data={}, data_keys=keys, simulation_index=sim,
                               display_start=display_start, warnings=[])
    out["start"] = sim[0].strftime("%Y-%m-%d")
    out["end"] = sim[-1].strftime("%Y-%m-%d")
    by_index: dict[int, dict] = {}
    with contextlib.redirect_stdout(io.StringIO()):
        for i in prep.execution_order():
            frames = R.isolate_frames({k: reindexed[k] for k in R.tickers_for(prep, i)}, R.ma_seed(prep, i))
            R.install_session(prep, raw)
            o = R.run_one(prep, i, frames, raw)
            rec: dict[str, Any] = {"name": cfgs[i]["name"], "ok": bool(o["success"])}
            if o["success"]:
                vals = (o.get("stats") or {}).get("values") or {}
                rec["stats"] = {k: _num(vals.get(k)) for k in STAT_KEYS}
                hold, cash = _holdings_cash(o.get("allocations") or {})
                rec["stats"]["holdings"] = hold
                rec["stats"]["cash"] = cash
                rec["curve"] = _sample(o["entry"].get("no_additions"), gidx)
            else:
                rec["error"] = o.get("error") or "Échec"
            by_index[i] = rec
    out["series"] = [by_index[i] for i in range(len(cfgs)) if i in by_index]
    out["seconds"] = round(time.perf_counter() - t0, 3)
    return out


_CHANNEL: dict[str, Any] = {}


def _worker_init(home: str, messages: Any = None, cancel: Any = None) -> None:
    """Pool worker start: engine home, silent legacy prints, the job's progress queue and cancel
    event (inherited here: multiprocessing queues cannot travel as task arguments)."""
    _CHANNEL["messages"], _CHANNEL["cancel"] = messages, cancel
    os.environ["ENGINE_HOME"] = home
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
    from . import activate_engine_home

    activate_engine_home()


# ------------------------------------------------------------------------------------------------
# aggregation
# ------------------------------------------------------------------------------------------------

def _stats(a: np.ndarray) -> dict[str, float | int | None]:
    x = a[np.isfinite(a)]
    if x.size == 0:
        return {"n": 0, "mean": None, "sd": None, "min": None, "max": None, **{f"p{p}": None for p in PCTS}}
    q = np.percentile(x, PCTS)
    return {"n": int(x.size), "mean": float(x.mean()), "sd": float(x.std(ddof=1)) if x.size > 1 else 0.0,
            "min": float(x.min()), "max": float(x.max()), **{f"p{p}": float(v) for p, v in zip(PCTS, q)}}


def _r(v: float | None, nd: int = 6) -> float | None:
    return None if v is None or not math.isfinite(v) else round(float(v), nd)


def _share(mask: np.ndarray, valid: np.ndarray) -> float | None:
    n = int(valid.sum())
    return float((mask & valid).sum() / n) if n else None


def aggregate(results: list[dict], names: list[str], kinds: list[str], grid: list[str],
              benchmark: dict[str, Any] | None) -> dict[str, Any]:
    D = len(results)
    S = len(names)
    G = len(grid)
    stats = {k: np.full((S, D), np.nan) for k in STAT_KEYS + EXTRA_KEYS}
    curves = np.full((S, D, G), np.nan)
    errors: list[dict[str, Any]] = []
    for d, res in enumerate(results):
        if res.get("error"):
            errors.append({"draw": res["draw"], "error": res["error"]})
            continue
        for rec in res["series"]:
            if rec["name"] not in names:
                continue
            s = names.index(rec["name"])
            if not rec["ok"]:
                errors.append({"draw": res["draw"], "portfolio": rec["name"], "error": rec.get("error")})
                continue
            for k, v in rec["stats"].items():
                if k in stats and v is not None:
                    stats[k][s, d] = v
            curves[s, d, :] = [np.nan if v is None else v for v in rec["curve"]]

    series = []
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            for s in range(S):
                fan = {f"p{p}": [_r(v, 5) for v in np.nanpercentile(curves[s], p, axis=0)] for p in PCTS}
                series.append({
                    "name": names[s],
                    "kind": kinds[s],
                    "stats": {k: [_r(v) for v in stats[k][s]] for k in stats},
                    "summary": {k: _stats(stats[k][s]) for k in stats},
                    "fan": fan,
                    "curves": [[None if not math.isfinite(v) else round(float(v), 4) for v in curves[s, d]] for d in range(D)],
                })

    pairs = []
    for a in range(S):
        for b in range(S):
            if a == b:
                continue
            ca, cb = stats["CAGR"][a], stats["CAGR"][b]
            ok = np.isfinite(ca) & np.isfinite(cb)
            sa, sb = stats["Sharpe"][a], stats["Sharpe"][b]
            oks = np.isfinite(sa) & np.isfinite(sb)
            da, db = stats["MaxDrawdown"][a], stats["MaxDrawdown"][b]
            okd = np.isfinite(da) & np.isfinite(db)
            diff = (ca - cb)[ok]
            pairs.append({
                "a": a, "b": b, "n": int(ok.sum()),
                "cagr_win": _share(ca > cb, ok),
                "sharpe_win": _share(sa > sb, oks),
                "drawdown_win": _share(da > db, okd),
                "cagr_diff": _stats(diff) if diff.size else _stats(np.array([])),
            })

    return {
        "series": series,
        "pairs": pairs,
        "draws": [{"draw": r["draw"], "tickers": r["tickers"], "start": r.get("start"), "end": r.get("end"),
                   "error": r.get("error")} for r in results],
        "errors": errors[:200],
        "benchmark": benchmark,
    }


def _grid(index: pd.DatetimeIndex, points: int) -> pd.DatetimeIndex:
    step = max(1, math.ceil(len(index) / points))
    g = index[::step]
    if g[-1] != index[-1]:
        g = g.append(index[-1:])
    return g


def _benchmark_curve(job_dir: Path, ticker: str | None, grid: pd.DatetimeIndex, start: pd.Timestamp) -> dict | None:
    if not ticker:
        return None
    from .pipeline import _load

    meta = _load(job_dir / "meta.pkl")
    f = meta["files"].get(ticker)
    if not f or f[0] != "file":
        return None
    df = _load(job_dir / "data" / f[1])
    close = df["Close"].astype(float)
    close = close[~close.index.duplicated(keep="last")].sort_index()
    full = close.reindex(close.index.union(grid)).ffill().reindex(grid)
    base = full.dropna()
    if base.empty:
        return None
    v = (full / base.iloc[0]).to_numpy()
    return {"ticker": ticker, "curve": [None if not math.isfinite(x) else round(float(x), 5) for x in v]}


# ------------------------------------------------------------------------------------------------
# orchestration
# ------------------------------------------------------------------------------------------------

def prepare_task(job_dir: str, portfolios: list[dict], run_options: dict[str, Any], o: dict[str, Any]) -> dict[str, Any]:
    """prepare() in a worker process: it drives the legacy session shim, which the server process
    shares with its other requests. Progress goes back through a queue, cancellation through an event."""
    messages, cancel = _CHANNEL.get("messages"), _CHANNEL.get("cancel")

    def say(f: float, m: str) -> None:
        if messages is not None:
            try:
                messages.put_nowait((f, m))
            except Exception:  # noqa: BLE001 - progress is best effort
                pass

    return prepare(Path(job_dir), portfolios, run_options, o, say, (cancel.is_set if cancel is not None else None))


def run_montecarlo(portfolios: list[dict], run_options: dict[str, Any] | None, mc_options: dict[str, Any] | None, *,
                   job_dir: Path, progress: Callable[[float, str], None] | None = None,
                   cancelled: Callable[[], bool] | None = None, workers: int | None = None) -> dict[str, Any]:
    from . import engine_home
    from .context import BacktestCancelled
    from .pipeline import _load

    t_start = time.perf_counter()
    o = clean_options(mc_options)
    say = progress or (lambda _f, _m: None)
    job_dir.mkdir(parents=True, exist_ok=True)
    workers = max(1, int(workers or max(1, (os.cpu_count() or 2) - 1)))
    workers = min(workers, max(1, o["n_draws"]))
    ctx = mp.get_context("spawn")
    messages, cancel_ev = ctx.Queue(), ctx.Event()
    pool = ProcessPoolExecutor(max_workers=workers, mp_context=ctx, initializer=_worker_init,
                               initargs=(str(engine_home()), messages, cancel_ev))
    try:
        say(0.01, "Démarrage des processus de calcul…")
        fut = pool.submit(prepare_task, str(job_dir), portfolios, run_options or {}, o)
        while True:
            done, _ = wait([fut], timeout=0.4)
            try:
                while True:
                    f, m = messages.get_nowait()
                    say(f, m)
            except Exception:  # noqa: BLE001 - queue empty
                pass
            if cancelled and cancelled():
                cancel_ev.set()
            if done:
                break
        try:
            info = fut.result()
        except BacktestCancelled as exc:
            raise MonteCarloCancelled() from exc
        if cancelled and cancelled():
            raise MonteCarloCancelled()

        prep = _load(job_dir / "meta.pkl")["prep"]
        names = [c["name"] for c in prep.configs]
        kinds = ["baseline" if n == BASELINE_NAME else "portfolio" for n in names]
        draws = draw_lists(info["universe"], o["n_draws"], o["n_pick"], o["seed"])
        grid_idx = _grid(prep.simulation_index, o["points"])
        grid = [d.strftime("%Y-%m-%d") for d in grid_idx]
        bench_ticker = next((c.get("benchmark_ticker") for c in prep.configs if c.get("benchmark_ticker")), None)
        benchmark = _benchmark_curve(job_dir, bench_ticker, grid_idx, prep.simulation_index[0])

        results: list[dict] = []

        def tick() -> None:
            n = len(results)
            say(0.3 + 0.68 * n / len(draws), f"Tirages {n}/{len(draws)} ({workers} processus)")
            if cancelled and cancelled():
                raise MonteCarloCancelled()

        tick()
        pending = {pool.submit(run_draw, str(job_dir), d, tickers, grid) for d, tickers in enumerate(draws)}
        while pending:
            fin, pending = wait(pending, timeout=0.5, return_when=FIRST_COMPLETED)
            for f in fin:
                results.append(f.result())
            tick()
        results.sort(key=lambda r: r["draw"])
        busy_s = sum(r.get("seconds", 0.0) for r in results)

        agg = aggregate(results, names, kinds, grid, benchmark)
        elapsed = time.perf_counter() - t_start
        say(1.0, "Terminé")
        return {
            "format": FORMAT,
            "options": {**o, "workers": workers},
            "universe": {
                "label": info["label"], "count": len(info["universe"]), "missing": info["missing"][:200],
                "stale": info["stale"][:200], "short": info["short"][:200],
                "n_missing": len(info["missing"]), "n_stale": len(info["stale"]), "n_short": len(info["short"]),
            },
            "window": {"start": prep.simulation_index[0].strftime("%Y-%m-%d"), "end": prep.simulation_index[-1].strftime("%Y-%m-%d")},
            "dates": grid,
            "warnings": info["warnings"][:20],
            "portfolios": info["portfolios"],
            "elapsed_s": round(elapsed, 3),
            "busy_s": round(busy_s, 3),
            **agg,
        }
    except BaseException:
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    finally:
        pool.shutdown(wait=True)
        messages.close()
        shutil.rmtree(job_dir, ignore_errors=True)
