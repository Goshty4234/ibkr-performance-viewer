"""Conversion of pandas/numpy results into compact JSON-safe structures."""

from __future__ import annotations

import datetime as dt
import math
from typing import Any

import numpy as np
import pandas as pd


_DATE_KEYS: dict[Any, str] = {}


def date_key(value: Any) -> str:
    if isinstance(value, (pd.Timestamp, dt.datetime)):
        # Results repeat the same few thousand days in every table: format each once.
        key = _DATE_KEYS.get(value)
        if key is None:
            key = value.strftime("%Y-%m-%d")
            if len(_DATE_KEYS) < 200_000:
                _DATE_KEYS[value] = key
        return key
    if isinstance(value, dt.date):
        return value.isoformat()
    return str(value)


def clean_number(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    return value


def to_jsonable(value: Any, depth: int = 0) -> Any:
    """Best-effort recursive conversion; unknown objects become strings."""
    if depth > 12:
        return None
    if isinstance(value, dict):
        return {date_key(k) if not isinstance(k, str) else k: to_jsonable(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(v, depth + 1) for v in value]
    if isinstance(value, pd.Series):
        return series_to_columns(value)
    if isinstance(value, pd.DataFrame):
        return None
    if isinstance(value, (pd.Timestamp, dt.datetime, dt.date)):
        return date_key(value)
    if isinstance(value, (np.ndarray,)):
        return [clean_number(v) for v in value.tolist()]
    if value is None or isinstance(value, (str, int, float, bool, np.generic)):
        return clean_number(value)
    return str(value)


def rounded(values: Any, ndigits: int | None) -> list:
    """Transport rounding (statistics are computed on full precision beforehand)."""
    if isinstance(values, np.ndarray) and values.dtype.kind == "f":
        # tolist() gives Python floats: clean_number reduces to "finite or None".
        isfinite = math.isfinite
        if ndigits is None:
            return [v if isfinite(v) else None for v in values.tolist()]
        return [round(v, ndigits) if isfinite(v) else None for v in values.tolist()]
    isfinite = math.isfinite
    out: list = []
    append = out.append
    for v in (values.tolist() if isinstance(values, np.ndarray) else values):
        tv = type(v)
        if tv is float or tv is np.float64:
            f = float(v)
            append((f if ndigits is None else round(f, ndigits)) if isfinite(f) else None)
        else:
            c = clean_number(v)
            append(round(c, ndigits) if ndigits is not None and isinstance(c, float) else c)
    return out


def series_to_columns(series: pd.Series, ndigits: int | None = None) -> dict[str, list]:
    return {
        "dates": [date_key(d) for d in series.index],
        "values": rounded(series.to_numpy(dtype=float, na_value=np.nan), ndigits),
    }


def allocations_to_columns(allocations: dict, ndigits: int | None = None) -> dict[str, Any]:
    """{date: {ticker: weight}} -> {dates: [...], weights: {ticker: [...]}} without all-zero tickers."""
    dates = sorted(allocations.keys())
    rows = [allocations.get(d) or {} for d in dates]
    tickers: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for t, v in row.items():
            if not isinstance(v, (int, float, np.integer, np.floating)) or isinstance(v, bool):
                continue
            if t not in seen:
                seen.add(t)
                tickers.append(t)
    weights: dict[str, list] = {}
    for t in tickers:
        col = rounded([row.get(t, 0.0) for row in rows], ndigits)
        if any(v not in (None, 0, 0.0) for v in col):
            weights[t] = col
    return {"dates": [date_key(d) for d in dates], "weights": weights}
