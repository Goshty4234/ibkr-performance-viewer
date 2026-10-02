"""The vectorised weight pipeline against the engine's real functions."""

from __future__ import annotations

import random
import unittest

import numpy as np
import pandas as pd

from backtest_engine.config import normalize_one
from backtest_engine.mc.calendar import make_calendar, rebalance_indices
from backtest_engine.mc.generate import rng_for, synthetic_returns
from backtest_engine.mc.simulate import Aux
from backtest_engine.mc.strategy import compute_weights, parse_strategy, window_scores

from .legacy_harness import legacy_runner

STRATS = ["Classic", "Relative Momentum", "Near-Zero Symmetry"]
NEGS = ["Cash", "Equal weight", "Relative momentum", "Near-Zero Symmetry"]


def random_config(rnd: random.Random, i: int, N: int) -> dict:
    nwin = rnd.choice([1, 2, 3, 4])
    raw = [rnd.uniform(0.1, 1.0) for _ in range(nwin)]
    tot = sum(raw)
    wins = []
    for w in raw:
        lb = rnd.choice([60, 90, 120, 180, 252, 365])
        wins.append({"lookback": lb, "exclude": rnd.choice([0, 10, 30]), "weight": w / tot,
                     "discard_if_negative": rnd.random() < 0.25, "discard_unless_recent_positive": rnd.random() < 0.5})
    cfg = {
        "name": f"cfg{i}", "stocks": [], "use_momentum": True, "momentum_windows": wins,
        "momentum_strategy": rnd.choice(STRATS), "negative_momentum_strategy": rnd.choice(NEGS),
        "use_window_capped_score": rnd.random() < 0.4,
        "calc_volatility": rnd.random() < 0.4, "vol_window_days": rnd.choice([90, 180, 365]), "exclude_days_vol": rnd.choice([0, 30]),
        "calc_beta": rnd.random() < 0.3, "beta_window_days": rnd.choice([180, 365]), "exclude_days_beta": rnd.choice([0, 30]),
        "use_max_allocation": rnd.random() < 0.5, "max_allocation_percent": rnd.choice([10, 15, 20, 30, 50]),
        "use_minimal_threshold": rnd.random() < 0.4, "minimal_threshold_percent": rnd.choice([2, 4, 8]),
        "use_limit_to_top_n": rnd.random() < 0.4, "limit_to_top_n_tickers": rnd.choice([2, 3, 5, 8]),
        "use_equal_weight": rnd.random() < 0.3, "equal_weight_n_tickers": rnd.choice([2, 4, 6]),
    }
    return cfg


class WeightParity(unittest.TestCase):
    def test_matches_engine(self):
        rnd = random.Random(2026)
        N, S = 12, 5
        n_cases = int(__import__("os").environ.get("MC_PARITY_CASES", "60"))
        worst = 0.0
        checked = 0
        all_neg_rows = 0
        for case in range(n_cases):
            raw = random_config(rnd, case, N)
            cfg = normalize_one(raw)
            strat = parse_strategy(cfg)
            d, e0 = make_calendar(2.0, max(strat.max_days, 400) + 10)
            T = len(d)
            # bear / bull mix so that the "everything negative" paths are exercised
            bear = rnd.random() < 0.35
            logret = np.empty((S, T, N))
            for s in range(S):
                p = {"market_mu": -0.35 if bear else 0.08, "alpha_sd": rnd.choice([0.0, 0.2]), "extreme_per_year": 0.2}
                logret[s] = synthetic_returns(rng_for(case, s), T, N, p)
            L = np.cumsum(logret, axis=1)
            aux = Aux(logret, strat.calc_vol, strat.calc_beta)
            tickers = [f"T{j}" for j in range(N)]
            lcfg = dict(cfg)
            lcfg["stocks"] = [{"ticker": t, "allocation": 0, "include_dividends": False} for t in tickers]
            lcfg["benchmark_ticker"] = "^GSPC"
            dates = rebalance_indices("Quarterly", d, e0)[:5]
            runners = [legacy_runner(L[s], d, lcfg, tickers) for s in range(S)]
            for r in dates:
                sc = window_scores(L, d, int(r), strat)
                self.assertIsNotNone(sc)
                M, valid = sc
                vol = aux.vol(d, int(r), strat.vol_window, strat.vol_exclude) if strat.calc_vol else None
                beta = aux.beta(d, int(r), strat.beta_window, strat.beta_exclude) if strat.calc_beta else None
                W = compute_weights(M, valid, vol, beta, strat)
                date = pd.Timestamp(d[r])
                for s in range(S):
                    calc_m, calc_w = runners[s]
                    rets, vlist = calc_m(date, set(tickers), lcfg["momentum_windows"], lcfg["stocks"])
                    self.assertEqual(sorted(vlist), sorted(tickers[j] for j in np.nonzero(valid[s])[0]), f"valid set differs (case {case})")
                    for j, t in enumerate(tickers):
                        if t in rets:
                            self.assertAlmostEqual(rets[t], M[s, j], places=10, msg=f"score differs (case {case})")
                    weights, _ = calc_w(rets, vlist, date, momentum_strategy=lcfg["momentum_strategy"],
                                        negative_momentum_strategy=lcfg["negative_momentum_strategy"], config=lcfg)
                    ref = np.array([weights.get(t, 0.0) for t in tickers])
                    diff = np.abs(ref - W[s]).max()
                    worst = max(worst, diff)
                    checked += 1
                    if rets and all(v <= 0 for v in rets.values()):
                        all_neg_rows += 1
                    self.assertLess(diff, 1e-9, f"weights differ (case {case}, sim {s}, date {date.date()}): {cfg['momentum_strategy']} / {cfg['negative_momentum_strategy']}\n"
                                    f"engine {np.round(ref, 4)}\nmc     {np.round(W[s], 4)}\n{ {k: v for k, v in raw.items() if k != 'momentum_windows'} }")
        print(f"\n  parity: {checked} (simulation, date) weight vectors identical to the engine "
              f"(max abs diff {worst:.2e}), {all_neg_rows} of them in the all-negative branch")
        self.assertGreater(all_neg_rows, 20)


if __name__ == "__main__":
    unittest.main()
