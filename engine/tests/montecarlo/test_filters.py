"""Universe filters of a Monte Carlo (S&P 500 entry date, minimum market cap): they reach every portfolio and
the reference, and a stock not yet eligible is simply not held (the draw then holds fewer stocks).

Offline, on the frozen regression prices; the Wikipedia entry dates are replaced by a fixed map.

Run from engine/:  py -3.13 -m tests.montecarlo.test_filters
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE_ROOT = HERE.parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

UNIVERSE = ["SPY", "QQQ", "GLD", "TLT", "IEF", "EFA"]


def main() -> int:
    from tests.regression import run_regression as R

    R._offline()
    home = R._home(False)
    problems: list[str] = []
    try:
        from backtest_engine import montecarlo as M
        from backtest_engine import runner as RUN

        # options reach the engine as typed, and are bounded
        o = M.clean_options({"filters": {"sp500_entry": True, "min_cap": 1, "min_cap_billions": "abc"}})
        if o["filters"] != {"sp500_entry": True, "min_cap": True, "min_cap_billions": 10.0}:
            problems.append(f"clean_options filters: {o['filters']}")
        if M.clean_options({})["filters"]["sp500_entry"] is not False:
            problems.append("filters should be off by default")

        # the engine reads Wikipedia through a 24 h disk cache: seed it instead of reaching the network
        import diskcache

        wiki = home / "marketdata" / "ticker_info_temp"
        wiki.mkdir(parents=True, exist_ok=True)
        with diskcache.Cache(str(wiki)) as cache:
            cache.set(RUN.L._SP500_WIKI_CACHE_KEY, {"tickers": ["GLD"], "date_added": {"GLD": "2019-01-01"}}, expire=3600)
        eq = {"name": "EW 3", "stocks": [{"ticker": t, "allocation": 1 / 3, "include_dividends": True} for t in ("SPY", "QQQ", "GLD")],
              "benchmark_ticker": "^GSPC", "initial_value": 10000, "added_amount": 0, "added_frequency": "Never",
              "rebalancing_frequency": "Monthly", "use_momentum": False}
        base = {"n_draws": 4, "n_pick": 3, "seed": 5, "universe": {"source": "list", "tickers": UNIVERSE},
                "start_date": "2012-01-01", "end_date": "2022-12-31", "points": 60}
        runs = {}
        for key, flt in (("off", None), ("on", {"sp500_entry": True})):
            mc = dict(base, **({"filters": flt} if flt else {}))
            runs[key] = M.run_montecarlo([eq], {"price_update": "stored"}, mc, job_dir=home / "montecarlo" / key, workers=1)
        a, b = runs["off"], runs["on"]
        if b["options"]["filters"]["sp500_entry"] is not True:
            problems.append("result does not echo the filters")
        draws_with_gld = [i for i, d in enumerate(a["draws"]) if "GLD" in d["tickers"]]
        if not draws_with_gld:
            problems.append("test setup: no draw contains GLD")
        for s_off, s_on in zip(a["series"], b["series"]):
            changed = [i for i in draws_with_gld if s_off["stats"]["Total Return"][i] != s_on["stats"]["Total Return"][i]]
            same = [i for i in range(len(a["draws"])) if i not in draws_with_gld and s_off["stats"]["Total Return"][i] != s_on["stats"]["Total Return"][i]]
            if not changed:
                problems.append(f"{s_off['name']}: the S&P 500 entry filter changed nothing on draws with GLD")
            if same:
                problems.append(f"{s_off['name']}: draws without GLD changed: {same}")
            if any(v is None for v in s_on["stats"]["Total Return"]):
                problems.append(f"{s_off['name']}: a draw failed with the filter on")
        for p in problems:
            print("  ", p)
        print("OK" if not problems else f"FAIL ({len(problems)})")
        return 1 if problems else 0
    finally:
        os.chdir(ENGINE_ROOT)
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
