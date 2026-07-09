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

    try:
        result = subprocess.run(
            ["npm", "run", "dev"],
            cwd=PROJECT_DIR,
            env=env,
            shell=sys.platform == "win32",
        )
    except KeyboardInterrupt:
        print("\nArrete.")
        return 0

    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
