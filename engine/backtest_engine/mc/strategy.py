"""Momentum strategy of a portfolio config, evaluated for many simulations at once.

The weight pipeline mirrors the engine's calculate_momentum / calculate_momentum_weights (see
tests/montecarlo/test_parity.py, which checks it against the real functions):

  score (classic or window-capped) -> Classic / Relative / Near-Zero Symmetry weights
  -> inverse volatility / beta -> top N -> equal weight -> max allocation -> minimum threshold
  -> max allocation.

Every array is (S simulations, N stocks): one numpy operation handles all simulations.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .calendar import asof


@dataclass
class Window:
    lookback: int
    exclude: int
    weight: float  # already normalised to sum to 1
    discard_if_negative: bool = False
    discard_unless_recent_positive: bool = False


@dataclass
class Strat:
    name: str
    mode: str = "momentum"            # "momentum" | "equal" (static equal weight of the universe)
    windows: list[Window] = field(default_factory=list)
    capped: bool = False              # window-capped score
    strategy: str = "Classic"         # Classic | Relative Momentum | Near-Zero Symmetry
    negative: str = "Cash"            # Cash | Equal weight | Relative momentum | Near-Zero Symmetry
    calc_vol: bool = False
    vol_window: int = 365
    vol_exclude: int = 30
    calc_beta: bool = False
    beta_window: int = 365
    beta_exclude: int = 30
    max_alloc: float | None = None    # fraction
    min_thr: float | None = None      # fraction
    top_n: int | None = None
    equal_n: int | None = None
    freq: str = "Monthly"
    cash_rate: float = 0.0            # annual yield of idle cash
    warnings: list[str] = field(default_factory=list)

    @property
    def max_days(self) -> int:
        days = [w.lookback for w in self.windows]
        if self.calc_vol:
            days.append(self.vol_window + 0)
        if self.calc_beta:
            days.append(self.beta_window + 0)
        return max(days) if days else 0

    @property
    def needs_vol(self) -> bool:
        return self.mode == "momentum" and self.calc_vol

    @property
    def needs_beta(self) -> bool:
        return self.mode == "momentum" and self.calc_beta


def _b(v: Any, default: bool = False) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes", "y", "on"}
    return bool(v) if v is not None else default


def parse_strategy(cfg: dict, risk_free: float = 0.02) -> Strat:
    """Reads a normalised portfolio config (backtest_engine.config.normalize_one)."""
    name = str(cfg.get("name", "Portfolio"))
    if (cfg.get("fusion_portfolio") or {}).get("enabled"):
        raise ValueError(f"« {name} » est un portfolio de fusion : non pris en charge par le Monte Carlo.")
    s = Strat(name=name, freq=str(cfg.get("rebalancing_frequency", "Monthly")))
    w = s.warnings
    s.cash_rate = float(risk_free) if _b(cfg.get("idle_cash_earns_treasury_yield")) else 0.0

    if not _b(cfg.get("use_momentum", True), True):
        s.mode = "equal"
        w.append("Sans momentum : l’univers simulé est détenu à parts égales.")
    else:
        wins = [x for x in (cfg.get("momentum_windows") or []) if isinstance(x, dict) and float(x.get("weight", 0) or 0) > 0]
        total = sum(float(x["weight"]) for x in wins)
        if not wins or total <= 0:
            raise ValueError(f"« {name} » : aucune fenêtre de momentum avec un poids positif.")
        s.windows = [
            Window(int(x["lookback"]), int(x["exclude"]), float(x["weight"]) / total,
                   _b(x.get("discard_if_negative")), _b(x.get("discard_unless_recent_positive")))
            for x in wins
        ]
        s.capped = _b(cfg.get("use_window_capped_score"))
        ms = cfg.get("momentum_strategy", "Classic")
        s.strategy = ms if ms in ("Classic", "Relative Momentum", "Near-Zero Symmetry") else "Classic"
        ns = cfg.get("negative_momentum_strategy", "Cash")
        s.negative = ns if ns in ("Cash", "Equal weight", "Relative momentum", "Near-Zero Symmetry") else "Cash"
        s.calc_vol = _b(cfg.get("calc_volatility"))
        s.vol_window = int(cfg.get("vol_window_days", 365) or 365)
        s.vol_exclude = int(cfg.get("exclude_days_vol", 30) or 0)
        s.calc_beta = _b(cfg.get("calc_beta"))
        s.beta_window = int(cfg.get("beta_window_days", 365) or 365)
        s.beta_exclude = int(cfg.get("exclude_days_beta", 30) or 0)
        if s.calc_beta:
            w.append("Bêta mesuré contre l’indice équipondéré de l’univers simulé (pas de vrai indice).")
        if _b(cfg.get("use_max_allocation")):
            s.max_alloc = float(cfg.get("max_allocation_percent", 20.0)) / 100.0
        if _b(cfg.get("use_minimal_threshold")):
            s.min_thr = float(cfg.get("minimal_threshold_percent", 4.0)) / 100.0
        if _b(cfg.get("use_limit_to_top_n")) and int(cfg.get("limit_to_top_n_tickers", 10) or 0) > 0:
            s.top_n = int(cfg.get("limit_to_top_n_tickers", 10))
        if _b(cfg.get("use_equal_weight")) and int(cfg.get("equal_weight_n_tickers", 10) or 0) > 0:
            s.equal_n = int(cfg.get("equal_weight_n_tickers", 10))

    ignored = [
        ("use_sma_filter", "Filtre de moyenne mobile ignoré"),
        ("ma_cross_rebalance", "Rebalancement sur croisement de moyenne mobile ignoré"),
        ("use_sector_concentration_limit", "Limite par secteur ignorée (l’univers simulé n’a pas de secteurs)"),
        ("use_industry_concentration_limit", "Limite par industrie ignorée (l’univers simulé n’a pas d’industries)"),
        ("use_min_market_cap_filter", "Filtre de capitalisation ignoré"),
        ("exclude_before_sp500_entry", "Exclusion avant l’entrée au S&P 500 ignorée"),
        ("use_targeted_rebalancing", "Rebalancement ciblé ignoré"),
    ]
    for key, msg in ignored:
        if _b(cfg.get(key)):
            w.append(msg)
    if float(cfg.get("added_amount", 0) or 0) > 0:
        w.append("Ajouts périodiques ignorés : le capital initial est investi d’un coup.")
    if any(isinstance(x, dict) and x.get("max_allocation_percent") for x in (cfg.get("stocks") or [])):
        w.append("Plafonds par titre ignorés (les titres sont générés).")
    return s


# --------------------------------------------------------------------------------------------
# scores
# --------------------------------------------------------------------------------------------

def window_scores(L: np.ndarray, d: np.ndarray, r: int, s: Strat) -> tuple[np.ndarray, np.ndarray] | None:
    """Momentum score (S, N) and validity (S, N) at rebalance index r.
    L: (S, T, N) cumulative log prices. None when a window reaches before the first day."""
    D = d[r]
    rets: list[np.ndarray] = []
    valid = np.ones(L.shape[0:1] + L.shape[2:], dtype=bool)
    for win in s.windows:
        si = asof(d, D - np.timedelta64(win.lookback, "D"))
        ei = asof(d, D - np.timedelta64(win.exclude, "D"))
        if si < 0 or ei < 0:
            return None
        ret = np.expm1(L[:, ei, :] - L[:, si, :])
        if win.discard_if_negative:
            neg = ret < 0
            if win.discard_unless_recent_positive:
                recent = np.expm1(L[:, r, :] - L[:, ei, :])
                neg &= ~(recent > 0)
            valid &= ~neg
        rets.append(ret)

    if not s.capped:
        M = np.zeros_like(rets[0])
        for ret, win in zip(rets, s.windows):
            M += ret * win.weight
        return M, valid

    M = np.zeros_like(rets[0])
    for ret, win in zip(rets, s.windows):
        rv = np.where(valid, ret, 0.0)  # invalid assets do not set the best / worst of the window
        best = np.maximum(rv.max(axis=1), 0.0)[:, None]
        worst = np.minimum(rv.min(axis=1), 0.0)[:, None]
        with np.errstate(divide="ignore", invalid="ignore"):
            pos = np.where((ret > 0) & (best > 0), ret / best, 0.0)
            neg = np.where((ret < 0) & (worst < 0), ret / np.abs(worst), 0.0)
        M += win.weight * (pos + neg)
    return M, valid


# --------------------------------------------------------------------------------------------
# weights
# --------------------------------------------------------------------------------------------

def _norm_rows(w: np.ndarray) -> np.ndarray:
    s = w.sum(axis=1, keepdims=True)
    return np.divide(w, s, out=np.zeros_like(w), where=s > 0)


def _relative(M: np.ndarray, valid: np.ndarray, always_offset: bool) -> np.ndarray:
    mn = np.where(valid, M, np.inf).min(axis=1, keepdims=True)
    mn = np.where(np.isfinite(mn), mn, 0.0)
    offset = (-mn + 0.01) if always_offset else np.where(mn < 0, -mn + 0.01, 0.01)
    shifted = np.where(valid, np.maximum(0.01, M + offset), 0.0)
    return _norm_rows(shifted)


def _nzs(M: np.ndarray, valid: np.ndarray, zone: float = 0.05) -> np.ndarray:
    mn = np.where(valid, M, np.inf).min(axis=1, keepdims=True)
    mn = np.where(np.isfinite(mn), mn, 0.0)
    offset = np.where(mn < 0, -mn + 0.01, 0.01)
    shifted = np.maximum(0.01, M + offset)
    a = np.abs(M)
    comp = np.where(a <= zone, 1.0 - (a / zone) * 0.1,
                    np.where(M < -zone, 0.9 * np.exp(-(a - zone) * 3.0), 1.0))
    return _norm_rows(np.where(valid, shifted * comp, 0.0))


def _cap_pass(w: np.ndarray, cap: float) -> np.ndarray:
    capped = np.minimum(w, cap)
    excess = (w - capped).sum(axis=1)
    elig = capped < cap
    tot = (capped * elig).sum(axis=1)
    ok = (excess > 0) & (tot > 0)
    frac = np.divide(capped * elig, tot[:, None], out=np.zeros_like(w), where=(tot > 0)[:, None])
    new = capped + excess[:, None] * frac * ok[:, None]
    new = np.where(elig & ok[:, None], np.minimum(new, cap), new)
    return _norm_rows(new)


def _thr_pass(w: np.ndarray, thr: float) -> np.ndarray:
    keep = w >= thr
    anykeep = keep.any(axis=1, keepdims=True)
    return np.where(anykeep, _norm_rows(np.where(keep, w, 0.0)), w)


def _top_mask(w: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Mask of the n largest strictly-positive weights per row (ties keep the original order),
    and the count of positive weights."""
    pos = w > 0
    key = np.where(pos, -w, np.inf)
    order = np.argsort(key, axis=1, kind="stable")
    rank = np.empty_like(order)
    np.put_along_axis(rank, order, np.arange(w.shape[1])[None, :].repeat(w.shape[0], 0), axis=1)
    npos = pos.sum(axis=1)
    take = np.minimum(n, npos)
    return (rank < take[:, None]) & pos, npos


