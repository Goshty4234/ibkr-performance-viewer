"""Parity check: extracted engine vs original Streamlit page, on frozen prices.

Usage (from engine/):
    py -3.13 -m tests.parity.run_parity --record       # fetch prices + build golden references
    py -3.13 -m tests.parity.run_parity                # replay prices, compare engine to golden
    py -3.13 -m tests.parity.run_parity --reference    # replay prices, rebuild golden from Streamlit code
    py -3.13 -m tests.parity.run_parity 02_momentum    # only configs whose name contains the filter
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import shutil
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ENGINE_ROOT = HERE.parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from backtest_engine.serialize import date_key, to_jsonable  # noqa: E402
from tests.parity import yf_replay  # noqa: E402

CONFIG_DIR = HERE / "configs"
FIXTURE_DIR = HERE / "fixtures"
GOLDEN_DIR = HERE / "golden"
WORK_DIR = HERE / "_work"

TOL = 1e-9


def _prepare_workdir(side: str) -> Path:
    wd = WORK_DIR / side
    if wd.exists():
        shutil.rmtree(wd, ignore_errors=True)
    wd.mkdir(parents=True, exist_ok=True)
    src = ENGINE_ROOT / "Complete_Tickers" / "Historical CSV"
    if src.exists():
        shutil.copytree(src, wd / "Complete_Tickers" / "Historical CSV")
    return wd


def _fmt_mwrr(v: Any) -> str:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    return "N/A" if math.isnan(f) else f"{f:.2f}%"


def normalize(results: dict, allocations: dict, metrics: dict, today: dict, last_reb: dict, stats: dict) -> dict:
    out: dict[str, Any] = {}
    for name, res in results.items():
        if not isinstance(res, dict) or "no_additions" not in res:
            continue
        stat_row = {}
        for k, v in (stats.get(name) or {}).items():
            stat_row[k] = _fmt_mwrr(v) if k == "MWRR" else (v if isinstance(v, str) else to_jsonable(v))
        out[name] = {
            "with_additions": to_jsonable(res.get("with_additions")),
            "no_additions": to_jsonable(res.get("no_additions")),
            "allocations": to_jsonable(allocations.get(name, {})),
            "metrics": to_jsonable(metrics.get(name, {})),
            "today_weights": to_jsonable(today.get(name, {})),
            "last_rebalance": date_key(last_reb.get(name)),
            "stats": stat_row,
        }
    return out


def _run_reference_side(raw: dict) -> dict:
    from tests.parity.reference import run_reference

    wd = _prepare_workdir("reference")
    os.chdir(wd)
    with redirect_stdout(io.StringIO()):
        ref = run_reference(raw)
    if ref.get("stopped"):
        raise RuntimeError(f"Reference run stopped (st.stop): {ref.get('messages')}")
    return normalize(ref["all_results"], ref["all_allocations"], ref["all_metrics"], ref["today_weights"],
                     ref["last_rebalance_dates"], ref["stats"])


def _run_engine_side(raw: dict, pool: int = 0, fixture: Path | None = None) -> tuple[dict, float]:
    from backtest_engine.runner import run_backtest

    wd = _prepare_workdir("engine")
    os.environ["ENGINE_HOME"] = str(wd)
    t0 = time.perf_counter()
    with redirect_stdout(io.StringIO()):
        if pool:
            from backtest_engine.pipeline import load_run, run_local

            job_dir, _info = run_local(raw["portfolios"], raw.get("options") or {}, job_dir=wd / "_job", workers=pool,
                                       keep_raw=True, worker_hook="tests.parity.yf_replay:install",
                                       worker_hook_args=(str(fixture), "replay"))
            run = load_run(job_dir)
        else:
            run = run_backtest(raw["portfolios"], raw.get("options") or {})
    elapsed = time.perf_counter() - t0
    raw_keys = ("Final Value (with)", "Final Value (no_additions)", "Total Money Added")
    stats_display = {
        n: {**s.get("display", {}), **{k: s["values"][k] for k in raw_keys if k in s.get("values", {})}}
        for n, s in run.stats.items()
    }
    return (
        normalize(run.all_results, run.all_allocations, run.all_metrics, run.today_weights,
                  run.last_rebalance_dates, stats_display),
        elapsed,
    )


def _close(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is b
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        fa, fb = float(a), float(b)
        if math.isnan(fa) or math.isnan(fb):
            return math.isnan(fa) and math.isnan(fb)
        return abs(fa - fb) <= TOL * max(1.0, abs(fa), abs(fb))
    return a == b


def diff(a: Any, b: Any, path: str = "", out: list[str] | None = None, limit: int = 25) -> list[str]:
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a or k not in b:
                out.append(f"{path}/{k}: key only in {'engine' if k not in a else 'reference'}")
            else:
                diff(a[k], b[k], f"{path}/{k}", out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} (reference) != {len(b)} (engine)")
        for i, (x, y) in enumerate(zip(a, b)):
            if len(out) >= limit:
                break
            diff(x, y, f"{path}[{i}]", out, limit)
    elif not _close(a, b):
        out.append(f"{path}: {a!r} (reference) != {b!r} (engine)")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("filter", nargs="?", default="")
    ap.add_argument("--record", action="store_true", help="fetch real prices and rebuild golden references")
    ap.add_argument("--reference", action="store_true", help="rebuild golden references from recorded prices")
    ap.add_argument("--pool", type=int, default=0, help="run the engine through the task pipeline with N workers "
                                                          "(1 = inline tasks)")
    args = ap.parse_args()
    if args.pool and args.record:
        ap.error("--pool only runs in replay mode")

    from backtest_engine.certs import ensure_system_ca_bundle

    ensure_system_ca_bundle(ENGINE_ROOT / ".certs")
    GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
    configs = sorted(p for p in CONFIG_DIR.glob("*.json") if args.filter in p.stem)
    failures = 0
    for cfg_path in configs:
        name = cfg_path.stem
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        store = yf_replay.install(FIXTURE_DIR / f"{name}.pkl", "record" if args.record else "replay")
        golden_path = GOLDEN_DIR / f"{name}.json"
        try:
            if args.record or args.reference or not golden_path.exists():
                t0 = time.perf_counter()
                golden = _run_reference_side(raw)
                golden_path.write_text(json.dumps(golden), encoding="utf-8")
                print(f"[{name}] reference built in {time.perf_counter() - t0:.1f}s ({len(golden)} portfolios)")
            golden = json.loads(golden_path.read_text(encoding="utf-8"))
            engine, elapsed = _run_engine_side(raw, args.pool, FIXTURE_DIR / f"{name}.pkl")
            engine = json.loads(json.dumps(engine))
            problems = diff(golden, engine)
            if not golden:
                problems.insert(0, "reference produced no portfolio")
        except Exception as exc:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            problems = [f"crash: {exc!r}"]
            elapsed = 0.0
        finally:
            os.chdir(ENGINE_ROOT)
            store.save()
        if problems:
            failures += 1
            print(f"[{name}] FAIL")
            for p in problems:
                print(f"    {p}")
        else:
            print(f"[{name}] OK  engine {elapsed:.1f}s  portfolios={list(golden)}")
    print(f"\n{len(configs) - failures}/{len(configs)} configs identical (tolerance {TOL:g})")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
