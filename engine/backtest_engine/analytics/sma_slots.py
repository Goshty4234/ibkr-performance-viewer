"""Sticky SMA slot holdings: hold N names until each breaks its MA on a rebalance day.

Survivors keep their dollar amounts (no top-N reshuffle). Freed cash fills empty
slots with the best outsider momentum still above its MA.
"""

from __future__ import annotations

from typing import Any, Callable, Iterable

SLOT_CFG_KEYS = ("use_sma_slot_hold", "sma_slot_count")


def slot_hold_enabled(cfg: dict | None) -> bool:
    return bool(cfg) and bool(cfg.get("use_sma_slot_hold", False))


def strip_slot_identity(cfg: dict) -> dict:
    if cfg.get("use_sma_slot_hold"):
        return cfg
    return {k: v for k, v in cfg.items() if k not in SLOT_CFG_KEYS}


def slot_count(cfg: dict) -> int:
    try:
        n = int(float(cfg.get("sma_slot_count") or 10))
    except (TypeError, ValueError):
        n = 10
    return n if n > 0 else 10


def max_weight_cap(cfg: dict) -> float | None:
    if not cfg.get("use_max_allocation"):
        return None
    try:
        pct = float(cfg.get("max_allocation_percent", 20) or 20)
    except (TypeError, ValueError):
        pct = 20.0
    if pct <= 0:
        return None
    return min(pct / 100.0, 1.0)


def above_ma(ticker: str, date: Any, ma_filter_data: dict | None) -> bool:
    """True when the precomputed MA table says the name is eligible (Close >= MA)."""
    if ma_filter_data is None:
        return True
    day = ma_filter_data.get(date)
    if day is None:
        return True
    return bool(day.get(ticker, True))


def rank_outsiders(
    scores: dict[str, float],
    held: Iterable[str],
    *,
    eligible: Callable[[str], bool],
) -> list[str]:
    """Best momentum first among names not held and still eligible (above MA, etc.)."""
    held_set = set(held)
    ranked = sorted(
        ((t, s) for t, s in scores.items() if t not in held_set and eligible(t)),
        key=lambda kv: kv[1],
        reverse=True,
    )
    return [t for t, _ in ranked]


def apply_entry_caps(
    buy_budget: float,
    entrants: list[str],
    current_values: dict[str, float],
    total_portfolio: float,
    cap: float | None,
) -> tuple[dict[str, float], float]:
    """Split ``buy_budget`` across ``entrants`` equally, respecting ``cap`` of total.

    Returns (additions_by_ticker, leftover_cash). Excess beyond caps is first offered
    to other entrants still under the cap, then returned as leftover for survivors.
    """
    if buy_budget <= 0 or not entrants:
        return {}, max(0.0, buy_budget)
    additions = {t: 0.0 for t in entrants}
    leftover = float(buy_budget)
    total = max(float(total_portfolio), 1e-12)
    # Iteratively pour into entrants under the room left to the cap.
    guard = 0
    while leftover > 0.01 and guard < 20:
        guard += 1
        room = {}
        for t in entrants:
            have = float(current_values.get(t, 0.0)) + additions[t]
            if cap is None:
                room[t] = leftover  # no per-name ceiling inside this pass
            else:
                room[t] = max(0.0, cap * total - have)
        open_names = [t for t, r in room.items() if r > 0.01]
        if not open_names:
            break
        share = leftover / len(open_names)
        spent = 0.0
        for t in open_names:
            take = min(share, room[t])
            additions[t] += take
            spent += take
        leftover -= spent
        if spent < 0.01:
            break
    return additions, max(0.0, leftover)


def redistribute_to_survivors(
    cash: float,
    survivors: list[str],
    values: dict[str, float],
    total_portfolio: float,
    cap: float | None,
) -> tuple[dict[str, float], float]:
    """Pour leftover cash into survivors furthest below the cap (equal among those with room)."""
    if cash <= 0.01 or not survivors:
        return {}, max(0.0, cash)
    additions = {t: 0.0 for t in survivors}
    leftover = float(cash)
    total = max(float(total_portfolio), 1e-12)
    guard = 0
    while leftover > 0.01 and guard < 20:
        guard += 1
        room = {}
        for t in survivors:
            have = float(values.get(t, 0.0)) + additions[t]
            if cap is None:
                room[t] = leftover
            else:
                room[t] = max(0.0, cap * total - have)
        open_names = [t for t, r in room.items() if r > 0.01]
        if not open_names:
            break
        # Prefer names with the most remaining room (furthest under the cap).
        open_names.sort(key=lambda t: room[t], reverse=True)
        share = leftover / len(open_names)
        spent = 0.0
        for t in open_names:
            take = min(share, room[t])
            additions[t] += take
            spent += take
        leftover -= spent
        if spent < 0.01:
            break
    return additions, max(0.0, leftover)


def sticky_rebalance(
    *,
    held: list[str],
    values: dict[str, float],
    unallocated_cash: float,
    unreinvested_cash: float,
    n_slots: int,
    scores: dict[str, float],
    keep_fn: Callable[[str], bool],
    enter_fn: Callable[[str], bool] | None = None,
    cap: float | None,
    force_init: bool = False,
) -> tuple[list[str], dict[str, float], float, float]:
    """One sticky-slot rebalance step.

    - Sell held names failing ``keep_fn`` (typically below MA), or everything on force_init.
    - Survivors keep dollar amounts.
    - Fill empty slots with best outsiders passing ``enter_fn`` (default: keep_fn).
    - Cap applies to new deployments only; leftover goes to survivors under the cap, else cash.
    """
    cash = float(unallocated_cash) + float(unreinvested_cash)
    new_values = {t: float(v) for t, v in values.items()}
    enter = enter_fn or keep_fn

    if force_init:
        for t in list(new_values):
            cash += new_values.get(t, 0.0)
            new_values[t] = 0.0
        held = []

    survivors: list[str] = []
    for t in held:
        if keep_fn(t) and new_values.get(t, 0.0) > 0.01:
            survivors.append(t)
        else:
            cash += new_values.get(t, 0.0)
            new_values[t] = 0.0

    need = max(0, int(n_slots) - len(survivors))
    candidates = rank_outsiders(scores, survivors, eligible=enter)
    entrants = candidates[:need]

    total = sum(new_values.get(t, 0.0) for t in survivors) + cash
    buy_budget = cash
    additions, leftover = apply_entry_caps(buy_budget, entrants, new_values, total, cap)
    for t, add in additions.items():
        if add > 0:
            new_values[t] = new_values.get(t, 0.0) + add
    cash = leftover

    if cash > 0.01 and survivors:
        # Rebuild total after entries so caps stay consistent with final book.
        total = sum(new_values.values()) + cash
        more, cash = redistribute_to_survivors(cash, survivors, new_values, total, cap)
        for t, add in more.items():
            if add > 0:
                new_values[t] = new_values.get(t, 0.0) + add

    new_held = [t for t in survivors + entrants if new_values.get(t, 0.0) > 0.01]
    # Zero names not held.
    for t in list(new_values):
        if t not in new_held:
            new_values[t] = 0.0
    return new_held, new_values, float(cash), 0.0
