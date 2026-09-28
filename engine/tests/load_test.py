"""Load test of a running engine: one big job (~1000 tickers, 200 portfolios) plus a small job in parallel.

    py -3.13 tests/load_test.py [--base http://127.0.0.1:8765] [--tickers 1000] [--portfolios 200] [--per 40]

Reports wall time per job, time-to-first-result of the small job while the big one runs,
peak engine memory, summary / portfolio chunk sizes and fetch latency.
"""

from __future__ import annotations

import argparse
import json
import random
import threading
import time
from pathlib import Path

import requests

CONFIGS = Path(__file__).parent / "parity" / "configs"


def engine_memory_mb() -> float:
    """Working set of every python process running backtest_engine (server + pool workers)."""
    try:
        import psutil
    except ImportError:
        return float("nan")
    total = 0.0
    for p in psutil.process_iter(["cmdline", "memory_info", "ppid"]):
        try:
            cmd = " ".join(p.info["cmdline"] or [])
            if "backtest_engine" in cmd or "multiprocessing" in cmd and "python" in cmd.lower():
                total += p.info["memory_info"].rss
        except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError):
            continue
    return total / 2**20


def universe(base: str, n: int) -> list[str]:
    sp = requests.get(f"{base}/universe/sp500", timeout=120).json()["tickers"]
    out = list(dict.fromkeys(sp))
    if len(out) < n:
        us = requests.get(f"{base}/universe/us", timeout=120).json()["tickers"]
        rng = random.Random(7)
        extra = [t for t in us if t not in set(out)]
        rng.shuffle(extra)
        out += extra[: n - len(out)]
    return out[:n]


def big_request(tickers: list[str], n_portfolios: int, per: int) -> dict:
    rng = random.Random(42)
    portfolios = []
    for i in range(n_portfolios):
        # Stride through the universe so every ticker is used at least once.
        start = (i * per) % len(tickers)
        picks = [tickers[(start + k) % len(tickers)] for k in range(per)]
        momentum = i % 3 != 0
        portfolios.append({
            "name": f"Load {i + 1:03d}",
            "stocks": [{"ticker": t, "allocation": 1 / per, "include_dividends": True} for t in picks],
            "benchmark_ticker": "^GSPC",
            "initial_value": 10000,
            "added_amount": 500,
            "added_frequency": "Monthly",
            "rebalancing_frequency": rng.choice(["Monthly", "Quarterly"]),
            "use_momentum": momentum,
            "momentum_strategy": "Classic",
            "negative_momentum_strategy": "Cash",
            "momentum_windows": [
                {"lookback": 365, "exclude": 30, "weight": 0.5},
                {"lookback": 180, "exclude": 30, "weight": 0.3},
                {"lookback": 120, "exclude": 30, "weight": 0.2},
            ] if momentum else [],
            "calc_beta": False,
            "calc_volatility": momentum,
            "use_limit_to_top_n": momentum,
            "limit_to_top_n_tickers": 10,
        })
    return {
        # "all" would wait for the youngest listing (recent IPOs of the US list start after any fixed end date).
        "options": {"start_with": "oldest", "first_rebalance_strategy": "rebalancing_date", "start_date": "2016-01-01"},
        "portfolios": portfolios,
    }


def wait(base: str, job_id: str, label: str, t0: float) -> dict:
    last = ""
    while True:
        st = requests.get(f"{base}/jobs/{job_id}", timeout=30).json()
        line = f"[{label}] {time.time() - t0:7.1f}s {st['status']:9} {st.get('phase', ''):10} {st['progress']:.2f} {st.get('message', '')[:90]}"
        if line != last:
            print(line, flush=True)
            last = line
        if st["status"] in ("done", "error", "cancelled"):
            return st
        time.sleep(2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8765")
    ap.add_argument("--tickers", type=int, default=1000)
    ap.add_argument("--portfolios", type=int, default=200)
    ap.add_argument("--per", type=int, default=40)
    args = ap.parse_args()
    base = args.base

    print("health", requests.get(f"{base}/health", timeout=10).json(), flush=True)
    tickers = universe(base, args.tickers)
    print(f"universe: {len(tickers)} tickers", flush=True)
    big = big_request(tickers, args.portfolios, args.per)
    used = {s["ticker"] for p in big["portfolios"] for s in p["stocks"]}
    print(f"big job: {len(big['portfolios'])} portfolios, {len(used)} distinct tickers", flush=True)
    small = json.loads((CONFIGS / "01_buy_hold.json").read_text(encoding="utf-8"))

    peak = {"mb": 0.0}
    stop = threading.Event()

    def sample() -> None:
        while not stop.is_set():
            peak["mb"] = max(peak["mb"], engine_memory_mb())
            stop.wait(1.0)

    threading.Thread(target=sample, daemon=True).start()

    t0 = time.time()
    big_id = requests.post(f"{base}/jobs", json=big, timeout=60).json()["id"]
    time.sleep(5)
    t_small = time.time()
    small_id = requests.post(f"{base}/jobs", json=small, timeout=60).json()["id"]

    results: dict[str, dict] = {}
    done_at: dict[str, float] = {}

    def track_small() -> None:
        results["small"] = wait(base, small_id, "small", t0)
        done_at["small"] = time.time()

    th = threading.Thread(target=track_small, daemon=True)
    th.start()
    results["big"] = wait(base, big_id, "big", t0)
    th.join()
    stop.set()
    t_end = time.time()

    print("\n==== RESULTS ====")
    print(f"small job (2 portfolios, submitted while big ran): {results['small']['status']} in {done_at['small'] - t_small:.1f}s")
    print(f"big job: {results['big']['status']} wall {t_end - t0:.1f}s")
    if results["big"]["status"] != "done":
        print("error:", results["big"].get("error"))
    print(f"peak engine memory: {peak['mb']:.0f} MB")

    for label in ("small", "big"):
        st = results[label]
        if st["status"] != "done":
            continue
        t = time.time()
        r = requests.get(f"{base}/jobs/{st['id']}/summary", timeout=120)
        summary = r.json()
        ps = summary["portfolios"]
        print(f"[{label}] summary {len(r.content) / 1024:.0f} KB (gzip transfer), fetched+parsed in {time.time() - t:.2f}s; "
              f"{len(ps)} portfolios, {len(summary['dates'])} dates")
        t = time.time()
        d = requests.get(f"{base}/jobs/{st['id']}/portfolio/{ps[0]['index']}", timeout=120)
        print(f"[{label}] portfolio chunk {len(d.content) / 1024:.0f} KB in {time.time() - t:.2f}s")
        cagr = [p["stats_display"].get("CAGR") for p in ps[:5]]
        print(f"[{label}] first CAGRs: {cagr}")
    print("health", requests.get(f"{base}/health", timeout=10).json())


if __name__ == "__main__":
    main()
