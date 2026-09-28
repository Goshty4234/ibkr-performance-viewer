"""Result format v2: a small summary plus one detail chunk per portfolio.

The summary holds what the overview needs (series, statistics, today's
weights, period analytics); heavy per-portfolio tables live in
portfolio/<index>.json.gz and are only fetched when the user opens them.
Series share the run-wide `dates` axis through an offset.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import __version__
from .serialize import allocations_to_columns, date_key, rounded, to_jsonable

FORMAT = 2
VALUE_DIGITS = 2  # portfolio values in currency: cents
PRICE_DIGITS = 4
WEIGHT_DIGITS = 5
METRIC_ROWS_BUDGET = 400_000


def dump_gz(obj: Any, path: Path) -> int:
    data = gzip.compress(json.dumps(obj, separators=(",", ":"), allow_nan=False).encode("utf-8"), compresslevel=6)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(path)
    return len(data)


def load_gz(path: Path) -> Any:
    return json.loads(gzip.decompress(path.read_bytes()))


class Axis:
    """Run-wide daily date axis; series are stored as (offset, values) when contiguous."""

    def __init__(self, index: pd.DatetimeIndex) -> None:
        self.index = index
        self.keys = [date_key(d) for d in index]
        self._pos = {d: i for i, d in enumerate(index)}

    def encode(self, series: pd.Series, digits: int | None = VALUE_DIGITS) -> dict[str, Any]:
        values = rounded(series.to_numpy(dtype=float, na_value=np.nan), digits)
        n = len(series)
        if n:
            start = self._pos.get(series.index[0])
            if start is not None and start + n <= len(self.index) and self.index[start + n - 1] == series.index[-1] \
                    and (n == 1 or self.index[start:start + n].equals(series.index)):
                return {"offset": start, "values": values}
        return {"dates": [date_key(d) for d in series.index], "values": values}


def json_config(cfg: dict) -> dict:
    return {k: to_jsonable(v) for k, v in cfg.items() if not k.startswith("_")}


def metrics_columns(metrics: dict) -> dict[str, Any]:
    """{date: {ticker: {metric: value}}} -> row-oriented columns for virtualized tables."""
    dates = sorted(metrics.keys())
    total = sum(len(v) if isinstance(v, dict) else 0 for v in metrics.values())
    truncated = False
    if total > METRIC_ROWS_BUDGET and dates:
        per_date = max(1, total // len(dates))
        dates = dates[-max(1, METRIC_ROWS_BUDGET // per_date):]
        truncated = True
    tickers: list[str] = []
    tpos: dict[str, int] = {}
    fields: list[str] = []
    rows_d: list[int] = []
    rows_t: list[int] = []
    cols: dict[str, list] = {}
    for di, d in enumerate(dates):
        row = metrics.get(d)
        if not isinstance(row, dict):
            continue
        for t, vals in row.items():
            if not isinstance(vals, dict):
                continue
            if t not in tpos:
                tpos[t] = len(tickers)
                tickers.append(t)
            for f in vals:
                if f not in cols:
                    fields.append(f)
                    cols[f] = [None] * len(rows_d)
            rows_d.append(di)
            rows_t.append(tpos[t])
            for f in fields:
                v = vals.get(f)
                cols[f].append(to_jsonable(v) if not isinstance(v, (int, float)) or isinstance(v, bool)
                               else (round(float(v), 8) if np.isfinite(v) else None))
    return {
        "dates": [date_key(d) for d in dates],
        "tickers": tickers,
        "fields": fields,
        "date_idx": rows_d,
        "ticker_idx": rows_t,
        "values": cols,
        "truncated": truncated,
    }


def portfolio_summary(cfg: dict, outcome: dict, axis: Axis, extras: dict | None = None) -> dict:
    base: dict[str, Any] = {
        "index": outcome["index"],
        "name": outcome["name"],
        "fusion": bool(outcome.get("fusion")),
        "ok": bool(outcome["success"]),
        "config": json_config(cfg),
    }
    if not outcome["success"]:
        base["error"] = outcome.get("error", "No result")
        return base
    entry = outcome["entry"]
    wa = entry.get("with_additions")
    na = entry.get("no_additions")
    series: dict[str, Any] = {}
    if isinstance(wa, pd.Series):
        enc = axis.encode(wa)
        series = {k: v for k, v in enc.items() if k != "values"}
        series["with_additions"] = enc["values"]
        no_add = rounded(na.reindex(wa.index).to_numpy(dtype=float), VALUE_DIGITS) if isinstance(na, pd.Series) else []
        # null = identical to with_additions (no periodic contributions)
        series["no_additions"] = None if no_add == enc["values"] else no_add
    stats = outcome.get("stats") or {"values": {}, "display": {}}
    last_reb = outcome.get("last_rebalance")
    base.update(
        series=series,
        stats=to_jsonable(stats["values"]),
        stats_display=to_jsonable(stats["display"]),
        today_weights=to_jsonable(outcome.get("today_weights") or {}),
        current_alloc=to_jsonable(entry.get("current_alloc")) if "current_alloc" in entry else None,
        last_rebalance_date=date_key(last_reb) if last_reb is not None else None,
    )
    if extras:
        base.update(extras)
    return base


def portfolio_detail(outcome: dict, extras: dict | None = None) -> dict:
    out: dict[str, Any] = {"format": FORMAT, "index": outcome["index"], "name": outcome["name"]}
    if outcome["success"]:
        out["allocations"] = allocations_to_columns(outcome.get("allocations") or {}, WEIGHT_DIGITS)
        out["metrics"] = metrics_columns(outcome.get("metrics") or {})
        if extras:
            out.update(extras)
    else:
        out["error"] = outcome.get("error")
    return out


def collect_warnings(prep_warnings: list[str], pieces: list[dict], messages: list[str]) -> list[str]:
    warnings = list(prep_warnings)
    warnings += [f"Portfolio '{p['name']}' failed: {p.get('error')}" for p in pieces if not p.get("ok")]
    for msg in messages:
        if msg not in warnings and len(warnings) < 50:
            warnings.append(msg)
    return warnings


def build_summary(prep: Any, axis: Axis, pieces: list[dict], messages: list[str], benchmarks: dict[str, pd.Series],
                  duration_s: float, market: dict | None = None, extras: dict | None = None) -> dict:
    sim = prep.simulation_index
    display_start = prep.display_start
    bench_payload = {}
    for t, close in benchmarks.items():
        if display_start is not None:
            close = close[close.index >= display_start]
        bench_payload[t] = axis.encode(close, PRICE_DIGITS)
    summary = {
        "format": FORMAT,
        "engine_version": __version__,
        "options": prep.options.to_dict(),
        "duration_s": round(duration_s, 3),
        "simulation": {
            "start": date_key(sim[0]) if len(sim) else None,
            "end": date_key(sim[-1]) if len(sim) else None,
            "display_start": date_key(display_start) if display_start is not None else None,
        },
        "dates": axis.keys,
        "invalid_tickers": prep.invalid_tickers,
        "warnings": collect_warnings(prep.warnings, pieces, messages),
        "portfolios": sorted(pieces, key=lambda p: p["index"]),
        "benchmarks": bench_payload,
        "market": market or {},
    }
    if extras:
        summary.update(extras)
    return summary
