"""Endpoints of the local library (see backtest_engine.library). Only a local engine serves them:
on a cloud host the files would belong to nobody in particular, so they answer 404 there.

    PUT/GET/DELETE  /library/runs/{user}/{run}[/{file}]     result files of a saved run
    GET             /library/runs/{user}                    runs held here (with their meta.json)
    PUT/GET/DELETE  /library/ibkr/{user}/{name}             IBKR viewer statements (raw files)
    GET             /library/ibkr/{user}
    PUT/GET         /library/configs/{user}                 backup copy of the saved configurations
    GET             /storage                                size of the data folder, per sub-folder
    POST            /storage/purge                          delete runs / IBKR files / caches
    GET/PUT         /storage/settings                       automatic cleaning
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel

from backtest_engine.library import MAX_FILE_BYTES, Library, LibraryError

from .auth import current_user, is_guest

router = APIRouter()


def _lib(request: Request) -> Library:
    lib = getattr(request.app.state, "library", None)
    if lib is None:
        raise HTTPException(404, "Bibliothèque locale indisponible sur ce moteur.")
    return lib


def _writer(user: str) -> None:
    if is_guest(user):
        raise HTTPException(403, "Mode invité : rien n'est conservé.")


async def _body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_FILE_BYTES:
        raise HTTPException(413, "Fichier trop gros.")
    data = await request.body()
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, "Fichier trop gros.")
    return data


def _bad(exc: LibraryError) -> HTTPException:
    return HTTPException(400, str(exc))


def _file(path: Any) -> Response:
    if path is None:
        raise HTTPException(404, "Introuvable")
    return Response(path.read_bytes(), media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


@router.put("/library/runs/{uid}/{run}/{name:path}")
async def put_run_file(uid: str, run: str, name: str, request: Request, user: str = Depends(current_user)) -> dict:
    _writer(user)
    lib = _lib(request)
    data = await _body(request)
    try:
        return {"bytes": lib.put_run_file(uid, run, name, data)}
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.get("/library/runs/{uid}/{run}/{name:path}")
def get_run_file(uid: str, run: str, name: str, request: Request, user: str = Depends(current_user)) -> Response:
    try:
        return _file(_lib(request).get_run_file(uid, run, name))
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.delete("/library/runs/{uid}/{run}")
def delete_run(uid: str, run: str, request: Request, user: str = Depends(current_user)) -> dict:
    _writer(user)
    try:
        return {"deleted": _lib(request).delete_run(uid, run)}
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.get("/library/runs/{uid}")
def list_runs(uid: str, request: Request, user: str = Depends(current_user)) -> dict:
    try:
        return {"runs": _lib(request).list_runs(uid)}
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.put("/library/ibkr/{uid}/{name}")
async def put_ibkr(uid: str, name: str, request: Request, user: str = Depends(current_user)) -> dict:
    _writer(user)
    lib = _lib(request)
    data = await _body(request)
    try:
        return {"bytes": lib.put_ibkr(uid, name, data)}
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.get("/library/ibkr/{uid}/{name}")
def get_ibkr(uid: str, name: str, request: Request, user: str = Depends(current_user)) -> Response:
    lib = _lib(request)
    try:
        p = lib.ibkr_file(uid, name)
    except LibraryError as exc:
        raise _bad(exc) from exc
    return _file(p if p.is_file() else None)


@router.delete("/library/ibkr/{uid}/{name}")
def delete_ibkr(uid: str, name: str, request: Request, user: str = Depends(current_user)) -> dict:
    _writer(user)
    try:
        return {"deleted": _lib(request).delete_ibkr(uid, name)}
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.get("/library/ibkr/{uid}")
def list_ibkr(uid: str, request: Request, user: str = Depends(current_user)) -> dict:
    try:
        return {"files": _lib(request).list_ibkr(uid)}
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.put("/library/configs/{uid}")
async def put_configs(uid: str, request: Request, user: str = Depends(current_user)) -> dict:
    _writer(user)
    lib = _lib(request)
    data = await _body(request)
    try:
        return {"bytes": lib.put_configs(uid, data)}
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.get("/library/configs/{uid}")
def get_configs(uid: str, request: Request, user: str = Depends(current_user)) -> Response:
    try:
        return _file(_lib(request).get_configs(uid))
    except LibraryError as exc:
        raise _bad(exc) from exc


@router.get("/storage")
def storage_usage(request: Request, user: str = Depends(current_user)) -> dict:
    return _lib(request).usage()


class PurgeBody(BaseModel):
    target: str  # runs | ibkr | cache | prices
    older_than_days: int | None = None
    keep_pinned: bool = True
    user: str | None = None


@router.post("/storage/purge")
def storage_purge(body: PurgeBody, request: Request, user: str = Depends(current_user)) -> dict:
    _writer(user)
    lib = _lib(request)
    try:
        if body.target == "runs":
            days = body.older_than_days if body.older_than_days is None or body.older_than_days >= 0 else 0
            return lib.clean_runs(days, keep_pinned=body.keep_pinned, user=body.user)
        if body.target == "ibkr":
            return lib.clean_ibkr(body.user)
        if body.target in ("cache", "prices"):
            if request.app.state.manager.stats().get("running"):
                raise HTTPException(409, "Des backtests sont en cours : réessaie quand ils sont terminés.")
            if body.target == "cache":
                return lib.clean_cache()
            from backtest_engine.data_api import clear_caches

            return {"removed": 0, "freed": 0, **clear_caches()}
    except LibraryError as exc:
        raise _bad(exc) from exc
    raise HTTPException(400, "Cible inconnue.")


class SettingsBody(BaseModel):
    auto_clean_days: int | None = None
    keep_pinned: bool | None = None
    min_free_gb: int | None = None


@router.get("/storage/settings")
def storage_settings(request: Request, user: str = Depends(current_user)) -> dict:
    return _lib(request).settings()


@router.put("/storage/settings")
def storage_settings_put(body: SettingsBody, request: Request, user: str = Depends(current_user)) -> dict:
    _writer(user)
    return _lib(request).set_settings(body.model_dump(exclude_none=True))
