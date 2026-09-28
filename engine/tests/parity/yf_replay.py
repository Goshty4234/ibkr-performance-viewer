"""Record/replay of yfinance calls so parity runs use frozen prices.

record: real Yahoo calls are made and their results stored in a pickle.
replay: every call is served from the pickle; a missing key is an error.
Both the Streamlit reference and the extracted engine run under the same
replay store, so any difference comes from the code, not from the data.
"""

from __future__ import annotations

import pickle
import threading
from pathlib import Path
from typing import Any

import yfinance as yf

_REAL_TICKER = yf.Ticker
_REAL_DOWNLOAD = yf.download


class ReplayStore:
    def __init__(self, path: Path, mode: str) -> None:
        assert mode in ("record", "replay")
        self.path = path
        self.mode = mode
        self.lock = threading.Lock()
        self.data: dict[Any, Any] = {}
        if path.exists():
            self.data = pickle.loads(path.read_bytes())
        elif mode == "replay":
            raise FileNotFoundError(f"No recorded prices at {path}; run with --record first")

    def fetch(self, key: tuple, real_call) -> Any:
        with self.lock:
            if key in self.data:
                value = self.data[key]
                return value.copy() if hasattr(value, "copy") else value
        if self.mode == "replay":
            raise KeyError(f"Not recorded: {key}")
        value = real_call()
        with self.lock:
            self.data[key] = value.copy() if hasattr(value, "copy") else value
        return value

    def save(self) -> None:
        if self.mode == "record":
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_bytes(pickle.dumps(self.data, protocol=pickle.HIGHEST_PROTOCOL))


_STORE: ReplayStore | None = None


def _kw_key(kwargs: dict) -> tuple:
    return tuple(sorted((k, repr(v)) for k, v in kwargs.items() if k not in ("progress", "threads")))


class ReplayTicker:
    def __init__(self, ticker: str, *args: Any, **kwargs: Any) -> None:
        self.ticker = ticker

    def history(self, *args: Any, **kwargs: Any):
        key = ("history", self.ticker, repr(args), _kw_key(kwargs))
        return _STORE.fetch(key, lambda: _REAL_TICKER(self.ticker).history(*args, **kwargs))

    @property
    def info(self):
        return _STORE.fetch(("info", self.ticker), lambda: _REAL_TICKER(self.ticker).info)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        return _STORE.fetch(("attr", self.ticker, name), lambda: getattr(_REAL_TICKER(self.ticker), name))


def replay_download(tickers: Any, *args: Any, **kwargs: Any):
    norm = tuple(sorted(tickers)) if isinstance(tickers, (list, tuple, set)) else (tickers,)
    key = ("download", norm, repr(args), _kw_key(kwargs))
    return _STORE.fetch(key, lambda: _REAL_DOWNLOAD(tickers, *args, **kwargs))


def install(path: Path | str, mode: str) -> ReplayStore:
    global _STORE
    _STORE = ReplayStore(Path(path), mode)
    yf.Ticker = ReplayTicker
    yf.download = replay_download
    return _STORE
