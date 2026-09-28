"""Keeps only the definitions of a Streamlit page script.

Streamlit pages mix function definitions with top-level UI code. This module
parses the script and keeps imports, functions, classes and constant
assignments, dropping every statement that renders UI or touches
`st.session_state` at import time. Function bodies are kept byte-for-byte.
"""

from __future__ import annotations

import ast

_KEEP_EXPR_CALLS = {
    ("warnings", "filterwarnings"),
    ("pd", "set_option"),
}

_UI_NAMES = {"st", "plt"}


def _names_in(node: ast.AST) -> set[str]:
    """Free names read by an expression (comprehension/lambda variables excluded)."""
    loaded = {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    stored = {n.id for n in ast.walk(node) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    lambda_args = {a.arg for n in ast.walk(node) if isinstance(n, ast.Lambda) for a in n.args.args}
    return loaded - stored - lambda_args


def _keep_expr(node: ast.Expr) -> bool:
    call = node.value
    if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute):
        return False
    owner = call.func.value
    return isinstance(owner, ast.Name) and (owner.id, call.func.attr) in _KEEP_EXPR_CALLS


def _guarded_import(node: ast.Import | ast.ImportFrom, src: str) -> str | None:
    if isinstance(node, ast.Import):
        if any(alias.name.split(".")[0] == "streamlit" for alias in node.names):
            return None
        bound = [alias.asname or alias.name.split(".")[0] for alias in node.names]
    else:
        if (node.module or "").split(".")[0] == "streamlit":
            return None
        bound = [alias.asname or alias.name for alias in node.names if alias.name != "*"]
    stmt = ast.get_source_segment(src, node)
    fallback = " = ".join(bound) + " = None" if bound else "pass"
    return f"try:\n    {stmt}\nexcept ImportError:\n    {fallback}"


def _bound_by_import(node: ast.Import | ast.ImportFrom) -> set[str]:
    if isinstance(node, ast.Import):
        return {alias.asname or alias.name.split(".")[0] for alias in node.names}
    return {alias.asname or alias.name for alias in node.names}


def _assign_targets(node: ast.Assign | ast.AnnAssign) -> set[str]:
    targets = node.targets if isinstance(node, ast.Assign) else [node.target]
    names: set[str] = set()
    for t in targets:
        if isinstance(t, ast.Name):
            names.add(t.id)
        elif isinstance(t, ast.Tuple):
            names.update(e.id for e in t.elts if isinstance(e, ast.Name))
    return names


def filter_definitions(src: str) -> str:
    import builtins

    tree = ast.parse(src)
    kept: list[str] = []
    defined: set[str] = set(dir(builtins))
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            guarded = _guarded_import(node, src)
            if guarded:
                kept.append(guarded)
                defined |= _bound_by_import(node)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
            segment = ast.get_source_segment(src, node)
            if node.decorator_list:
                first = node.decorator_list[0]
                start = first.lineno - 1
                lines = src.splitlines()
                segment = "\n".join(lines[start : node.end_lineno])
            kept.append(segment)
        elif isinstance(node, (ast.Assign, ast.AnnAssign)):
            targets = _assign_targets(node)
            value = node.value
            if value is None or not targets:
                continue
            used = _names_in(value)
            if not (used & _UI_NAMES) and used <= defined:
                kept.append(ast.get_source_segment(src, node))
                defined |= targets
        elif isinstance(node, ast.Expr) and _keep_expr(node):
            kept.append(ast.get_source_segment(src, node))
    return "\n\n".join(kept) + "\n"


def find_top_level_if(src: str, predicate_substring: str) -> ast.If:
    """Returns the first top-level `if` whose test source contains the substring."""
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.If) and predicate_substring in ast.get_source_segment(src, node.test):
            return node
    raise LookupError(predicate_substring)


def find_if_at_line(src: str, lineno_hint: int, test_substring: str) -> ast.If:
    """Returns the `if` node (at any depth) closest to a line whose test matches."""
    tree = ast.parse(src)
    best: ast.If | None = None
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and test_substring in ast.get_source_segment(src, node.test):
            if best is None or abs(node.lineno - lineno_hint) < abs(best.lineno - lineno_hint):
                best = node
    if best is None:
        raise LookupError(test_substring)
    return best


def body_source(src: str, node: ast.If) -> str:
    """Source of an `if` body, dedented to module level."""
    import textwrap

    lines = src.splitlines()
    start = node.body[0].lineno - 1
    end = node.body[-1].end_lineno
    return textwrap.dedent("\n".join(lines[start:end])) + "\n"
