"""Headless stand-in for the `streamlit` module used by the extracted legacy code.

The legacy engine reads a handful of options from `st.session_state` and calls
UI helpers (st.write, st.warning, st.progress...). Here `session_state` is a
plain process-wide store populated from `RunOptions`, and every UI call is a
silent no-op. Each backtest job runs in its own process, so a process-global
store is safe.
"""

from __future__ import annotations

from collections.abc import MutableMapping
from typing import Any, Callable, Iterator


class StopRun(Exception):
    """Raised where Streamlit would call st.stop() / st.rerun()."""


class _SessionState(MutableMapping):
    def __init__(self) -> None:
        object.__setattr__(self, "_data", {})

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self._data[key] = value

    def __delitem__(self, key: str) -> None:
        del self._data[key]

    def __iter__(self) -> Iterator[str]:
        return iter(list(self._data))

    def __len__(self) -> int:
        return len(self._data)

    def __getattr__(self, key: str) -> Any:
        try:
            return self._data[key]
        except KeyError as exc:
            raise AttributeError(key) from exc

    def __setattr__(self, key: str, value: Any) -> None:
        self._data[key] = value

    def __delattr__(self, key: str) -> None:
        try:
            del self._data[key]
        except KeyError as exc:
            raise AttributeError(key) from exc

    def reset(self, values: dict[str, Any] | None = None) -> None:
        self._data.clear()
        self._data["api_call_count"] = 0
        if values:
            self._data.update(values)


class _Noop:
    """Absorbs any UI call chain: callable, attribute access, context manager.

    Falsy so that `if st.button(...)` style checks never trigger.
    """

    def __call__(self, *args: Any, **kwargs: Any) -> "_Noop":
        return self

    def __getattr__(self, name: str) -> "_Noop":
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return self

    def __enter__(self) -> "_Noop":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def __bool__(self) -> bool:
        return False

    def __iter__(self) -> Iterator[Any]:
        return iter(())


_NOOP = _Noop()


def _passthrough_decorator(*dargs: Any, **dkwargs: Any) -> Any:
    """Supports both `@st.cache_data` and `@st.cache_data(ttl=...)`."""

    def wrap(fn: Callable) -> Callable:
        fn.clear = lambda *a, **k: None  # type: ignore[attr-defined]
        return fn

    if len(dargs) == 1 and callable(dargs[0]) and not dkwargs:
        return wrap(dargs[0])
    return wrap


class _StreamlitShim:
    def __init__(self) -> None:
        self.session_state = _SessionState()
        self.secrets: dict[str, Any] = {}
        self.cache_data = _passthrough_decorator
        self.cache_resource = _passthrough_decorator
        self.cache = _passthrough_decorator
        self.fragment = _passthrough_decorator
        self.experimental_fragment = _passthrough_decorator
        self.sidebar = _NOOP
        self.messages: list[tuple[str, str]] = []

    def _record(self, level: str, body: Any = "", *args: Any, **kwargs: Any) -> _Noop:
        if len(self.messages) < 500:
            self.messages.append((level, str(body)))
        return _NOOP

    def error(self, *args: Any, **kwargs: Any) -> _Noop:
        return self._record("error", *args, **kwargs)

    def warning(self, *args: Any, **kwargs: Any) -> _Noop:
        return self._record("warning", *args, **kwargs)

    def exception(self, *args: Any, **kwargs: Any) -> _Noop:
        return self._record("error", *args, **kwargs)

    def dialog(self, *args: Any, **kwargs: Any) -> Callable:
        return lambda fn: fn

    def columns(self, spec: Any = 2, *args: Any, **kwargs: Any) -> list[_Noop]:
        n = spec if isinstance(spec, int) else len(spec)
        return [_NOOP] * n

    def tabs(self, labels: Any, *args: Any, **kwargs: Any) -> list[_Noop]:
        return [_NOOP] * len(labels)

    def stop(self) -> None:
        raise StopRun("st.stop()")

    def rerun(self) -> None:
        raise StopRun("st.rerun()")

    experimental_rerun = rerun

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _NOOP


st = _StreamlitShim()
