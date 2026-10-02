"""Runs the REAL momentum functions of the engine (nested in single_backtest, extracted from
backtest_engine/legacy/multi_backtest.py) on arrays produced by the Monte Carlo generators."""

from __future__ import annotations

import ast
import os
import textwrap
from pathlib import Path

import numpy as np
import pandas as pd

LEGACY = Path(os.path.abspath(__file__)).parents[2] / "backtest_engine" / "legacy" / "multi_backtest.py"


class _State(dict):
    def get(self, k, d=None):  # st.session_state.get(...)
        return d


class _St:
    session_state = _State()


def _load():
    src = LEGACY.read_text(encoding="utf-8").replace("\r\n", "\n")
    tree = ast.parse(src)
    top = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
    env: dict = {"np": np, "pd": pd, "st": _St()}
    for name in ("parse_bool_from_json", "_momentum_return_between", "_momentum_window_discards_negative",
                 "_window_capped_momentum_scores", "is_special_dynamic_ticker",
                 "select_tickers_with_concentration_limits"):
        if name in top:
            exec(ast.get_source_segment(src, top[name]), env)
    single = top["single_backtest"]
    funcs = {}
    for n in ast.walk(single):
        if isinstance(n, ast.FunctionDef) and n.name in ("calculate_momentum", "calculate_momentum_weights") and n.name not in funcs:
            funcs[n.name] = textwrap.dedent(ast.get_source_segment(src, n))
    return env, funcs


_ENV, _FUNCS = _load()


def legacy_runner(logprice_sim: np.ndarray, d: np.ndarray, config: dict, tickers: list[str]):
    """Returns (calc_momentum, calc_weights) bound to one simulation's price frames."""
    idx = pd.DatetimeIndex(d.astype("datetime64[ns]"))
    P = np.exp(logprice_sim)                      # (T, N)
    data = {}
    for j, t in enumerate(tickers):
        close = pd.Series(P[:, j], index=idx)
        data[t] = pd.DataFrame({"Close": close, "Dividends": 0.0, "Price_change": close.pct_change()})
    mkt = pd.Series(P, index=idx).pct_change() if False else pd.DataFrame(P, index=idx).pct_change().mean(axis=1)
    bench_close = (1 + mkt.fillna(0)).cumprod()
    data["^GSPC"] = pd.DataFrame({"Close": bench_close, "Dividends": 0.0, "Price_change": mkt})
    env = dict(_ENV)
    env.update(config=config, ma_filter_data=None, current_data=data, reindexed_data=data,
               start_dates_config={t: data[t].first_valid_index() for t in tickers},
               include_dividends={t: False for t in tickers},
               filter_tickers_by_sp500_entry=lambda assets, date, cfg: assets)
    exec(_FUNCS["calculate_momentum"], env)
    exec(_FUNCS["calculate_momentum_weights"], env)
    return env["calculate_momentum"], env["calculate_momentum_weights"]
