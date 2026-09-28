"""Command line entry points.

    python -m backtest_engine run request.json -o result.json.gz
    python -m backtest_engine serve --port 8765
    python -m backtest_engine version

A request is either {"portfolios": [...], "options": {...}} or a raw Streamlit
"export all portfolios" JSON list (global options are then read from it).
"""

from __future__ import annotations

import argparse
import contextlib
import gzip
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from . import __version__


def split_request(raw: Any) -> tuple[Any, dict]:
    from .config import options_from_streamlit_json

    if isinstance(raw, dict) and "portfolios" in raw:
        options = dict(options_from_streamlit_json(raw["portfolios"]))
        options.update(raw.get("options") or {})
        return raw["portfolios"], options
    return raw, options_from_streamlit_json(raw)


def write_payload(payload: dict, out: Path, compress: bool | None = None) -> None:
    data = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if compress if compress is not None else out.suffix == ".gz":
        data = gzip.compress(data, compresslevel=6)
    out.write_bytes(data)


def _cmd_run(args: argparse.Namespace) -> int:
    import shutil
    import tempfile

    from .context import BacktestCancelled, BacktestError
    from .pipeline import load_bundle, run_local

    request_path = Path(args.request).resolve()
    out = Path(args.output).resolve() if args.output else request_path.with_name(request_path.stem + ".result.json.gz")
    portfolios, options = split_request(json.loads(request_path.read_text(encoding="utf-8")))

    def progress(fraction: float, message: str) -> None:
        if not args.quiet:
            print(json.dumps({"progress": round(fraction, 4), "message": message}), file=sys.stderr, flush=True)

    workers = args.workers if args.workers > 0 else max(1, (os.cpu_count() or 2) - 1)
    t0 = time.perf_counter()
    job_dir = Path(tempfile.mkdtemp(prefix="bt-cli-"))
    try:
        # The legacy code prints debug traces; keep stdout clean for callers.
        with open(os.devnull, "w", encoding="utf-8") as devnull, contextlib.redirect_stdout(devnull):
            _dir, info = run_local(portfolios, options, job_dir=job_dir, workers=workers, progress=progress)
        write_payload(load_bundle(job_dir), out)
    except (BacktestError, BacktestCancelled) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr, flush=True)
        return 2
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)
    print(json.dumps({"done": True, "output": str(out), "portfolios": info["portfolios"],
                      "seconds": round(time.perf_counter() - t0, 2)}), file=sys.stderr, flush=True)
    return 0


def _cmd_serve(args: argparse.Namespace) -> int:
    import uvicorn

    uvicorn.run("server.app:app", host=args.host, port=args.port, workers=1, log_level="info")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="backtest_engine")
    sub = ap.add_subparsers(dest="cmd", required=True)

    run_p = sub.add_parser("run", help="run a backtest request file")
    run_p.add_argument("request")
    run_p.add_argument("-o", "--output")
    run_p.add_argument("-q", "--quiet", action="store_true")
    run_p.add_argument("-w", "--workers", type=int, default=0, help="parallel processes (default: CPU count - 1)")
    run_p.set_defaults(fn=_cmd_run)

    serve_p = sub.add_parser("serve", help="start the HTTP engine")
    serve_p.add_argument("--host", default="127.0.0.1")
    serve_p.add_argument("--port", type=int, default=8765)
    serve_p.set_defaults(fn=_cmd_serve)

    ver_p = sub.add_parser("version")
    ver_p.set_defaults(fn=lambda _a: print(__version__) or 0)

    args = ap.parse_args(argv)
    return int(args.fn(args) or 0)
