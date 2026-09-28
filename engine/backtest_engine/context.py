"""Run options and the progress/cancellation context passed to the runner."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Optional


class BacktestCancelled(Exception):
    pass


class BacktestError(Exception):
    """Configuration or data problem reported to the user (Streamlit showed st.error)."""


@dataclass
class RunOptions:
    """Global options that the Streamlit sidebar stored in st.session_state."""

    # 'all': start when every asset has data; 'oldest': start with the oldest asset.
    start_with: str = "all"
    # 'rebalancing_date' or 'momentum_window_complete' (Streamlit default).
    first_rebalance_strategy: str = "momentum_window_complete"
    # Start earlier to warm up momentum windows, then truncate the display.
    auto_adjust_momentum_start: bool = False
    # Custom date range applied to every portfolio (ISO dates), like the sidebar dates.
    start_date: Optional[str] = None
    end_date: Optional[str] = None

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RunOptions":
        data = data or {}
        known = {k: data[k] for k in cls.__dataclass_fields__ if k in data}
        opts = cls(**known)
        if opts.start_with not in ("all", "oldest"):
            opts.start_with = "all"
        if opts.first_rebalance_strategy not in ("rebalancing_date", "momentum_window_complete"):
            opts.first_rebalance_strategy = "momentum_window_complete"
        opts.auto_adjust_momentum_start = bool(opts.auto_adjust_momentum_start)
        return opts

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def session_state(self) -> dict[str, Any]:
        return {
            "multi_backtest_start_with": self.start_with,
            "multi_backtest_first_rebalance_strategy": self.first_rebalance_strategy,
            "multi_backtest_auto_adjust_momentum_start": self.auto_adjust_momentum_start,
            "hard_kill_requested": False,
            "use_parallel_processing": False,
        }


ProgressFn = Callable[[float, str], None]


@dataclass
class RunContext:
    progress_fn: Optional[ProgressFn] = None
    cancel_fn: Optional[Callable[[], bool]] = None
    warnings: list[str] = field(default_factory=list)

    def progress(self, fraction: float, message: str) -> None:
        if self.progress_fn:
            self.progress_fn(max(0.0, min(1.0, float(fraction))), message)

    def check_cancelled(self) -> None:
        if self.cancel_fn and self.cancel_fn():
            raise BacktestCancelled("Backtest cancelled")

    def warn(self, message: str) -> None:
        self.warnings.append(message)
