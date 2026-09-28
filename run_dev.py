#!/usr/bin/env python3
"""Lance IBKR Performance Viewer en local (http://localhost:3000)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent
ENV_FILE = PROJECT_DIR / ".env.local"
LOCAL_PORT = 3000
# The dev server (not the deployed site) keeps compiled pages in memory. It is restarted past
# this ceiling, or earlier when Windows itself is close to its commit limit (the whole PC would
# start failing allocations). Pages recompile in a few seconds.
MEMORY_LIMIT_MB = 6144
LOW_SYSTEM_MB = 2048
MIN_RESTART_MB = 1536
CHECK_EVERY_S = 30


def clean_next_cache() -> None:
    """Supprime .next — evite chunks/manifest corrompus (Windows, build + dev melanges)."""
    next_dir = PROJECT_DIR / ".next"
    if not next_dir.is_dir():
        return
    print(" Nettoyage du cache .next (evite erreurs SegmentViewNode / 611.js)...")
    shutil.rmtree(next_dir, ignore_errors=True)
    time.sleep(0.5)


def stop_local_servers() -> None:
    """Arrete les vieux serveurs Next.js de ce projet (Windows)."""
    if sys.platform != "win32":
        return

    project = str(PROJECT_DIR).replace("\\", "\\\\")
    ps = f"""
$project = '{project}'
$pids = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {{ $_.CommandLine -and ($_.CommandLine -like "*$project*" -or $_.CommandLine -like "*next dev*") }} |
  Select-Object -ExpandProperty ProcessId -Unique
foreach ($processId in $pids) {{
  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
}}
Get-NetTCPConnection -LocalPort {LOCAL_PORT} -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique |
  ForEach-Object {{ Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }}
"""
    subprocess.run(
        ["powershell", "-NoProfile", "-Command", ps],
        cwd=PROJECT_DIR,
        check=False,
    )
    time.sleep(1.5)


def memory_mb() -> tuple[int, int]:
    """(memory committed by this project's Node processes, commit still free on Windows) in MB;
    zeros when unknown."""
    if sys.platform != "win32":
        return 0, 0
    project = str(PROJECT_DIR).replace("'", "''")
    ps = (
        "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | "
        f"Where-Object {{ $_.CommandLine -like '*{project}*' }}; "
        "$os = Get-CimInstance Win32_OperatingSystem; "
        "'{0} {1}' -f [int](($p | Measure-Object PrivatePageCount -Sum).Sum / 1MB), [int]($os.FreeVirtualMemory / 1KB)"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, text=True, timeout=20)
        used, free = out.stdout.split()
        return int(used), int(free)
    except Exception:
        return 0, 0


def too_big(used: int, free: int) -> bool:
    return used > MEMORY_LIMIT_MB or (0 < free < LOW_SYSTEM_MB and used > MIN_RESTART_MB)


def run_server(env: dict) -> int | None:
    """Runs `npm run dev` until it exits (its return code) or crosses the memory ceiling (None)."""
    proc = subprocess.Popen(["npm", "run", "dev"], cwd=PROJECT_DIR, env=env, shell=sys.platform == "win32")
    while True:
        try:
            return proc.wait(timeout=CHECK_EVERY_S)
        except subprocess.TimeoutExpired:
            pass
        used, free = memory_mb()
        if too_big(used, free):
            print(f"\n Serveur a {used} Mo (Windows : {free} Mo libres) : redemarrage automatique...\n")
            stop_local_servers()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
            return None


def main() -> int:
    if shutil.which("npm") is None:
        print("Erreur: npm introuvable. Installez Node.js.")
        return 1

    if not ENV_FILE.is_file():
        print(f"Erreur: fichier .env.local introuvable -> {ENV_FILE}")
        print("Copiez .env.local.example vers .env.local et remplissez Supabase.")
        return 1

    env = os.environ.copy()
    env["PORT"] = str(LOCAL_PORT)
    env["NODE_OPTIONS"] = "--use-system-ca"

    print()
    print(" IBKR Performance Viewer - local")
    print(" =================================")
    print(f" Site: http://localhost:{LOCAL_PORT}")
    print(" Mobile (meme Wi-Fi): voir l'adresse Network affichee par Next.js")
    print("   ex. http://10.0.0.238:3000  (pas localhost sur le telephone)")
    print(" Arreter: Ctrl+C dans ce terminal")
    print()

    stop_local_servers()
    clean_next_cache()

    try:
        while True:
            code = run_server(env)
            if code is not None:
                return code
    except KeyboardInterrupt:
        stop_local_servers()
        print("\nArrete.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
