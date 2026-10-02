"""Real daily returns used by the "bootstrap" generator (resampling of the tickers stored locally)."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

MIN_ROWS = 750          # a ticker needs about 3 years of history
MAX_TICKERS = 400
CLIP = 0.5              # a daily move beyond ±50 % is a data error far more often than a real move


def panel_from_frames(frames: dict[str, pd.DataFrame], min_rows: int = MIN_ROWS) -> tuple[np.ndarray, list[str]]:
    """(rows, tickers) matrix of total-return daily returns, from [Close, Dividends] frames.

    Only dates where at least half of the tickers trade are kept; missing days count as 0 %."""
    cols: dict[str, pd.Series] = {}
    for t, df in frames.items():
        if not isinstance(df, pd.DataFrame) or "Close" not in df:
            continue
        close = pd.to_numeric(df["Close"], errors="coerce")
        close = close[close > 0].dropna()
        if len(close) < min_rows:
            continue
        div = pd.to_numeric(df["Dividends"], errors="coerce").reindex(close.index).fillna(0.0) if "Dividends" in df else 0.0
        r = (close + div) / close.shift(1) - 1.0
        cols[t] = r.iloc[1:].clip(-CLIP, CLIP)
    if not cols:
        raise ValueError("Aucun ticker stocké avec assez d’historique (≥ 3 ans) pour le rééchantillonnage.")
    wide = pd.DataFrame(cols).sort_index()
    wide = wide[wide.notna().mean(axis=1) >= 0.5].fillna(0.0)
    names = list(wide.columns)
    return wide.to_numpy(dtype=np.float64), names


def load_panel_from_store(folder: Path, tickers: list[str] | None = None) -> tuple[str, int, int]:
    """Builds (or reuses) panel.npy / panel_mean.npy in `folder`; returns (path, rows, columns)."""
    from .. import data_api, price_store

    if tickers:
        wanted = list(dict.fromkeys(t.strip().upper() for t in tickers if t.strip()))
    else:
        wanted = [r["ticker"] for r in price_store.list_stored() if (r.get("rows") or 0) >= MIN_ROWS or "rows" not in r]
    wanted = wanted[:MAX_TICKERS]
    if not wanted:
        raise ValueError("Aucun ticker stocké localement : télécharge des historiques d’abord (onglet Tickers).")
    frames, _ = data_api.price_frames(wanted, "stored")
    panel, names = panel_from_frames(frames)
    key = hashlib.sha1(("|".join(names) + f"#{panel.shape}#{panel[-1].sum():.8f}").encode()).hexdigest()[:16]
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"panel_{key}.npy"
    if not path.exists():
        tmp = folder / f"panel_{key}.tmp.npy"
        np.save(tmp, panel.astype(np.float32))
        np.save(folder / f"panel_{key}_mean.npy", panel.mean(axis=0))
        tmp.replace(path)
    return str(path), int(panel.shape[0]), int(panel.shape[1])
