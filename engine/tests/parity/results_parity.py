"""Parity of the TypeScript result analytics with the Streamlit transcription.

    cd engine
    py -3.13 -m tests.parity.results_parity [bundle.json.gz ...] [--config 07_fusion ...]

Without bundles, each --config (default: 02, 07, 09) is run through the CLI
first. The TS modules are compiled with the repo's TypeScript into a temp
folder and executed with node on the same bundle as the Python reference.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE_ROOT = HERE.parents[1]
REPO = ENGINE_ROOT.parent
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

from tests.parity import results_reference as R  # noqa: E402

TS_FILES = ["math.ts", "series.ts", "periods.ts", "focused.ts", "overview.ts"]
REL_TOL = 1e-9
ABS_TOL = 1e-9


def compile_ts(out_dir: Path) -> None:
    src = REPO / "src" / "lib" / "backtest" / "analytics"
    cfg = {
        "compilerOptions": {
            "target": "ES2022", "module": "commonjs", "moduleResolution": "node", "strict": True,
            "skipLibCheck": True, "outDir": str(out_dir), "rootDir": str(REPO / "src"),
            "baseUrl": str(REPO), "paths": {"@/*": ["src/*"]}, "types": [],
        },
        "files": [str(src / f) for f in TS_FILES],
    }
    tsconfig = out_dir.parent / "tsconfig.results-parity.json"
    tsconfig.write_text(json.dumps(cfg), encoding="utf-8")
    tsc = REPO / "node_modules" / "typescript" / "bin" / "tsc"
    subprocess.run(["node", str(tsc), "-p", str(tsconfig)], check=True, cwd=REPO)


def run_config(name: str, work: Path) -> Path:
    req = HERE / "configs" / f"{name}.json"
    out = work / f"{name}.result.json.gz"
    subprocess.run([sys.executable, "-m", "backtest_engine", "run", str(req), "-o", str(out), "-q", "-w", "4"],
                   check=True, cwd=ENGINE_ROOT)
    return out


def _norm(v):
    if isinstance(v, float):
        if math.isnan(v):
            return None
        if math.isinf(v):
            return "inf"
    if hasattr(v, "item"):
        return _norm(v.item())
    if isinstance(v, dict):
        return {k: _norm(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_norm(x) for x in v]
    return v


def compare(a, b, path="", out=None, limit=12):
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b), key=str):
            if k not in a or k not in b:
                out.append(f"{path}/{k}: missing on {'TS' if k not in b else 'reference'} side")
            else:
                compare(a[k], b[k], f"{path}/{k}", out, limit)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f"{path}[{i}]", out, limit)
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        if not math.isclose(a, b, rel_tol=REL_TOL, abs_tol=ABS_TOL):
            out.append(f"{path}: {a!r} (reference) != {b!r} (TS)")
    elif a != b:
        out.append(f"{path}: {a!r} (reference) != {b!r} (TS)")
    return out


def check(bundle: Path, js_dir: Path, work: Path) -> list[str]:
    obj = json.loads(gzip.decompress(bundle.read_bytes()))
    summary = obj.get("summary", obj)
    if not summary.get("benchmark_returns"):
        print("    (no benchmark_returns in this bundle: betas will be N/A on both sides)")
    dates = summary["dates"]
    start = dates[len(dates) // 3]
    end = dates[(2 * len(dates)) // 3]
    ts_out = work / (bundle.stem + ".ts.json")
    subprocess.run(["node", str(HERE / "results_ts.cjs"), str(js_dir), str(bundle), start, end, str(ts_out)],
                   check=True)
    ts = json.loads(ts_out.read_text(encoding="utf-8"))
    configs, results, raw = R.rebuild(summary)
    ref = {
        "periods": {k: R.periods(configs, results, raw, k) for k in ("year", "month")},
        "variation": R.variation(results),
        "heatmap": R.heatmap(configs, results),
        "focused": {f"{s}:{e}": R.focused(configs, results, raw, s, e)
                    for s, e in ((start, end), ("1900-01-01", "2100-12-31"))},
    }
    t = ts.pop("timings", {})
    print(f"    TS timings: periods {t.get('periods_ms', 0):.1f} ms, overview {t.get('overview_ms', 0):.1f} ms, "
          f"focused {t.get('focused_ms', 0):.1f} ms ({len(results)} portfolios, {len(dates)} days)")
    return compare(_norm(ref), ts)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("bundles", nargs="*")
    ap.add_argument("--config", action="append")
    args = ap.parse_args()
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    work = Path(tempfile.mkdtemp(prefix="results-parity-"))
    out_dir = work / "js"
    out_dir.mkdir()
    js_dir = out_dir / "lib" / "backtest" / "analytics"
    try:
        compile_ts(out_dir)
        bundles = [Path(b) for b in args.bundles]
        if not bundles:
            for name in args.config or ["02_momentum_classic", "07_fusion", "09_twenty_portfolios"]:
                print(f"[run {name}]", flush=True)
                bundles.append(run_config(name, work))
        failed = 0
        for b in bundles:
            print(f"[{b.name}]", flush=True)
            problems = check(b, js_dir, work)
            if problems:
                failed += 1
                print(f"[{b.name}] FAIL")
                for p in problems:
                    print("    " + p)
            else:
                print(f"[{b.name}] OK")
        return 1 if failed else 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
