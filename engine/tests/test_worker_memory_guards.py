"""Scheduler / worker sizing must not start more S&P sleeves than RAM can hold."""

from server.jobs import _HEAVY_MEMORY_SCORE, _parallel_for_memory
from server.settings import _default_workers


def test_heavy_sp500_score_runs_one_portfolio_at_a_time():
    # ~500 tickers × ~23700 calendar days
    assert _parallel_for_memory({"memory_score": 500 * 23700}) == 1
    assert _parallel_for_memory({"tickers": 500, "sim_days": 23700}) == 1


def test_medium_score_caps_at_two():
    assert _parallel_for_memory({"memory_score": _HEAVY_MEMORY_SCORE // 2}) == 2


def test_small_score_allows_full_parallel():
    assert _parallel_for_memory({"memory_score": 50 * 2000}) == 12
    assert _parallel_for_memory({}) == 12


def test_default_workers_use_heavier_ram_budget(monkeypatch):
    monkeypatch.setattr("server.settings._available_ram_gb", lambda: 8.0)
    monkeypatch.setattr("server.settings.os.cpu_count", lambda: 16)
    # 8 / 2.5 = 3 workers (not 8/0.6 ≈ 13 capped at 12)
    assert _default_workers("local") == 3
