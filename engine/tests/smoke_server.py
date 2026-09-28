"""End-to-end smoke test of a running engine: concurrent jobs, v2 result parts, cancel.

    py -3.13 tests/smoke_server.py [http://127.0.0.1:8765]
"""

from __future__ import annotations

import copy
import json
import sys
import time
from pathlib import Path

import requests

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
CONFIGS = Path(__file__).parent / "parity" / "configs"
CFG = json.loads((CONFIGS / "01_buy_hold.json").read_text(encoding="utf-8"))
MOMO = json.loads((CONFIGS / "02_momentum_classic.json").read_text(encoding="utf-8"))
ORIGIN = "https://ibkr-performance-viewer.vercel.app"


def many(cfg: dict, n: int) -> dict:
    out = copy.deepcopy(cfg)
    base = out["portfolios"]
    out["portfolios"] = []
    for i in range(n):
        p = copy.deepcopy(base[i % len(base)])
        p["name"] = f"{p['name']} #{i + 1}"
        p["momentum_windows"] = p.get("momentum_windows") or []
        out["portfolios"].append(p)
    return out


def wait(job_id: str) -> dict:
    t0 = time.time()
    last = ""
    while True:
        st = requests.get(f"{BASE}/jobs/{job_id}").json()
        line = f"  {job_id[:6]} {time.time() - t0:5.1f}s {st['status']:9} {st.get('phase', ''):10} {st['progress']:.2f} {st['message']}"
        if line != last:
            print(line)
            last = line
        if st["status"] in ("done", "error", "cancelled"):
            return st
        time.sleep(0.3)


pre = requests.options(f"{BASE}/jobs", headers={
    "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type,authorization",
    "Access-Control-Request-Private-Network": "true",
})
print("preflight", pre.status_code, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-private-network"))
print("health", requests.get(f"{BASE}/health", headers={"Origin": ORIGIN}).json())

t0 = time.time()
big = requests.post(f"{BASE}/jobs", json=many(MOMO, 16)).json()
small = requests.post(f"{BASE}/jobs", json=CFG).json()
print("submitted", big["id"][:6], "(16 portfolios) and", small["id"][:6], "(2 portfolios)")
st_small = wait(small["id"])
print(f"small finished after {time.time() - t0:.1f}s")
st_big = wait(big["id"])
print(f"big finished after {time.time() - t0:.1f}s; health {requests.get(f'{BASE}/health').json()}")

for st in (st_small, st_big):
    if st["status"] != "done":
        print("error", st["error"])
        continue
    r = requests.get(f"{BASE}/jobs/{st['id']}/summary")
    summary = r.json()
    ps = summary["portfolios"]
    print("summary", len(r.content), "bytes; format", summary["format"], "dates", len(summary["dates"]),
          [(p["name"], p["stats_display"].get("CAGR")) for p in ps[:4]])
    d = requests.get(f"{BASE}/jobs/{st['id']}/portfolio/{ps[0]['index']}")
    detail = d.json()
    print("detail", len(d.content), "bytes;", sorted(detail.keys()))

job2 = requests.post(f"{BASE}/jobs", json=many(MOMO, 8)).json()
time.sleep(2.5)
print("cancel", requests.delete(f"{BASE}/jobs/{job2['id']}").json()["status"])
print("bad config", requests.post(f"{BASE}/jobs", json={"portfolios": [{"x": 1}]}).status_code)
print("jobs", len(requests.get(f"{BASE}/jobs").json()))
time.sleep(1)
print("health", requests.get(f"{BASE}/health").json())
