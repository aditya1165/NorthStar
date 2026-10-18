# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f backend/Dockerfile .
FROM python:3.12-slim-bookworm AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH="/opt/venv/bin:$PATH"

WORKDIR /app/backend

FROM base AS dependencies
COPY backend/requirements.txt /tmp/requirements.txt
# Wheel-only installation works on Linux amd64 and arm64 without shipping a compiler.
RUN python -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --require-hashes --only-binary=:all: -r /tmp/requirements.txt

FROM dependencies AS development-dependencies
COPY backend/requirements-dev.txt /tmp/requirements-dev.txt
RUN /opt/venv/bin/python -m pip install --require-hashes --only-binary=:all: -r /tmp/requirements-dev.txt

FROM base AS application
RUN groupadd --gid 10001 northstar \
    && useradd --uid 10001 --gid northstar --no-create-home --shell /usr/sbin/nologin northstar \
    && mkdir -p /app/data/models /app/data/generated /app/data/exports \
    && chown -R northstar:northstar /app/data

COPY backend/pyproject.toml ./
COPY backend/app ./app
COPY backend/scripts ./scripts
# The code resolves this relative to /app/backend/app, not the working directory.
COPY shared /app/shared

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).close()"]

FROM application AS development
ENV RUFF_CACHE_DIR=/tmp/ruff \
    PYTEST_ADDOPTS="-o cache_dir=/tmp/pytest-cache"
COPY --from=development-dependencies /opt/venv /opt/venv
COPY backend/tests ./tests
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload", "--reload-dir", "/app/backend/app", "--reload-dir", "/app/shared", "--reload-include", "*.json"]

FROM application AS runtime
COPY --from=dependencies /opt/venv /opt/venv
# Process-local simulations and live run registries must stay in a single worker.
# No training runs at startup; a missing persisted model uses the deterministic baseline.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]

