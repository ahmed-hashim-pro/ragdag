# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv
WORKDIR /src
COPY pyproject.toml ./
COPY src ./src
RUN uv venv /opt/venv && VIRTUAL_ENV=/opt/venv uv pip install --no-cache '.[api]'
# Bake the embedding model into the image: no download at runtime, works offline.
ENV RAGDAG_EMBED_CACHE_DIR=/opt/models
RUN /opt/venv/bin/python -c "from ragdag.ingest.embedder import warm_up; warm_up()"

FROM python:3.12-slim
RUN useradd --uid 50000 --gid 0 --create-home ragdag && mkdir -p /data && chown 50000:0 /data
COPY --from=build /opt/venv /opt/venv
COPY --from=build --chown=50000:0 /opt/models /opt/models
WORKDIR /app
COPY alembic.ini ./
COPY migrations ./migrations
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    RAGDAG_EMBED_CACHE_DIR=/opt/models \
    HF_HUB_OFFLINE=1
USER ragdag
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"
CMD ["uvicorn", "ragdag.api.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "2", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-server-header"]
