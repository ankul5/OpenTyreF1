# Build context is this directory (backend/), not the repo root:
#   docker build -t opentyref1-api backend
FROM python:3.11-slim

# libgomp1 is XGBoost's OpenMP runtime — the import fails without it on slim.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a code change doesn't invalidate the pip layer.
COPY requirements-serve.txt .
RUN pip install --no-cache-dir -r requirements-serve.txt

# Includes opentyref1.db — DATABASE_URL defaults to sqlite:///./opentyref1.db,
# which resolves against WORKDIR, so the shipped dataset is live on boot with
# no ingestion step. Point DATABASE_URL at Postgres to override.
COPY . .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# Shell form so ${PORT} expands — hosts inject their own port at runtime.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
