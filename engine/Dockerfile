# Momentum backtest engine — same code as the local engine, cloud defaults.
# Multi-arch: builds natively on ARM64 (Oracle Ampere, Graviton, Raspberry Pi) and x86_64.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    ENGINE_MODE=cloud \
    ENGINE_HOME=/app \
    NUMBA_CACHE_DIR=/tmp/numba

WORKDIR /app

# build-essential only matters if a wheel is missing for the platform (rare on ARM64).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt \
    && apt-get purge -y build-essential && apt-get autoremove -y

COPY backtest_engine ./backtest_engine
COPY server ./server
COPY Complete_Tickers ./Complete_Tickers

# Price cache (.streamlit) and job results (.jobs) live in volumes.
RUN useradd --create-home --uid 10001 engine \
    && mkdir -p /app/.streamlit /app/.jobs /tmp/numba \
    && chown -R engine:engine /app /tmp/numba
USER engine

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8765/health || exit 1

CMD ["python", "-m", "backtest_engine", "serve", "--host", "0.0.0.0", "--port", "8765"]
