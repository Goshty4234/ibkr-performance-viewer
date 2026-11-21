"""Day readers must not box every calendar day into Python scalars (S&P OOM)."""

from __future__ import annotations

import numpy as np
import pandas as pd

from backtest_engine.accel import accel_day_readers


def _frame(idx: pd.DatetimeIndex) -> pd.DataFrame:
    close = np.linspace(100.0, 200.0, len(idx), dtype=np.float64)
    return pd.DataFrame({
        "Close": close,
        "Price_change": np.concatenate([[0.0], np.diff(close) / close[:-1]]),
        "Dividends": np.zeros(len(idx), dtype=np.float64),
    }, index=idx)


def test_day_readers_keep_ndarray_not_python_lists():
    idx = pd.date_range("1961-01-03", periods=24_000, freq="D")
    tickers = [f"T{i:03d}" for i in range(40)]
    data = {t: _frame(idx) for t in tickers}
    readers = accel_day_readers({}, data, tickers, idx, parse_ticker_parameters=lambda t: (t, 1.0, 0.0))
    assert len(readers) == 40
    sample = readers[tickers[0]]
    assert isinstance(sample.close, np.ndarray)
    assert isinstance(sample.pchg, np.ndarray)
    assert isinstance(sample.div, np.ndarray)
    assert isinstance(sample.first_ok, np.ndarray)
    assert sample.close.dtype == np.float64
    # Indexing still yields a numpy scalar (same family the loop always used).
    assert isinstance(sample.close[100], np.floating)
    assert sample.first_ok[0] in (True, False, np.True_, np.False_)


def test_day_readers_scale_without_per_element_boxing():
    """40 × 24k list-of-scalars used to be hundreds of MB; arrays stay ~tens of MB."""
    idx = pd.date_range("1961-01-03", periods=24_000, freq="D")
    tickers = [f"T{i:03d}" for i in range(40)]
    data = {t: _frame(idx) for t in tickers}
    readers = accel_day_readers({}, data, tickers, idx, parse_ticker_parameters=lambda t: (t, 1.0, 0.0))
    # Contiguous payload only (close+pchg+div+first_ok) ≈ 40 * 24000 * (8+8+8+1) ≈ 60 MB.
    nbytes = 0
    for d in readers.values():
        for arr in (d.close, d.pchg, d.div, d.first_ok):
            if isinstance(arr, np.ndarray):
                nbytes += arr.nbytes
    assert nbytes < 80 * 1024 * 1024