def compute_weights(M: np.ndarray, valid: np.ndarray, vol: np.ndarray | None, beta: np.ndarray | None, s: Strat) -> np.ndarray:
    """Target weights (S, N); a row sums to 1, or to 0 when the portfolio goes to cash."""
    nvalid = valid.sum(axis=1)
    has = nvalid > 0
    Mv = np.where(valid, M, -np.inf)
    all_neg = (Mv <= 0).all(axis=1) & has

    # base weights ------------------------------------------------------------------------------
    pos = np.where(valid & (M > 0), M, 0.0)
    if s.strategy == "Relative Momentum":
        w_pos = _relative(M, valid, always_offset=False)
    elif s.strategy == "Near-Zero Symmetry":
        w_pos = _nzs(M, valid)
    else:
        w_pos = _norm_rows(pos)

    if s.negative == "Cash":
        w_neg = np.zeros_like(M)
    elif s.negative == "Equal weight":
        w_neg = np.where(valid, 1.0 / np.maximum(nvalid, 1)[:, None], 0.0)
    elif s.negative == "Relative momentum":
        w_neg = _relative(M, valid, always_offset=True)
    else:
        w_neg = _nzs(M, valid)
    w = np.where(all_neg[:, None], w_neg, w_pos)
    w = np.where(has[:, None], w, 0.0)

    # inverse volatility / beta (not applied to the all-negative Equal weight fallback) --------------
    if (s.calc_vol or s.calc_beta) and (vol is not None or beta is not None):
        score = np.ones_like(w)
        if s.calc_vol and vol is not None:
            ok = np.isfinite(vol) & (vol > 0)
            score = score * np.where(ok, 1.0 / np.where(ok, vol, 1.0), 1.0)
        if s.calc_beta and beta is not None:
            ok = np.isfinite(beta) & (beta != 0)
            score = score * np.where(ok, 1.0 / np.where(ok, np.abs(beta), 1.0), 1.0)
        filt = w * score
        ssum = filt.sum(axis=1, keepdims=True)
        skip = (all_neg & (s.negative == "Equal weight"))[:, None]
        w = np.where((ssum > 0) & ~skip, filt / np.where(ssum > 0, ssum, 1.0), w)

    # top N / equal weight ----------------------------------------------------------------------------
    rel_neg = s.negative in ("Relative momentum", "Near-Zero Symmetry")
    applicable = has & (~all_neg | rel_neg)
    topn_applied = np.zeros(w.shape[0], dtype=bool)
    if s.top_n:
        mask, npos = _top_mask(w, s.top_n)
        topn_applied = applicable & (npos > 0)
        kept = np.where(mask, w, 0.0)
        sel = _norm_rows(kept)
        w = np.where(topn_applied[:, None], sel, w)
    if s.equal_n:
        pos_now = w > 0
        npos_now = pos_now.sum(axis=1)
        mask, _ = _top_mask(w, s.equal_n)
        chosen = np.where(topn_applied[:, None], pos_now, mask)
        k = chosen.sum(axis=1)
        eq = np.where(chosen, 1.0 / np.maximum(k, 1)[:, None], 0.0)
        do = applicable & (npos_now > 0) & (k > 0)
        w = np.where(do[:, None], eq, w)

    # allocation limits ------------------------------------------------------------------------------------
    if s.max_alloc is not None:
        w = np.where(has[:, None], _cap_pass(w, s.max_alloc), w)
    if s.min_thr is not None:
        w = np.where(has[:, None], _thr_pass(w, s.min_thr), w)
    if s.max_alloc is not None:
        w = np.where(has[:, None], _cap_pass(w, s.max_alloc), w)
    return w
