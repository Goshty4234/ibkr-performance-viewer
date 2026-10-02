"""Regression gate: the parity configs on frozen prices, offline, against approved results.

Usage (from engine/):
    py -3.13 -m tests.regression.run_regression               # compare with baseline/ (exit 1 on any difference)
    py -3.13 -m tests.regression.run_regression 07_fusion     # only configs whose name contains the filter
    py -3.13 -m tests.regression.run_regression --rebaseline  # approve the current results
    py -3.13 -m tests.regression.run_regression --seed        # download the prices again (network) into prices.zip

Every run uses a fresh temporary ENGINE_HOME holding the frozen ticker store (prices.zip), reads
the store as is (price_update "stored"), ends every simulation on END_DATE and has the network
cut off, so two runs of the same code give the same numbers on any machine with the same
library versions. A difference means the engine computes something else: either a regression,
or an intended change to approve with --rebaseline (commit the new baseline with the code).
"""

from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import shutil
import socket
import sys
import tempfile
import time
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE_ROOT = HERE.parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

CONFIG_DIR = ENGINE_ROOT / "tests" / "parity" / "configs"
BASELINE_DIR = HERE / "baseline"
PRICES = HERE / "prices.zip"
STORE = Path(".streamlit") / "ticker_cache"
END_DATE = "2026-09-30"
DEAD_PROXY = "http://127.0.0.1:9"


def _offline() -> None:
    """Python sockets refuse to connect; curl (yfinance) and requests go through a dead proxy."""
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        os.environ[var] = DEAD_PROXY
    os.environ.pop("NO_PROXY", None)
    os.environ.pop("no_proxy", None)
    os.environ["ENGINE_ORIGINS_URL"] = ""

    def refuse(*_a, **_k):
        raise OSError("network disabled in the regression test")

    socket.socket.connect = refuse  # type: ignore[method-assign]
    socket.create_connection = refuse  # type: ignore[assignment]


def _home(seed: bool) -> Path:
    home = Path(tempfile.mkdtemp(prefix="engine_regression_"))
    src = ENGINE_ROOT / "Complete_Tickers" / "Historical CSV"
    if src.exists():
        shutil.copytree(src, home / "Complete_Tickers" / "Historical CSV")
    if not seed:
        with zipfile.ZipFile(PRICES) as z:
            z.extractall(home)
    os.environ["ENGINE_HOME"] = str(home)
    return home


def _run(raw: dict, seed: bool) -> tuple[dict, list[str]]:
    from backtest_engine.runner import run_backtest
    from tests.parity.run_parity import normalize

    options = {**(raw.get("options") or {}), "end_date": END_DATE, "price_update": "topup" if seed else "stored"}
    with redirect_stdout(io.StringIO()):
        run = run_backtest(raw["portfolios"], options)
    raw_keys = ("Final Value (with)", "Final Value (no_additions)", "Total Money Added")
    stats = {n: {**s.get("display", {}), **{k: s["values"][k] for k in raw_keys if k in s.get("values", {})}}
             for n, s in run.stats.items()}
    out = normalize(run.all_results, run.all_allocations, run.all_metrics, run.today_weights,
                    run.last_rebalance_dates, stats)
    return json.loads(json.dumps(out)), list(run.warnings or [])


def _round(v):
    """12 significant digits: far below the 1e-9 tolerance, and the baseline compresses 3x better."""
    if isinstance(v, float):
        return float(f"{v:.12g}")
    if isinstance(v, dict):
        return {k: _round(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_round(x) for x in v]
    return v


def write_baseline(path: Path, result: dict) -> None:
    data = json.dumps(_round(result), sort_keys=True, separators=(",", ":")).encode("utf-8")
    path.write_bytes(gzip.compress(data, compresslevel=9, mtime=0))


def read_baseline(path: Path) -> dict:
    return json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))


def _save_prices(home: Path) -> None:
    store = home / STORE
    with zipfile.ZipFile(PRICES, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in sorted(store.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(home))
    print(f"prices.zip: {PRICES.stat().st_size / 2**20:.1f} MB")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("filter", nargs="?", default="")
    ap.add_argument("--rebaseline", action="store_true")
    ap.add_argument("--seed", action="store_true")
    args = ap.parse_args()
    if args.seed and args.filter:
        ap.error("--seed records every config")

    if not args.seed:
        _offline()
    home = _home(args.seed)
    from tests.parity.run_parity import diff

    BASELINE_DIR.mkdir(exist_ok=True)
    configs = sorted(p for p in CONFIG_DIR.glob("*.json") if args.filter in p.stem)
    failures = 0
    try:
        for cfg_path in configs:
            name = cfg_path.stem
            t0 = time.perf_counter()
            try:
                result, warnings = _run(json.loads(cfg_path.read_text(encoding="utf-8")), args.seed)
            except Exception as exc:  # noqa: BLE001
                import traceback

                traceback.print_exc()
                failures += 1
                print(f"[{name}] CRASH {exc!r}")
                continue
            finally:
                os.chdir(ENGINE_ROOT)
            elapsed = time.perf_counter() - t0
            path = BASELINE_DIR / f"{name}.json.gz"
            if args.seed:
                print(f"[{name}] prices recorded ({elapsed:.1f}s)")
                continue
            if args.rebaseline or not path.exists():
                write_baseline(path, result)
                print(f"[{name}] baseline written ({elapsed:.1f}s, {len(result)} portfolios)")
                continue
            problems = diff(read_baseline(path), result)
            if not result:
                problems.insert(0, "no portfolio computed")
            if problems:
                failures += 1
                print(f"[{name}] FAIL ({elapsed:.1f}s)")
                for p in problems:
                    print(f"    {p}")
                for w in warnings[:5]:
                    print(f"    warning: {w}")
            else:
                print(f"[{name}] OK  {elapsed:.1f}s  portfolios={len(result)}")
        if args.seed:
            _save_prices(home)
    finally:
        shutil.rmtree(home, ignore_errors=True)
    print(f"\n{len(configs) - failures}/{len(configs)} configs identical to the baseline (end {END_DATE}, offline)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
