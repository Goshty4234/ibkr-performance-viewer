"""Year → tickers table read by the legacy SP500TOP20 backtest (single_backtest_year_aware).

The source ranks each year by that year's closing market caps, and the legacy code holds year Y's
list from January 1 of Y, i.e. it buys the companies that will end Y in the top 20. It also falls
back to the 1989 list for any year missing from the table, so every year after the last row held
the 1989 names. The table written here fixes both without touching the legacy code:
  * year Y holds the ranking of Y-1 (the first year keeps its own list, nothing earlier exists);
  * every year up to the current one after the last ranking holds the last known list.
"""

from __future__ import annotations

import csv
import io
import os
from datetime import date
from pathlib import Path

SOURCE = Path("Complete_Tickers") / "Historical CSV" / "SP500_TOP20_BY_YEAR.csv"
TARGET = Path("TOP_20_SP500_COMPLETE_TEMPLATE.csv")
FIELDS = ["Year", "Rank", "Company", "Market_Cap_Billions", "Ticker"]


def build_table(rows: list[dict[str, str]], through_year: int) -> str:
    by_year: dict[int, list[dict[str, str]]] = {}
    for r in rows:
        by_year.setdefault(int(r["Year"]), []).append(r)
    years = sorted(by_year)
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=FIELDS, lineterminator="\n")
    w.writeheader()
    if not years:
        return out.getvalue()
    first, last = years[0], years[-1]
    for y in range(first, max(last + 1, through_year) + 1):
        known = [k for k in years if k < y]
        src = by_year[known[-1]] if known else by_year[first]
        for r in sorted(src, key=lambda r: int(r["Rank"])):
            w.writerow({**{k: r.get(k, "") for k in FIELDS}, "Year": y})
    return out.getvalue()


_checked: set[tuple[str, int]] = set()


def ensure_table(home: Path) -> None:
    """Writes home/TOP_20_SP500_COMPLETE_TEMPLATE.csv when missing or stale; atomic across processes."""
    key = (str(home), date.today().toordinal())
    if key in _checked:
        return
    _checked.add(key)
    src, dst = home / SOURCE, home / TARGET
    if not src.exists():
        return
    with src.open(newline="", encoding="utf-8") as f:
        content = build_table(list(csv.DictReader(f)), date.today().year)
    try:
        if dst.read_text(encoding="utf-8") == content:
            return
    except OSError:
        pass
    tmp = dst.with_name(f".{dst.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(content, encoding="utf-8")
        os.replace(tmp, dst)
    except OSError:
        tmp.unlink(missing_ok=True)
