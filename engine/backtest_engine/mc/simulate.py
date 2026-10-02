"""Portfolio mechanics and metrics for a chunk of simulations (all vectorised over simulations)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .calendar import TDAYS, rebalance_indices
from .strategy import Strat, compute_weights, window_scores

FAN_STEP = 21  # trading days between the points kept for the equity fan chart


class Aux:
    """Prefix sums of simple returns, for rolling volatility / beta at any date in O(1)."""

    def __init__(self, logret: np.ndarray, need_vol: bool, need_beta: bool) -> None:
        S, T, N = logret.shape
        rs = np.expm1(logret)
        rs[:, 0, :] = 0.0
        self.need_vol, self.need_beta = need_vol, need_beta
        if need_vol or need_beta:
            self.ps1 = np.zeros((S, T + 1, N))
            np.cumsum(rs, axis=1, out=self.ps1[:, 1:, :])
        if need_vol:
            self.ps2 = np.zeros((S, T + 1, N))
            np.cumsum(rs * rs, axis=1, out=self.ps2[:, 1:, :])
        if need_beta:
            m = rs.mean(axis=2)  # equal-weight universe = the market of the simulation
            self.pm = np.zeros((S, T + 1))
            self.pmm = np.zeros((S, T + 1))
            self.pxm = np.zeros((S, T + 1, N))
            np.cumsum(m, axis=1, out=self.pm[:, 1:])
            np.cumsum(m * m, axis=1, out=self.pmm[:, 1:])
            np.cumsum(rs * m[:, :, None], axis=1, out=self.pxm[:, 1:, :])

    @staticmethod
    def _range(d: np.ndarray, r: int, window: int, exclude: int) -> tuple[int, int]:
        D = d[r]
        lo = int(np.searchsorted(d, D - np.timedelta64(int(window), "D"), side="left"))
        hi = int(np.searchsorted(d, D - np.timedelta64(int(exclude), "D"), side="right"))
        return lo, hi

    def vol(self, d: np.ndarray, r: int, window: int, exclude: int) -> np.ndarray:
        lo, hi = self._range(d, r, window, exclude)
        n = hi - lo
        if n < 2:
            return np.full(self.ps1[:, 0, :].shape, np.nan)
        s1 = self.ps1[:, hi, :] - self.ps1[:, lo, :]
        s2 = self.ps2[:, hi, :] - self.ps2[:, lo, :]
        var = np.maximum((s2 - s1 * s1 / n) / (n - 1), 0.0)
        return np.sqrt(var) * np.sqrt(365.25)  # same annualisation as the engine

    def beta(self, d: np.ndarray, r: int, window: int, exclude: int) -> np.ndarray:
        lo, hi = self._range(d, r, window, exclude)
        n = hi - lo
        if n < 2:
            return np.full(self.ps1[:, 0, :].shape, np.nan)
        sx = self.ps1[:, hi, :] - self.ps1[:, lo, :]
        sm = (self.pm[:, hi] - self.pm[:, lo])[:, None]
        sxm = self.pxm[:, hi, :] - self.pxm[:, lo, :]
        smm = (self.pmm[:, hi] - self.pmm[:, lo])[:, None]
        cov = (sxm - sx * sm / n) / (n - 1)          # np.cov: ddof = 1
        var = (smm - sm * sm / n) / n                # np.var: ddof = 0 (as in the engine)
        return np.divide(cov, var, out=np.full_like(cov, np.nan), where=var > 0)


@dataclass
class Universe:
    L: np.ndarray          # (S, T, N) cumulative log prices
    P: np.ndarray          # (S, T, N) prices (start at 1)
    d: np.ndarray          # (T,) trading days
    e0: int                # first allocation index
    aux: Aux


def build_universe(logret: np.ndarray, d: np.ndarray, e0: int, need_vol: bool, need_beta: bool) -> Universe:
    L = np.cumsum(logret, axis=1)
    return Universe(L=L, P=np.exp(L), d=d, e0=e0, aux=Aux(logret, need_vol, need_beta))


def simulate(strat: Strat, u: Universe, cost_bps: float = 0.0) -> dict[str, np.ndarray]:
    """Equity curves (S, Te) of one strategy on every simulated universe, starting at 1."""
    S, T, N = u.P.shape
    e0, d = u.e0, u.d
    reb = rebalance_indices(strat.freq, d, e0)
    E = np.empty((S, T - e0))
    V = np.ones(S)
    cost = cost_bps / 1e4
    Wdrift = None
    turn = np.zeros(S)
    hold = np.zeros(S)
    cashw_sum = np.zeros(S)
    equal = np.full((S, N), 1.0 / N)
    for k, r in enumerate(reb):
        end = int(reb[k + 1]) if k + 1 < len(reb) else T - 1
        if strat.mode == "equal":
            W = equal
        else:
            sc = window_scores(u.L, d, int(r), strat)
            if sc is None:
                W = np.zeros((S, N))
            else:
                M, valid = sc
                vol = u.aux.vol(d, int(r), strat.vol_window, strat.vol_exclude) if strat.calc_vol else None
                beta = u.aux.beta(d, int(r), strat.beta_window, strat.beta_exclude) if strat.calc_beta else None
                W = compute_weights(M, valid, vol, beta, strat)
        if k > 0:
            t = np.abs(W - Wdrift).sum(axis=1)
            turn += t
            if cost > 0:
                V = V * (1.0 - cost * t)
        cw = 1.0 - W.sum(axis=1)
        hold += (W > 1e-9).sum(axis=1)
        cashw_sum += cw
        seg = u.P[:, r:end + 1, :] / u.P[:, r:r + 1, :]
        inv = np.einsum("sn,stn->st", W, seg)
        if strat.cash_rate:
            cg = np.exp(strat.cash_rate * np.arange(end - r + 1) / TDAYS)[None, :]
        else:
            cg = 1.0
        grow = cw[:, None] * cg + inv
        path = V[:, None] * grow
        if k + 1 < len(reb):
            E[:, r - e0:end - e0] = path[:, :-1]
        else:
            E[:, r - e0:end - e0 + 1] = path
        Vend = path[:, -1]
        Wdrift = W * seg[:, -1, :] / np.maximum(grow[:, -1], 1e-300)[:, None]
        V = Vend
    nreb = len(reb)
    years = max((d[-1] - d[e0]).astype("timedelta64[D]").astype(int) / 365.25, 1e-9)
    return {
        "E": E,
        "avg_holdings": hold / nreb,
        "cash_pct": cashw_sum / nreb,
        "turnover": turn / 2.0 / years,   # one-way turnover per year (0 for buy & hold)
        "years": np.full(S, years),
    }


def metrics(E: np.ndarray, years: float, rf: float) -> dict[str, np.ndarray]:
    first, last = E[:, 0], E[:, -1]
    total = last / first - 1.0
    with np.errstate(divide="ignore", invalid="ignore"):
        cagr = np.where(last > 0, (last / first) ** (1.0 / years) - 1.0, -1.0)
        dr = E[:, 1:] / E[:, :-1] - 1.0
        mean_a = dr.mean(axis=1) * TDAYS
        vol = dr.std(axis=1, ddof=1) * np.sqrt(TDAYS)
        sharpe = np.where(vol > 0, (mean_a - rf) / vol, np.nan)
        dd_ = np.minimum(dr - rf / TDAYS, 0.0)
        down = np.sqrt((dd_ * dd_).mean(axis=1)) * np.sqrt(TDAYS)
        sortino = np.where(down > 0, (mean_a - rf) / down, np.nan)
        peak = np.maximum.accumulate(E, axis=1)
        mdd = (E / peak - 1.0).min(axis=1)
        calmar = np.where(mdd < 0, cagr / np.abs(mdd), np.nan)
    return {"total_return": total, "cagr": cagr, "max_dd": mdd, "vol": vol, "sharpe": sharpe,
            "sortino": sortino, "calmar": calmar}


def fan_points(Te: int) -> np.ndarray:
    idx = np.arange(0, Te, FAN_STEP)
    if idx[-1] != Te - 1:
        idx = np.append(idx, Te - 1)
    return idx
