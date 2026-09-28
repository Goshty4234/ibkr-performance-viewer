"""CA bundle including the OS trust store.

Antivirus HTTPS scanning (Avast, Kaspersky, ESET...) and corporate proxies
re-sign TLS traffic with a root that only exists in the Windows store, so
certifi alone makes every Yahoo download fail. The bundle written here is
certifi + the Windows ROOT/CA stores, exported through the env variables
that requests and curl_cffi (used by yfinance) honour.
"""

from __future__ import annotations

import os
import ssl
import sys
from pathlib import Path

_ENV_VARS = ("REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "SSL_CERT_FILE")
_done = False


def ensure_system_ca_bundle(target_dir: Path) -> Path | None:
    global _done
    if _done or sys.platform != "win32" or any(os.environ.get(v) for v in _ENV_VARS):
        return None
    try:
        import certifi

        pems: list[str] = [Path(certifi.where()).read_text(encoding="ascii", errors="ignore")]
        seen: set[bytes] = set()
        for store in ("ROOT", "CA"):
            for der, encoding, _trust in ssl.enum_certificates(store):
                if encoding == "x509_asn" and der not in seen:
                    seen.add(der)
                    pems.append(ssl.DER_cert_to_PEM_cert(der))
        target_dir.mkdir(parents=True, exist_ok=True)
        bundle = target_dir / "ca-bundle.pem"
        content = "\n".join(pems)
        if not bundle.exists() or bundle.read_text(encoding="ascii", errors="ignore") != content:
            bundle.write_text(content, encoding="ascii", errors="ignore")
        for v in _ENV_VARS:
            os.environ[v] = str(bundle)
        _done = True
        return bundle
    except Exception:
        return None
