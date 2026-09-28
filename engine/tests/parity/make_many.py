"""Builds configs/09_twenty_portfolios.json from the single-feature configs.

    py -3.13 -m tests.parity.make_many
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

CONFIGS = Path(__file__).resolve().parent / "configs"
FREQS = ["Monthly", "Quarterly", "Semiannually", "Annually", "Weekly"]


def main() -> None:
    sources = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(CONFIGS.glob("0[1-6]_*.json"))]
    base = [p for c in sources for p in c["portfolios"] if not p.get("fusion_portfolio", {}).get("enabled")]
    out = []
    i = 0
    while len(out) < 20:
        p = copy.deepcopy(base[i % len(base)])
        freq = FREQS[(i // len(base)) % len(FREQS)]
        p["rebalancing_frequency"] = freq
        p["name"] = f"{p['name']} [{freq}] #{len(out) + 1}"
        out.append(p)
        i += 1
    cfg = {"portfolios": out, "options": sources[1].get("options", {})}
    (CONFIGS / "09_twenty_portfolios.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")
    print(len(out), sorted({s["ticker"] for p in out for s in p["stocks"]}))


if __name__ == "__main__":
    main()
