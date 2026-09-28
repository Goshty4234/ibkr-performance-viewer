"""Runs the ORIGINAL Streamlit page code headless to produce reference results.

The definitions of 1_Multi_Backtest.py are exec'd with the streamlit shim,
the JSON is imported through the page's own paste_all_json_callback, then the
page's own "Run Backtest" block and final-statistics block are exec'd verbatim.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from backtest_engine.context import RunOptions
from backtest_engine.st_shim import StopRun, _StreamlitShim
from tools.legacy_ast import body_source, filter_definitions, find_if_at_line, find_top_level_if

STREAMLIT_FILE = Path(__file__).resolve().parents[3] / "Streamlit Momentum Backtester" / "1_Multi_Backtest.py"

_CACHE: dict[str, Any] = {}


def _sources() -> dict[str, Any]:
    if _CACHE:
        return _CACHE
    import ast

    src = STREAMLIT_FILE.read_text(encoding="utf-8")
    tree = ast.parse(src)
    defaults_loop = next(
        n for n in tree.body
        if isinstance(n, ast.For) and "multi_backtest_portfolio_configs" in ast.get_source_segment(src, n.iter)
        and "include_in_sma_filter" in ast.get_source_segment(src, n)
    )
    run_if = find_top_level_if(src, "Run Backtest")
    stats_if = find_if_at_line(
        src, 19099, "'multi_all_results' in st.session_state and st.session_state.multi_all_results"
    )
    fname = str(STREAMLIT_FILE)
    _CACHE.update(
        definitions=compile(filter_definitions(src), fname, "exec"),
        defaults=compile(ast.get_source_segment(src, defaults_loop), fname, "exec"),
        run=compile(body_source(src, run_if), fname, "exec"),
        stats=compile(body_source(src, stats_if), fname, "exec"),
    )
    return _CACHE


def run_reference(raw: dict) -> dict[str, Any]:
    """raw = {"options": {...}, "portfolios": [...]} (Streamlit export format)."""
    code = _sources()
    shim = _StreamlitShim()
    ns: dict[str, Any] = {"__name__": "streamlit_reference", "__file__": str(STREAMLIT_FILE), "st": shim}
    exec(code["definitions"], ns)
    ns["st"] = shim

    options = RunOptions.from_dict(raw.get("options") or {})
    ss = shim.session_state
    ss.reset({})
    ss["multi_backtest_portfolio_configs"] = []
    ss["multi_backtest_active_portfolio_index"] = 0
    ss["multi_backtest_paste_all_json_text"] = json.dumps(raw["portfolios"])
    ns["paste_all_json_callback"]()

    for k, v in options.session_state().items():
        ss[k] = v
    for cfg in ss["multi_backtest_portfolio_configs"]:
        if options.start_date or options.end_date:
            cfg["start_date_user"] = ns["parse_date_from_json"](options.start_date)
            cfg["end_date_user"] = ns["parse_date_from_json"](options.end_date)
    exec(code["defaults"], ns)
    configs = copy.deepcopy(ss["multi_backtest_portfolio_configs"])

    try:
        exec(code["run"], ns)
    except StopRun:
        return {"stopped": True, "configs": configs, "messages": shim.messages}
    try:
        exec(code["stats"], ns)
    except StopRun:
        pass

    snapshot = ss.get("multi_backtest_snapshot_data", {}) or {}
    return {
        "stopped": False,
        "configs": configs,
        "all_results": ss.get("multi_all_results", {}) or {},
        "all_allocations": ss.get("multi_all_allocations", {}) or {},
        "all_metrics": ss.get("multi_all_metrics", {}) or {},
        "today_weights": snapshot.get("today_weights_map", {}) or {},
        "last_rebalance_dates": snapshot.get("last_rebalance_dates", {}) or {},
        "stats": ns.get("recomputed_stats", {}) or {},
    }
