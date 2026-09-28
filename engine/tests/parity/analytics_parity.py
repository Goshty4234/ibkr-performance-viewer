"""Parity of the result analytics against the Streamlit blocks, on frozen prices.

Usage (from engine/):
    py -3.13 -u -m tests.parity.analytics_parity [filter]

Compares, per portfolio: shares/values, realized/unrealized gains and the
annual summary, today's weights and allocation table, the timer inputs, the
last-rebalance comparison tables, and the fast rebalance-date generator.
Also sanity-checks the Canadian ACB computation (no phantom trades, final
positions match the portfolio's last allocation).
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
ENGINE_ROOT = HERE.parents[1]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from tests.parity import yf_replay  # noqa: E402
from tests.parity.run_parity import CONFIG_DIR, FIXTURE_DIR, _prepare_workdir, diff  # noqa: E402

FREQS = ["market_day", "calendar_day", "Weekly", "Biweekly", "Monthly", "Quarterly", "Semiannually", "Annually",
         "Never", "Buy & Hold"]


def _num(x):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else x


def _r6(obj):
    """Allocation tables are stored with 6 decimals."""
    if isinstance(obj, float):
        return None if np.isnan(obj) else round(obj, 6)
    if isinstance(obj, dict):
        return {k: _r6(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_r6(v) for v in obj]
    return obj


def check_config(name: str, raw: dict) -> list[str]:
    from backtest_engine.analytics import holdings, today
    from backtest_engine.analytics.dates import dates_by_freq
    from backtest_engine.legacy import multi_backtest as L
    from backtest_engine.runner import is_fusion, run_backtest
    from tests.parity import analytics_reference as R

    wd = _prepare_workdir("analytics")
    os.environ["ENGINE_HOME"] = str(wd)
    with redirect_stdout(io.StringIO()):
        run = run_backtest(raw["portfolios"], raw.get("options") or {})
    problems: list[str] = []
    for cfg in run.configs:
        pname = cfg["name"]
        entry = run.all_results.get(pname)
        if entry is None:
            continue
        allocations = run.all_allocations[pname]
        metrics = run.all_metrics[pname]
        tag = f"{name}/{pname}"

        idx = entry["no_additions"].index
        for f in FREQS:
            ref = sorted(L.get_dates_by_freq(f, idx[0], idx[-1], idx))
            if ref != dates_by_freq(f, idx):
                problems.append(f"{tag}: dates_by_freq({f}) differs")

        ref = R.shares_and_gains(cfg, entry, allocations, run.data)
        h = holdings.streamlit_holdings(cfg, entry, allocations, run.data)
        if ref is None:
            if h["dates"]:
                problems.append(f"{tag}: engine has holdings, Streamlit has none")
        else:
            g = holdings.streamlit_gains(h)
            mine = {
                "dates": h["dates"], "tickers": h["tickers"],
                "shares": h["shares"].tolist(), "values": h["values"].tolist(),
                "periods": g["periods"],
                "realized": [[_num(v) for v in row] for row in g["realized"]],
                "unrealized": [[_num(v) for v in row] for row in g["unrealized"]],
                "realized_total": g["realized_total"], "unrealized_total": g["unrealized_total"],
                "annual": g["annual"],
            }
            for key in ("realized", "unrealized", "realized_total", "unrealized_total"):
                ref[key] = json.loads(json.dumps(ref[key]))
                ref[key] = [[round(v, 2) for v in row] for row in ref[key]] if key in ("realized", "unrealized") \
                    else [round(v, 2) for v in ref[key]]
            for row in ref["annual"]:
                for k in ("realized", "unrealized", "total"):
                    row[k] = round(row[k], 2)
                row["taxable_pct"] = round(row["taxable_pct"], 4)
            problems += [f"{tag} gains{p}" for p in diff(ref, mine, limit=6)]

        ref_w, ref_pie = R.today_weights(cfg, metrics)
        block = today.today_block(cfg, entry, metrics, allocations, run.data)
        problems += [f"{tag} today.pie{p}" for p in diff(_r6(ref_pie), block["pie"], limit=4)]
        pv = R.get_portfolio_value(entry)
        ref_tab = R.alloc_table(ref_w, None, pv, run.data)
        problems += [f"{tag} today.table{p}" for p in diff(_r6(json.loads(json.dumps(ref_tab, default=float))),
                                                         json.loads(json.dumps(block["table"])), limit=4)]

        problems += [f"{tag} timer{p}" for p in diff(R.timer(cfg, allocations), today.timer_info(cfg, allocations))]

        fusion = is_fusion(cfg)
        last, final = R.last_rebalance_date(cfg, entry, allocations)
        cmp_ = today.rebalance_compare(cfg, entry, allocations, run.data, fusion)
        if cmp_["last_date"] != last.strftime("%Y-%m-%d"):
            problems.append(f"{tag}: last rebalance {cmp_['last_date']} != {last:%Y-%m-%d}")
        exclude = set(cfg.get("fusion_portfolio", {}).get("selected_portfolios", [])) if fusion else ()
        for key, alloc, pdate in (("last_table", allocations.get(last, {}), last),
                                  ("current_table", allocations.get(final, {}), None)):
            ref_t = _r6(json.loads(json.dumps(R.alloc_table(alloc, pdate, pv, run.data, exclude), default=float)))
            problems += [f"{tag} {key}{p}" for p in diff(ref_t, json.loads(json.dumps(cmp_[key])), limit=4)]

        t0 = time.perf_counter()
        tax = holdings.acb_tax(cfg, entry, allocations, run.data_reindexed, run.configs)
        dt = time.perf_counter() - t0
        tx = tax["transactions"] or {}
        n_tx = tx.get("total", 0)
        final_alloc = allocations[max(allocations)]
        wa_last = float(entry["with_additions"].iloc[-1])
        expected_mv = wa_last * sum(v for k, v in final_alloc.items() if k != "CASH")
        got_mv = sum(p["market_value"] or 0 for p in tax["positions"])
        rel = abs(got_mv - expected_mv) / max(1.0, expected_mv)
        realized = sum(y["realized"] for y in tax["years"])
        print(f"    {pname}: ACB {n_tx} trades, realized {realized:,.0f}, final MV {got_mv:,.0f} vs "
              f"{expected_mv:,.0f} ({rel:.2e}), {dt*1000:.0f} ms")
        if rel > 1e-3:
            problems.append(f"{tag}: ACB final market value off by {rel:.2%}")
        freq = str(cfg.get("rebalancing_frequency", "")).lower()
        if freq in ("never", "none") and not any(s.get("include_dividends") for s in cfg.get("stocks", [])) \
                and not cfg.get("added_amount"):
            sells = sum(1 for k in tx.get("kind", []) if k == "sell")
            if sells:
                problems.append(f"{tag}: buy & hold without dividends produced {sells} sells")
    return problems


def main() -> int:
    filt = sys.argv[1] if len(sys.argv) > 1 else ""
    from backtest_engine.certs import ensure_system_ca_bundle

    ensure_system_ca_bundle(ENGINE_ROOT / ".certs")
    failures = 0
    configs = sorted(p for p in CONFIG_DIR.glob("*.json") if filt in p.stem and (FIXTURE_DIR / f"{p.stem}.pkl").exists())
    for cfg_path in configs:
        name = cfg_path.stem
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        store = yf_replay.install(FIXTURE_DIR / f"{name}.pkl", "replay")
        t0 = time.perf_counter()
        try:
            print(f"[{name}]")
            problems = check_config(name, raw)
        except Exception as exc:  # noqa: BLE001
            import traceback

            traceback.print_exc()
            problems = [f"crash: {exc!r}"]
        finally:
            os.chdir(ENGINE_ROOT)
            store.save()
        if problems:
            failures += 1
            print(f"[{name}] FAIL ({time.perf_counter() - t0:.1f}s)")
            for p in problems[:30]:
                print(f"    {p}")
        else:
            print(f"[{name}] OK ({time.perf_counter() - t0:.1f}s)")
    print(f"\n{len(configs) - failures}/{len(configs)} configs identical")
    return 1 if failures else 0


if __name__ == "__main__":
    pd.set_option("mode.chained_assignment", None)
    raise SystemExit(main())
