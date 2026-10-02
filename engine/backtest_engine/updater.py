"""Self-update of the portable engine (standard library only).

Package layout (folder MomentumBacktesterEngine/):
    Lancer le moteur.cmd   starts runtimes/<runtime.txt>/python.exe -m mbt_launcher, again on exit code 75
    mbt_launcher.py        copy of backtest_engine/portable_launcher.py: runs versions/<code>, rolls back
    runtime.txt            runtime folder the .cmd starts (mirror of state.json "runtime")
    state.json             {"code", "runtime"} (+ "previous", "pending", "tries" right after an update)
    runtimes/<id>/         embedded Python + libraries; id = Python version + requirements hash
    versions/<tag>/        engine code (backtest_engine, server, Complete_Tickers, build.json)

Each release publishes manifest.json (version, api, code_sha, runtime, asset urls + sha256),
engine-code.zip (the versions/<tag> content, a few MB) and the full zip. The engine compares the
manifest with its own build.json: same code_sha and runtime = identical, nothing to do. Otherwise
it downloads the code zip (code changed) or the full zip (Python or a library changed), checks
the sha256, unpacks into a new folder beside the running one, imports the new version with its
runtime as a smoke test, and only then switches state.json. A version that does not start is
rolled back by the launcher. The data home (ticker store, caches, jobs) is never touched; caches
keyed on the engine code invalidate themselves.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable

from . import API_VERSION, ENGINE_ROOT, __version__

MANIFEST_URL = os.environ.get(
    "ENGINE_UPDATE_URL",
    "https://github.com/Goshty4234/ibkr-performance-viewer/releases/latest/download/manifest.json",
)
RESTART = 75
CHECK_EVERY_S = 6 * 3600
PACKAGE = "MomentumBacktesterEngine"
SMOKE = ("import scipy.optimize, numpy, pandas, yfinance, curl_cffi, diskcache, bs4, lxml; "
         "import backtest_engine.legacy.multi_backtest, backtest_engine.legacy.allocations, "
         "backtest_engine.portable, server.app")

_lock = threading.Lock()
# Held while a check / download / switch runs: one at a time, and no cleanup meanwhile.
_busy = threading.Lock()
_status: dict[str, Any] = {"state": "idle"}
_staged: dict[str, str] | None = None
_restart = threading.Event()
_server: Any = None


def root() -> Path | None:
    """Package folder when running from a self-updating portable package, else None."""
    versions = ENGINE_ROOT.parent
    if versions.name == "versions" and (versions.parent / "state.json").exists():
        return versions.parent
    return None


def enabled() -> bool:
    return root() is not None and bool(MANIFEST_URL)


def build_info() -> dict:
    try:
        return json.loads((ENGINE_ROOT / "build.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": __version__, "api": API_VERSION}


def runtime_id() -> str:
    return Path(sys.executable).resolve().parent.name


def status() -> dict:
    with _lock:
        return {**_status, "current": build_info().get("version", __version__)}


def _set(**fields: Any) -> None:
    with _lock:
        _status.clear()
        _status.update(fields)


def _write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def read_state(pkg: Path) -> dict:
    return json.loads((pkg / "state.json").read_text(encoding="utf-8"))


def write_state(pkg: Path, state: dict) -> None:
    # state.json first: the launcher trusts it and fixes runtime.txt when they disagree.
    _write(pkg / "state.json", json.dumps(state, indent=1))
    _write(pkg / "runtime.txt", state["runtime"])


def fetch_manifest(timeout: float = 10.0) -> dict:
    req = urllib.request.Request(MANIFEST_URL, headers={"User-Agent": "momentum-engine", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        m = json.loads(r.read().decode("utf-8"))
    if not {"version", "code_sha", "runtime", "assets"} <= set(m):
        raise ValueError("manifeste incomplet")
    return m


def wanted(manifest: dict) -> str | None:
    """None when this engine is the published one, else what has to be downloaded."""
    if manifest["runtime"] != runtime_id():
        return "runtime"
    if manifest["code_sha"] != build_info().get("code_sha"):
        return "code"
    return None


def skipped(manifest: dict) -> bool:
    """This release already failed to start here (rolled back by the launcher)."""
    pkg = root()
    try:
        skip = read_state(pkg).get("skip") if pkg else None
    except (OSError, ValueError):
        return False
    return bool(skip) and skip in (manifest["version"], f"{manifest['version']}-{manifest['code_sha'][:8]}")


def _skipped_status(m: dict) -> None:
    _set(state="error", latest=m["version"], latest_api=m.get("api"),
         error=f"la version {m['version']} n'a pas démarré sur ce PC : on attend la suivante")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(asset: dict, dest: Path, progress: Callable[[float], None]) -> None:
    if dest.exists() and _sha256(dest) == asset["sha256"]:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    h = hashlib.sha256()
    done = 0
    req = urllib.request.Request(asset["url"], headers={"User-Agent": "momentum-engine"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        for chunk in iter(lambda: r.read(1 << 20), b""):
            f.write(chunk)
            h.update(chunk)
            done += len(chunk)
            progress(min(1.0, done / max(1, int(asset.get("size") or 0) or done)))
    if h.hexdigest() != asset["sha256"]:
        tmp.unlink(missing_ok=True)
        raise ValueError("fichier téléchargé corrompu (empreinte différente) : réessaie plus tard")
    os.replace(tmp, dest)


def _extract(z: zipfile.ZipFile, prefix: str, dest: Path) -> None:
    """Members under prefix into dest (a fresh .part folder renamed when complete)."""
    part = dest.with_name(dest.name + ".part")
    shutil.rmtree(part, ignore_errors=True)
    base = part.resolve()
    found = False
    for info in z.infolist():
        if not info.filename.startswith(prefix) or info.is_dir():
            continue
        target = (part / info.filename[len(prefix):]).resolve()
        if base not in target.parents:
            raise ValueError(f"chemin invalide dans l'archive : {info.filename}")
        target.parent.mkdir(parents=True, exist_ok=True)
        with z.open(info) as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)
        found = True
    if not found:
        raise ValueError(f"archive incomplète ({prefix or 'code'} absent)")
    shutil.rmtree(dest, ignore_errors=True)
    os.replace(part, dest)


def _code_ok(code_dir: Path, code_sha: str) -> bool:
    try:
        return json.loads((code_dir / "build.json").read_text(encoding="utf-8")).get("code_sha") == code_sha
    except (OSError, ValueError):
        return False


def _smoke(runtime_dir: Path, code_dir: Path) -> None:
    env = {**os.environ, "ENGINE_ORIGINS_URL": ""}
    env.pop("PYTHONPATH", None)
    script = f"import sys; sys.path.insert(0, {str(code_dir)!r}); {SMOKE}"
    r = subprocess.run([str(runtime_dir / "python.exe"), "-c", script], cwd=str(code_dir), env=env,
                       capture_output=True, text=True, timeout=600,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if r.returncode:
        raise RuntimeError("la nouvelle version ne démarre pas : " + (r.stderr or r.stdout).strip()[-500:])


def stage(manifest: dict) -> dict[str, str]:
    """Downloads, verifies and unpacks the published version next to the running one."""
    global _staged
    pkg = root()
    if pkg is None:
        raise RuntimeError("mise à jour automatique indisponible (moteur hors paquet portable)")
    kind = wanted(manifest)
    if kind is None:
        raise RuntimeError("déjà à jour")
    version, rt = manifest["version"], manifest["runtime"]
    code_name = version if (pkg / "versions" / version).resolve() != ENGINE_ROOT else f"{version}-{manifest['code_sha'][:8]}"
    code_dir = pkg / "versions" / code_name
    rt_dir = pkg / "runtimes" / rt
    rt_ready = (rt_dir / ".ok").exists() or rt == runtime_id()

    def progress(f: float) -> None:
        _set(state="downloading", latest=version, latest_api=manifest.get("api"), kind=kind, progress=round(f, 3))

    progress(0.0)
    if not rt_ready:
        asset = manifest["assets"]["full"]
        archive = pkg / ".downloads" / asset["name"]
        _download(asset, archive, progress)
        with zipfile.ZipFile(archive) as z:
            _extract(z, f"{PACKAGE}/runtimes/{rt}/", rt_dir)
            if not _code_ok(code_dir, manifest["code_sha"]):
                _extract(z, f"{PACKAGE}/versions/{version}/", code_dir)
    elif not _code_ok(code_dir, manifest["code_sha"]):
        asset = manifest["assets"]["code"]
        archive = pkg / ".downloads" / asset["name"]
        _download(asset, archive, progress)
        with zipfile.ZipFile(archive) as z:
            _extract(z, "", code_dir)
    if not _code_ok(code_dir, manifest["code_sha"]):
        raise ValueError("version téléchargée différente du manifeste")
    _set(state="verifying", latest=version, latest_api=manifest.get("api"), kind=kind)
    _smoke(rt_dir if rt != runtime_id() else Path(sys.executable).resolve().parent, code_dir)
    if rt != runtime_id():
        (rt_dir / ".ok").write_text(version, encoding="utf-8")
    _staged = {"code": code_name, "runtime": rt, "version": version}
    _set(state="ready", latest=version, latest_api=manifest.get("api"), kind=kind)
    return _staged


def apply() -> None:
    """Points state.json at the staged version (the launcher starts it after the restart)."""
    pkg = root()
    if pkg is None or _staged is None:
        raise RuntimeError("aucune mise à jour prête")
    state = read_state(pkg)
    write_state(pkg, {"code": _staged["code"], "runtime": _staged["runtime"],
                      "previous": {"code": state["code"], "runtime": state["runtime"]}, "pending": True, "tries": 0})


def check_and_stage(manifest: dict | None = None) -> dict:
    """Fetch the manifest (unless given) and stage what changed; never restarts by itself."""
    if not enabled():
        _set(state="disabled")
        return status()
    if not _busy.acquire(blocking=False):
        return status()
    try:
        _set(state="checking")
        m = manifest or fetch_manifest()
        if wanted(m) is None:
            _set(state="current", latest=m["version"], latest_api=m.get("api"))
        elif skipped(m):
            _skipped_status(m)
        elif not (_staged and _staged["version"] == m["version"]):
            stage(m)
        else:
            _set(state="ready", latest=m["version"], latest_api=m.get("api"))
    except Exception as exc:  # noqa: BLE001 - offline, GitHub down, broken download: keep running as is
        _set(state="error", error=str(exc)[:300])
    finally:
        _busy.release()
    return status()


def check_async() -> dict:
    threading.Thread(target=check_and_stage, daemon=True, name="engine-update").start()
    time.sleep(0.05)
    return status()


def startup(say: Callable[[str], None]) -> bool:
    """At launch, before serving: a code update (small) is applied right away; a runtime update
    (whole package) downloads in the background and applies at the next start or on request.
    Returns True when the engine must restart on the new version."""
    if not enabled():
        _set(state="disabled")
        return False
    _set(state="checking")
    try:
        m = fetch_manifest(timeout=4)
    except Exception as exc:  # noqa: BLE001
        _set(state="error", error=f"vérification impossible ({exc})"[:300])
        return False
    kind = wanted(m)
    if kind is None:
        _set(state="current", latest=m["version"], latest_api=m.get("api"))
        return False
    if skipped(m):
        _skipped_status(m)
        return False
    pkg = root()
    staged_rt = pkg is not None and (pkg / "runtimes" / m["runtime"] / ".ok").exists()
    if kind == "runtime" and not staged_rt:
        say(f"  Nouvelle version {m['version']} : telechargement en arriere-plan (~{_mb(m, 'full')} Mo), "
            "elle s'installera au prochain demarrage.")
        threading.Thread(target=check_and_stage, args=(m,), daemon=True, name="engine-update").start()
        return False
    say(f"  Mise a jour du moteur vers {m['version']}...")
    with _busy:
        try:
            stage(m)
            apply()
        except Exception as exc:  # noqa: BLE001
            _set(state="error", error=str(exc)[:300])
            say(f"  Mise a jour impossible ({exc}) : la version actuelle demarre.")
            return False
    return True


def _mb(manifest: dict, asset: str) -> int:
    return round(int(manifest["assets"][asset].get("size") or 0) / 2**20)


def periodic() -> None:
    while True:
        time.sleep(CHECK_EVERY_S)
        if _status.get("state") != "ready":
            check_and_stage()


def mark_started() -> None:
    """The running version answered /health: confirm it and remove every other version."""
    pkg = root()
    if pkg is None:
        return
    try:
        state = read_state(pkg)
        if state.get("pending") or "previous" in state:
            write_state(pkg, {"code": state["code"], "runtime": state["runtime"]})
        # The launcher of a version is installed once that version has started (a broken
        # launcher could not roll anything back).
        launcher = ENGINE_ROOT / "backtest_engine" / "portable_launcher.py"
        if launcher.exists() and launcher.read_bytes() != (pkg / "mbt_launcher.py").read_bytes():
            shutil.copy2(launcher, pkg / "mbt_launcher.py")
        # A download in progress or a staged version waiting for the restart must survive.
        if _staged is not None or not _busy.acquire(blocking=False):
            return
        _busy.release()
        keep_code, keep_rt = state["code"], state["runtime"]
        for d in (pkg / "versions").iterdir():
            if d.is_dir() and d.name != keep_code and d.resolve() != ENGINE_ROOT:
                shutil.rmtree(d, ignore_errors=True)
        for d in (pkg / "runtimes").iterdir():
            if d.is_dir() and d.name != keep_rt and d.resolve() != Path(sys.executable).resolve().parent:
                shutil.rmtree(d, ignore_errors=True)
        shutil.rmtree(pkg / ".downloads", ignore_errors=True)
    except OSError:
        pass


def bind_server(server: Any) -> None:
    global _server
    _server = server


def request_restart() -> None:
    _restart.set()
    if _server is not None:
        _server.should_exit = True


def restart_requested() -> bool:
    return _restart.is_set()
