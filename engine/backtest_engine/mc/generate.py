"""Random stock universes: daily LOG returns of shape (T, N) for one simulation.

Every simulation owns its random stream, seeded by (seed, simulation index), so a result never
depends on how simulations are split between workers.

synthetic  factor model with fat tails, crisis regimes, rare extreme events and an optional
           slowly fading "alpha" per stock (alpha_sd = 0: nobody is better than the others, so
           momentum has nothing to find; > 0: winners persist for a while).
bootstrap  real daily returns of stored stocks, resampled in blocks of consecutive days. All
           stocks of a simulation share the same blocks, so the real co-movement, crashes and
           volatility clusters are kept; demean=True removes each stock's own average return
           (no persistent winners, no survivorship drift).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from .calendar import TDAYS

SYNTHETIC_DEFAULTS: dict[str, float] = {
    "market_mu": 0.07,          # expected annual market return
    "rf": 0.02,                 # risk-free rate used by the drift model
    "market_vol": 0.16,
    "beta_sd": 0.30,
    "idio_vol": 0.28,           # median annual idiosyncratic volatility
    "idio_vol_dispersion": 0.40,
    "alpha_sd": 0.0,            # annual sd of the persistent alpha across stocks (0 = none)
    "alpha_halflife_days": 250.0,
    "tail_df": 4.0,             # Student-t degrees of freedom of stock shocks (lower = fatter tails)
    "market_tail_df": 6.0,
    "crisis_per_year": 0.30,
    "crisis_days": 90.0,
    "crisis_vol_mult": 2.2,
    "crisis_drift": -0.35,      # extra annual market drift during a crisis
    "extreme_per_year": 0.02,   # chance per stock-year of a one-day jump
    "extreme_up_share": 0.55,
}

BOOTSTRAP_DEFAULTS: dict[str, Any] = {"block_days": 21, "demean": True}


def rng_for(seed: int, sim: int) -> np.random.Generator:
    return np.random.default_rng(np.random.SeedSequence([int(seed) & 0xFFFFFFFF, int(sim)]))


def _regime(rng: np.random.Generator, T: int, p_in: float, p_out: float) -> np.ndarray:
    out = np.zeros(T, dtype=bool)
    t, state = 0, False
    while t < T:
        p = p_out if state else p_in
        n = int(rng.geometric(min(max(p, 1e-9), 1.0)))
        if state:
            out[t:t + n] = True
        t += n
        state = not state
    return out


def _unit_t(rng: np.random.Generator, df: float, size: Any) -> np.ndarray:
    df = max(float(df), 2.05)
    return rng.standard_t(df, size) / np.sqrt(df / (df - 2.0))


def synthetic_returns(rng: np.random.Generator, T: int, N: int, params: dict[str, Any] | None = None) -> np.ndarray:
    p = {**SYNTHETIC_DEFAULTS, **(params or {})}
    D = float(TDAYS)
    crisis = _regime(rng, T, p["crisis_per_year"] / D, 1.0 / max(p["crisis_days"], 1.0))
    vol_mult = np.where(crisis, p["crisis_vol_mult"], 1.0)

    m_vol_d = p["market_vol"] / np.sqrt(D)
    m = _unit_t(rng, p["market_tail_df"], T) * m_vol_d * vol_mult + crisis * (p["crisis_drift"] / D)

    beta = np.clip(rng.normal(1.0, p["beta_sd"], N), 0.2, 2.5)
    idio_d = p["idio_vol"] * np.exp(rng.normal(0.0, p["idio_vol_dispersion"], N)) / np.sqrt(D)
    eps = _unit_t(rng, p["tail_df"], (T, N)) * idio_d[None, :] * np.sqrt(vol_mult)[:, None]

    mu_d = (p["rf"] + beta * (p["market_mu"] - p["rf"])) / D - 0.5 * ((beta * m_vol_d) ** 2 + idio_d ** 2)
    r = beta[None, :] * m[:, None] + eps + mu_d[None, :]

    if p["alpha_sd"] > 0:
        from scipy.signal import lfilter

        phi = 0.5 ** (1.0 / max(p["alpha_halflife_days"], 1.0))
        burn = int(4 * p["alpha_halflife_days"])
        noise = rng.standard_normal((T + burn, N))
        alpha = lfilter([np.sqrt(1.0 - phi * phi) * p["alpha_sd"]], [1.0, -phi], noise, axis=0)[burn:]
        r += alpha / D

    if p["extreme_per_year"] > 0:
        hit = rng.random((T, N)) < p["extreme_per_year"] / D
        k = int(hit.sum())
        if k:
            up = rng.random(k) < p["extreme_up_share"]
            size = np.where(up, np.log(rng.uniform(1.5, 4.0, k)), np.log(1.0 - rng.uniform(0.30, 0.85, k)))
            r[hit] += size
    r[0] = 0.0
    return r


def bootstrap_returns(rng: np.random.Generator, T: int, N: int, panel: np.ndarray, col_mean: np.ndarray,
                      params: dict[str, Any] | None = None) -> np.ndarray:
    p = {**BOOTSTRAP_DEFAULTS, **(params or {})}
    rows, M = panel.shape
    B = int(min(max(int(p["block_days"]), 2), rows))
    if N > M:
        raise ValueError(f"L'univers demandé ({N} actions) dépasse les {M} actions réelles disponibles pour le rééchantillonnage.")
    nb = int(np.ceil(T / B))
    starts = rng.integers(0, rows - B + 1, nb)
    idx = (starts[:, None] + np.arange(B)[None, :]).ravel()[:T]
    cols = rng.choice(M, N, replace=False)
    R = np.take(panel, idx, axis=0)[:, cols].astype(np.float64)
    if p["demean"]:
        R = R - col_mean[cols][None, :] + float(col_mean.mean())
    out = np.log1p(np.maximum(R, -0.999999))
    out[0] = 0.0
    return out
