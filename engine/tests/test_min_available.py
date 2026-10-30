"""The minimum-available-stocks gate stays off unless the portfolio asks for it."""

from backtest_engine.config import min_available_blocks, normalize_one


def test_off_unless_asked():
    assert min_available_blocks({}, 0) is False
    assert min_available_blocks({"use_min_available_stocks": False, "min_available_stocks": 20}, 1) is False
    assert min_available_blocks({"use_min_available_stocks": True, "min_available_stocks": 0}, 0) is False


def test_cash_below_the_threshold():
    cfg = {"use_min_available_stocks": True, "min_available_stocks": 20}
    assert min_available_blocks(cfg, 15) is True
    assert min_available_blocks(cfg, 20) is False
    assert min_available_blocks(cfg, 21) is False


def test_normalize_keeps_the_gate():
    out = normalize_one({
        "name": "P",
        "stocks": [{"ticker": "SPY", "allocation": 1}],
        "use_min_available_stocks": True,
        "min_available_stocks": 20,
    })
    assert out["use_min_available_stocks"] is True
    assert out["min_available_stocks"] == 20


def test_normalize_defaults_off():
    out = normalize_one({"name": "P", "stocks": [{"ticker": "SPY", "allocation": 1}]})
    assert out["use_min_available_stocks"] is False
    assert out["min_available_stocks"] == 20
