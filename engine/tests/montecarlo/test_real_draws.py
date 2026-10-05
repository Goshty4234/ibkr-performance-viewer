"""Real-stock Monte Carlo: a draw is a normal run of the drawn stocks.

Offline, on the frozen regression prices: draws of 3 of the 6 stored ETFs. For every draw, each
portfolio's statistics and curve must equal those of run_backtest on the same stocks (start with
oldest, same dates), and the draws must not depend on the number of worker processes.

Run from engine/:  py -3.13 -m tests.montecarlo.test_real_draws
"""

from __future__ import annotations

import io
import json
import math
import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE_ROOT = HERE.parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

UNIVERSE = ["SPY", "QQQ", "GLD", "TLT", "IEF", "EFA"]
PORTFOLIOS = [
    {"name": "Momentum", "stocks": [], "benchmark_ticker": "^GSPC", "initial_value": 10000, "added_amount": 500,
     "added_frequency": "Monthly", "rebalancing_frequency": "Monthly", "use_momentum": True, "momentum_strategy": "Classic",
     "negative_momentum_strategy": "Cash", "calc_volatility": True, "calc_beta": True,
     "momentum_windows": [{"lookback": 365, "exclude": 30, "weight": 0.5}, {"lookback": 180, "exclude": 30, "weight": 0.5}]},
    {"name": "Momentum top 2", "stocks": [], "benchmark_ticker": "SPY", "initial_value": 10000, "added_amount": 0,
     "added_frequency": "Never", "rebalancing_frequency": "Quarterly", "use_momentum": True, "momentum_strategy": "Relative Momentum",
     "negative_momentum_strategy": "Equal weight", "use_limit_to_top_n": True, "limit_to_top_n_tickers": 2,
     "momentum_windows": [{"lookback": 252, "exclude": 21, "weight": 1.0}]},
]
OPTIONS = {"first_rebalance_strategy": "rebalancing_date", "price_update": "stored"}
MC = {"n_draws": 4, "n_pick": 3, "seed": 11, "universe": {"source": "list", "tickers": UNIVERSE},
      "start_date": "2008-01-01", "end_date": "2024-12-31", "points": 120,
      "align_momentum": False}  # compared with a normal run, which has no common start


def _close(a, b) -> bool:
    if a is None or b is None:
        return a is b
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)


def main() -> int:
    from tests.regression import run_regression as R

    R._offline()
    home = R._home(False)
    try:
        from backtest_engine import montecarlo as M
        from backtest_engine.runner import run_backtest

        res1 = M.run_montecarlo(PORTFOLIOS, OPTIONS, MC, job_dir=home / "montecarlo" / "a", workers=1)
        res2 = M.run_montecarlo(PORTFOLIOS, OPTIONS, MC, job_dir=home / "montecarlo" / "b", workers=2)
        problems: list[str] = []
        for s1, s2 in zip(res1["series"], res2["series"]):
            if s1["stats"] != s2["stats"] or s1["curves"] != s2["curves"]:
                problems.append(f"{s1['name']}: result depends on the number of workers")
        grid = res1["dates"]
        names = [s["name"] for s in res1["series"]]
        for d, draw in enumerate(res1["draws"]):
            stocks = [{"ticker": t, "allocation": 1 / len(draw["tickers"]), "include_dividends": True} for t in draw["tickers"]]
            cfgs = [dict(p, stocks=stocks) for p in PORTFOLIOS]
            cfgs.append(dict(M.baseline_config(PORTFOLIOS[0]), stocks=stocks))
            opts = {**OPTIONS, "start_with": "oldest", "start_date": MC["start_date"], "end_date": MC["end_date"]}
            with redirect_stdout(io.StringIO()):
                run = run_backtest(cfgs, opts)
            for name in names:
                s = res1["series"][names.index(name)]
                ref = run.stats[name]["values"]
                for k in M.STAT_KEYS:
                    got = s["stats"][k][d]
                    want = ref.get(k)
                    want = None if want is None or (isinstance(want, float) and not math.isfinite(want)) else round(float(want), 6)
                    if not _close(got, want):
                        problems.append(f"draw {d} {name} {k}: {got} != {want}")
                na = run.all_results[name]["no_additions"]
                import pandas as pd

                expect = (na.reindex(pd.DatetimeIndex(grid)) / na.iloc[0]).tolist()  # curves keep 4 decimals
                curve = s["curves"][d]
                for i, (g, e) in enumerate(zip(curve, expect)):
                    if (g is None) != (e is None or (isinstance(e, float) and math.isnan(e))) or (g is not None and abs(g - e) > 1.5e-4):
                        problems.append(f"draw {d} {name} curve[{i}]: {g} != {e}")
                        break
        print(json.dumps({"draws": len(res1["draws"]), "series": names, "elapsed_s": res1["elapsed_s"]}, ensure_ascii=False))
        for p in problems[:30]:
            print("  ", p)
        print("OK" if not problems else f"FAIL ({len(problems)})")
        return 1 if problems else 0
    finally:
        os.chdir(ENGINE_ROOT)
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
