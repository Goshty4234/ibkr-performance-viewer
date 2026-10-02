"""Monte Carlo engine: mechanics (costs, cash, drift), metrics, calendar, determinism, statistics."""

from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from backtest_engine.mc.calendar import TDAYS, make_calendar, rebalance_indices
from backtest_engine.mc.generate import SYNTHETIC_DEFAULTS, bootstrap_returns, rng_for, synthetic_returns
from backtest_engine.mc.run import clean_options, plan_chunks, run_chunk, run_montecarlo
from backtest_engine.mc.simulate import build_universe, metrics, simulate
from backtest_engine.mc.strategy import Strat, Window, compute_weights, window_scores

WINS = [Window(365, 30, 0.5), Window(180, 30, 0.3), Window(120, 30, 0.2)]


def _universe(S=3, N=8, years=3.0, seed=1, need_vol=True, need_beta=True):
    d, e0 = make_calendar(years, 400)
    T = len(d)
    lr = np.stack([synthetic_returns(rng_for(seed, i), T, N, SYNTHETIC_DEFAULTS) for i in range(S)])
    return build_universe(lr, d, e0, need_vol, need_beta), lr


def _weights_for_sim(strat, u, s, r):
    """Weights of ONE simulation, obtained from a 1-sim universe (independent of batching)."""
    if strat.mode == "equal":
        return np.full(u.P.shape[2], 1.0 / u.P.shape[2])
    u1 = type(u)(L=u.L[s:s + 1], P=u.P[s:s + 1], d=u.d, e0=u.e0, aux=None)
    sc = window_scores(u1.L, u.d, r, strat)
    if sc is None:
        return np.zeros(u.P.shape[2])
    M, valid = sc
    return compute_weights(M, valid, None, None, strat)[0]


class Mechanics(unittest.TestCase):
    def reference(self, strat, u, s, cost_bps):
        """Slow day-by-day shares/cash simulation of one simulated universe."""
        d, e0 = u.d, u.e0
        T = len(d)
        reb = list(rebalance_indices(strat.freq, d, e0))
        P = u.P[s]
        cash_daily = np.exp(strat.cash_rate / TDAYS)
        value = 1.0
        shares = np.zeros(P.shape[1])
        cash = 1.0
        out = []
        prev_w = None
        for t in range(e0, T):
            if t > e0:
                cash *= cash_daily
            if t in reb:
                held = shares * P[t]
                value = cash + held.sum()
                w = _weights_for_sim(strat, u, s, t)
                if prev_w is not None:
                    turn = np.abs(w - held / value).sum()
                    value *= 1 - cost_bps / 1e4 * turn
                shares = w * value / P[t]
                cash = value * (1 - w.sum())
                prev_w = w
            out.append(cash + (shares * P[t]).sum())
        return np.array(out)

    def check(self, strat, cost_bps):
        u, _ = _universe(S=3, N=8, years=3.0, need_vol=False, need_beta=False)
        res = simulate(strat, u, cost_bps)
        for s in range(3):
            ref = self.reference(strat, u, s, cost_bps)
            np.testing.assert_allclose(res["E"][s], ref, rtol=1e-9, atol=1e-12)

    def test_plain_monthly(self):
        self.check(Strat(name="a", windows=WINS, top_n=3, freq="Monthly"), 0.0)

    def test_costs_and_cash(self):
        self.check(Strat(name="b", windows=WINS, top_n=3, freq="Quarterly", cash_rate=0.03, max_alloc=0.4), 25.0)

    def test_buy_and_hold(self):
        self.check(Strat(name="c", windows=WINS, freq="Buy & Hold"), 50.0)

    def test_equal_weight(self):
        self.check(Strat(name="e", mode="equal", freq="Monthly"), 10.0)


class Metrics(unittest.TestCase):
    def test_against_pandas(self):
        rng = np.random.default_rng(3)
        E = np.exp(np.cumsum(rng.normal(0.0004, 0.01, (4, 700)), axis=1))
        years, rf = 700 / TDAYS, 0.02
        m = metrics(E, years, rf)
        for i in range(4):
            s = pd.Series(E[i])
            dr = s.pct_change().dropna()
            self.assertAlmostEqual(m["total_return"][i], s.iloc[-1] / s.iloc[0] - 1)
            self.assertAlmostEqual(m["cagr"][i], (s.iloc[-1] / s.iloc[0]) ** (1 / years) - 1)
            self.assertAlmostEqual(m["max_dd"][i], (s / s.cummax() - 1).min())
            self.assertAlmostEqual(m["vol"][i], dr.std() * np.sqrt(TDAYS))
            self.assertAlmostEqual(m["sharpe"][i], (dr.mean() * TDAYS - rf) / (dr.std() * np.sqrt(TDAYS)))


class Calendar(unittest.TestCase):
    def test_rebalance_dates_vs_pandas(self):
        d, e0 = make_calendar(6, 400)
        s = pd.Series(1, index=pd.DatetimeIndex(d))
        for freq, months in (("Monthly", None), ("Quarterly", {1, 4, 7, 10}), ("Annually", {1}), ("Semiannually", {1, 7})):
            idx = rebalance_indices(freq, d, e0)
            self.assertEqual(idx[0], e0)
            first = s.groupby([s.index.year, s.index.month]).head(1).index
            if months:
                first = [x for x in first if x.month in months]
            exp = [x for x in first if x > pd.Timestamp(d[e0])]
            got = [pd.Timestamp(d[i]) for i in idx[1:]]
            self.assertEqual(got, exp, freq)
        self.assertEqual(len(rebalance_indices("Buy & Hold", d, e0)), 1)

    def test_calendar_is_trading_days(self):
        d, e0 = make_calendar(10, 400)
        wd = pd.DatetimeIndex(d).dayofweek
        self.assertTrue((wd < 5).all())
        per_year = (len(d) - e0) / 10
        self.assertAlmostEqual(per_year, 252, delta=1)


