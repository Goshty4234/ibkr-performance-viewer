"""Which portfolios a Monte Carlo accepts (momentum, equal-weight baskets) and which it leaves out.

Offline, on the frozen regression prices. Checks the verdicts, that left-out portfolios never reach the
simulation, that an equal-weight 25/25/25/25 portfolio really behaves like the equal-weight reference
of the drawn stocks, and that a request with nothing usable is refused with the reasons.

Run from engine/:  py -3.13 -m tests.montecarlo.test_eligibility
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


def _base(name: str, stocks: list[dict], **kw) -> dict:
    return {"name": name, "stocks": stocks, "benchmark_ticker": "^GSPC", "initial_value": 10000, "added_amount": 0,
            "added_frequency": "Never", "rebalancing_frequency": "Monthly", "use_momentum": False, **kw}


def _alloc(*pairs: tuple[str, float]) -> list[dict]:
    return [{"ticker": t, "allocation": a, "include_dividends": True} for t, a in pairs]


MOMENTUM = _base("Momentum", [], use_momentum=True, momentum_strategy="Classic", negative_momentum_strategy="Cash",
                 momentum_windows=[{"lookback": 252, "exclude": 21, "weight": 1.0}])
CASES = {
    "Momentum": ("included", "momentum", MOMENTUM),
    "Equal 4": ("included", "equal_weight", _base("Equal 4", _alloc(("SPY", .25), ("QQQ", .25), ("GLD", .25), ("TLT", .25)))),
    "Equal 4 percent": ("included", "equal_weight", _base("Equal 4 percent", _alloc(("SPY", 25), ("QQQ", 25), ("GLD", 25), ("TLT", 25)))),
    "Equal hold": ("included", "equal_weight", _base("Equal hold", _alloc(("SPY", .5), ("QQQ", .5)), rebalancing_frequency="Never")),
    "60/40": ("excluded", "static", _base("60/40", _alloc(("SPY", .6), ("TLT", .4)))),
    "SPY only": ("excluded", "single", _base("SPY only", _alloc(("SPY", 1.0)), rebalancing_frequency="Never")),
    "With cash": ("excluded", "static", _base("With cash", _alloc(("SPY", .5), ("CASH", .5)))),
    "SPY twice": ("excluded", "single", _base("SPY twice", _alloc(("SPY", .5), ("SPY", .5)))),
    "Momentum SPY": ("excluded", "single", _base("Momentum SPY", _alloc(("SPY", 1.0)), use_momentum=True, momentum_strategy="Classic",
                                                  negative_momentum_strategy="Cash", momentum_windows=[{"lookback": 252, "exclude": 21, "weight": 1.0}])),
    "Targeted": ("excluded", "targeted", _base("Targeted", _alloc(("SPY", .5), ("QQQ", .5)), use_targeted_rebalancing=True,
                                               targeted_rebalancing_settings={"SPY": {"enabled": True, "max_allocation": 55.0, "min_allocation": 45.0}})),
    "Fusion": ("excluded", "fusion", _base("Fusion", [], fusion_portfolio={"enabled": True, "selected_portfolios": ["Momentum"], "allocations": {"Momentum": 100}})),
}


def main() -> int:
    from tests.regression import run_regression as R

    R._offline()
    home = R._home(False)
    problems: list[str] = []
    try:
        from backtest_engine import montecarlo as M

        verdicts = {v["name"]: v for v in M.check_portfolios([c[2] for c in CASES.values()], {"n_pick": 3})}
        for name, (status, kind, _cfg) in CASES.items():
            v = verdicts.get(name)
            if v is None or v["status"] != status or v["kind"] != kind:
                problems.append(f"{name}: expected {status}/{kind}, got {v and (v['status'], v['kind'])}")
            elif status == "excluded" and not v["reason"]:
                problems.append(f"{name}: excluded without a reason")
        # a momentum top-N that does not filter anything is flagged
        tight = M.check_portfolios([dict(MOMENTUM, name="Top 5", use_limit_to_top_n=True, limit_to_top_n_tickers=5)], {"n_pick": 3})[0]
        if not tight["notes"]:
            problems.append("Top 5 with 3 stocks per draw: no note")

        # the simulation only runs what is accepted, and says why for the rest
        ew = _base("EW 4", _alloc(("SPY", 25), ("QQQ", 25), ("GLD", 25), ("TLT", 25)))
        mixed = [MOMENTUM, ew, CASES["60/40"][2], CASES["SPY only"][2], CASES["Targeted"][2]]
        mc = {"n_draws": 3, "n_pick": 3, "seed": 5, "universe": {"source": "list", "tickers": UNIVERSE},
              "start_date": "2008-01-01", "end_date": "2024-12-31", "points": 60}
        res = M.run_montecarlo(mixed, {"price_update": "stored"}, mc, job_dir=home / "montecarlo" / "a", workers=1)
        names = [s["name"] for s in res["series"]]
        if names != ["Momentum", "EW 4", M.BASELINE_NAME]:
            problems.append(f"series {names}")
        if [v["status"] for v in res["portfolios"]] != ["included", "included", "excluded", "excluded", "excluded"]:
            problems.append(f"verdicts in result: {[v['status'] for v in res['portfolios']]}")
        # EW 4 (monthly, no contributions) must be the very same strategy as the reference basket
        a, b = res["series"][1]["stats"], res["series"][2]["stats"]
        for k in ("CAGR", "MaxDrawdown", "Sharpe", "Total Return"):
            if a[k] != b[k]:
                problems.append(f"equal-weight portfolio differs from the reference on {k}: {a[k]} vs {b[k]}")

        # nothing usable: refused, with the reasons
        try:
            M.run_montecarlo([CASES["60/40"][2], CASES["SPY only"][2]], {"price_update": "stored"}, mc,
                             job_dir=home / "montecarlo" / "b", workers=1)
            problems.append("only 60/40 and SPY: not refused")
        except ValueError as exc:
            if "60/40" not in str(exc) or "Un seul titre" not in str(exc):
                problems.append(f"refusal message lacks the reasons: {exc}")
        for p in problems:
            print("  ", p)
        print("OK" if not problems else f"FAIL ({len(problems)})")
        return 1 if problems else 0
    finally:
        os.chdir(ENGINE_ROOT)
        shutil.rmtree(home, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
