"""Bearer-token authentication against Supabase Auth.

The browser sends the Supabase session access token. It is validated by
asking Supabase itself (GET /auth/v1/user), which works for both legacy
HS256 and the newer asymmetric signing keys without sharing any secret with
the engine host. Valid tokens are cached for a few minutes.
"""

from __future__ import annotations

import hashlib
import threading
import time

import requests
from fastapi import Header, HTTPException, Request

from .settings import Settings

_CACHE_TTL_S = 300
_cache: dict[str, tuple[str, float]] = {}
_lock = threading.Lock()


def _verify_with_supabase(settings: Settings, token: str) -> str:
    key = hashlib.sha256(token.encode()).hexdigest()
    now = time.time()
    with _lock:
        hit = _cache.get(key)
        if hit and hit[1] > now:
            return hit[0]
    try:
        resp = requests.get(
            f"{settings.supabase_url}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": settings.supabase_anon_key},
            timeout=10,
        )
    except requests.RequestException as exc:
        raise HTTPException(503, f"Auth provider unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(401, "Invalid or expired session")
    user_id = str(resp.json().get("id") or "")
    if not user_id:
        raise HTTPException(401, "Invalid session")
    with _lock:
        if len(_cache) > 1000:
            _cache.clear()
        _cache[key] = (user_id, now + _CACHE_TTL_S)
    return user_id


def current_user(request: Request, authorization: str | None = Header(default=None)) -> str:
    settings: Settings = request.app.state.settings
    if settings.auth == "none":
        return "local"
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    return _verify_with_supabase(settings, authorization.split(" ", 1)[1].strip())