class Determinism(unittest.TestCase):
    PORTS = [
        {"name": "A", "stocks": [], "use_momentum": True, "momentum_windows": [{"lookback": 180, "exclude": 20, "weight": 1}],
         "use_limit_to_top_n": True, "limit_to_top_n_tickers": 4, "calc_volatility": True},
        {"name": "B", "stocks": [], "use_momentum": True, "use_window_capped_score": True,
         "momentum_windows": [{"lookback": 365, "exclude": 30, "weight": .6}, {"lookback": 90, "exclude": 10, "weight": .4}],
         "calc_beta": True, "use_max_allocation": True, "max_allocation_percent": 30},
    ]
    OPT = {"n_sims": 17, "n_assets": 10, "years": 3, "seed": 7, "cost_bps": 5}

    def test_independent_of_workers_and_chunks(self):
        a = run_montecarlo(self.PORTS, self.OPT, workers=1)
        b = run_montecarlo(self.PORTS, self.OPT, workers=3)
        for sa, sb in zip(a["series"], b["series"]):
            for k in sa["metrics"]:
                self.assertEqual(sa["metrics"][k], sb["metrics"][k], (sa["name"], k))
            self.assertEqual(sa["fan"], sb["fan"])
        self.assertEqual(a["pairwise_cagr"], b["pairwise_cagr"])

    def test_seed_changes_result(self):
        a = run_montecarlo(self.PORTS, self.OPT, workers=1)
        b = run_montecarlo(self.PORTS, {**self.OPT, "seed": 8}, workers=1)
        self.assertNotEqual(a["series"][0]["metrics"]["cagr"], b["series"][0]["metrics"]["cagr"])

    def test_cancel(self):
        from backtest_engine.mc.run import MonteCarloCancelled
        with self.assertRaises(MonteCarloCancelled):
            run_montecarlo(self.PORTS, self.OPT, workers=1, cancelled=lambda: True)

    def test_chunk_plan_covers_all(self):
        st = [Strat(name="x", windows=WINS, calc_vol=True, calc_beta=True)]
        for S, w in ((1, 1), (17, 3), (5000, 8)):
            ch = plan_chunks(S, 4000, 50, st, w)
            self.assertEqual(sum(n for _, n in ch), S)
            self.assertEqual([a for a, _ in ch], sorted(a for a, _ in ch))

    def test_options_clamped(self):
        o = clean_options({"n_sims": 10**9, "n_assets": 1, "years": 500, "cost_bps": -3})
        self.assertEqual((o["n_sims"], o["n_assets"], o["years"], o["cost_bps"]), (50000, 2, 50.0, 0.0))


class Statistics(unittest.TestCase):
    def test_generator_moments(self):
        T, N = 252 * 20, 30
        r = synthetic_returns(rng_for(1, 0), T, N, SYNTHETIC_DEFAULTS)
        ann_mkt = r.mean(axis=1).mean() * TDAYS
        self.assertTrue(-0.1 < ann_mkt < 0.25, ann_mkt)
        vol = r.std(axis=0) * np.sqrt(TDAYS)
        self.assertTrue(0.15 < np.median(vol) < 0.6, np.median(vol))
        z = (r - r.mean(0)) / r.std(0)
        self.assertGreater(float((z ** 4).mean()), 4.0)  # fat tails

    def test_null_world_no_edge_vs_alpha_world(self):
        port = [{"name": "M", "stocks": [], "use_momentum": True,
                 "momentum_windows": [{"lookback": 180, "exclude": 20, "weight": 1}],
                 "use_limit_to_top_n": True, "limit_to_top_n_tickers": 5}]
        base = {"n_sims": 120, "n_assets": 30, "years": 8, "seed": 5}
        null = run_montecarlo(port, {**base, "synthetic": {"alpha_sd": 0.0}}, workers=2)
        alpha = run_montecarlo(port, {**base, "synthetic": {"alpha_sd": 0.25, "alpha_halflife_days": 250}}, workers=2)
        edge = lambda r: r["series"][0]["summary"]["cagr"]["mean"] - r["series"][2]["summary"]["cagr"]["mean"]
        self.assertGreater(edge(alpha), edge(null) + 0.02)
        self.assertLess(abs(edge(null)), 0.04)

    def test_bootstrap_uses_panel(self):
        rng = np.random.default_rng(0)
        panel = rng.normal(0.0003, 0.012, (3000, 12))
        r = bootstrap_returns(rng_for(1, 0), 1000, 6, panel, panel.mean(0), {"block_days": 21, "demean": True})
        self.assertEqual(r.shape, (1000, 6))
        self.assertTrue(np.isfinite(r).all())
        self.assertAlmostEqual(float(r.std()), float(panel.std()), delta=0.003)


if __name__ == "__main__":
    unittest.main()
