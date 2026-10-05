"""« Départ commun » : tous les portfolios et la référence partent du jour où le momentum peut investir.

Offline, on the frozen regression prices. Without it the momentum portfolio holds cash during its first
look-back window while the equal-weight reference is invested; with it every curve of a draw starts on the same
day and the momentum portfolio is invested on its first measured day.

Run from engine/:  py -3.13 -m tests.montecarlo.test_align
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
MOMENTUM = {"name": "Momentum", "stocks": [], "benchmark_ticker": "^GSPC", "initial_value": 10000, "added_amount": 0,
            "added_frequency": "Never", "rebalancing_frequency": "Monthly", "use_momentum": True, "momentum_strategy": "Classic",
            "negative_momentum_strategy": "Cash", "momentum_windows": [{"lookback": 365, "exclude": 30, "weight": 1.0}]}


def _first(curve) -> int:
    return next((i for i, v in enumerate(curve) if v is not None), -1)


def main() -> int:
    from tests.regression import run_regression as R

    R._offline()
    home = R._home(False)
    problems: list[str] = []
    try:
        from backtest_engine import montecarlo as M

        base = {"n_draws": 4, "n_pick": 3, "seed": 5, "universe": {"source": "list", "tickers": UNIVERSE},
                "start_date": None, "end_date": "2024-12-31", "points": 120}
        runs = {}
        for key, align in (("off", False), ("on", True)):
            runs[key] = M.run_montecarlo([MOMENTUM], {"price_update": "stored"}, dict(base, align_momentum=align),
                                         job_dir=home / "montecarlo" / key, workers=1)
        off, on = runs["off"], runs["on"]
        if on["options"]["align_momentum"] is not True or off["options"]["align_momentum"] is not False:
            problems.append("option not echoed")
        if M.clean_options({})["align_momentum"] is not True:
            problems.append("should be on by default")
        names = [s["name"] for s in on["series"]]
        print("series:", names)
        for d in range(base["n_draws"]):
            starts = {s["name"]: _first(s["curves"][d]) for s in on["series"]}
            if len(set(starts.values())) != 1:
                problems.append(f"draw {d}: curves do not start together: {starts}")
            mom_on = on["series"][0]["stats"]
            mom_off = off["series"][0]["stats"]
            print(f"draw {d}: start {on['draws'][d].get('start')} vs {off['draws'][d].get('start')}, "
                  f"momentum cash {mom_on['cash'][d]} vs {mom_off['cash'][d]}, CAGR {mom_on['CAGR'][d]} vs {mom_off['CAGR'][d]}")
            if mom_on["cash"][d] is not None and mom_off["cash"][d] is not None and mom_on["cash"][d] > mom_off["cash"][d] + 1e-9:
                problems.append(f"draw {d}: momentum holds MORE cash when aligned")
        for p in problems:
            print("  ", p)
        print("OK" if not problems else f"FAIL ({len(problems)})")
        return 1 if problems else 0
    finally:
        os.chdir(ENGINE_ROOT)
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
