"""FastAPI application: routers, middleware, startup migrations, health checks."""

from __future__ import annotations

import json
import logging
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from ragdag.airflow_client import get_airflow
from ragdag.api.routers import ask, auth, collections, pipelines, workspaces
from ragdag.db import get_engine
from ragdag.settings import get_settings

log = logging.getLogger("ragdag")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        data = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        for key in ("request_id", "method", "path", "status", "ms"):
            if hasattr(record, key):
                data[key] = getattr(record, key)
        if record.exc_info:
            data["exc"] = self.formatException(record.exc_info)
        return json.dumps(data)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.INFO)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def run_migrations() -> None:
    """``alembic upgrade head`` under an advisory lock, so replicas never race."""
    from alembic import command
    from alembic.config import Config

    cfg = Config(str(Path(__file__).resolve().parents[3] / "alembic.ini"))
    with get_engine().begin() as conn:
        conn.execute(text("SELECT pg_advisory_lock(7741000)"))
        try:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")
        finally:
            conn.execute(text("SELECT pg_advisory_unlock(7741000)"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    settings = get_settings()
    if settings.env != "test":
        await run_in_threadpool(run_migrations)
        from ragdag.ingest.embedder import warm_up

        await run_in_threadpool(warm_up)
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    log.info("ragdag api started", extra={"path": settings.public_url})
    yield
    await get_airflow().aclose()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="ragdag",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs" if not settings.is_production else None,
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )
    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def access_log(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:16]
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled error", extra={"request_id": request_id})
            response = JSONResponse({"detail": "internal error", "request_id": request_id}, 500)
        response.headers["X-Request-Id"] = request_id
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.url.path.startswith("/api/") and request.url.path not in ("/api/health",):
            response.headers.setdefault("Cache-Control", "no-store")
            log.info(
                "request",
                extra={
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "ms": round((time.monotonic() - started) * 1000, 1),
                },
            )
        return response

    for module in (auth, workspaces, collections, pipelines, ask):
        app.include_router(module.router, prefix="/api")

    @app.get("/api/health", tags=["ops"])
    def health() -> dict:
        return {"status": "ok"}

    @app.get("/api/ready", tags=["ops"])
    async def ready() -> JSONResponse:
        checks: dict[str, bool] = {}
        try:
            with get_engine().connect() as conn:
                conn.execute(text("SELECT 1"))
            checks["database"] = True
        except Exception:  # noqa: BLE001
            checks["database"] = False
        checks["airflow"] = await get_airflow().health()
        # Airflow down degrades ingestion, not Q&A: only the database gates readiness.
        code = 200 if checks["database"] else 503
        return JSONResponse({"ready": code == 200, "checks": checks}, status_code=code)

    return app


app = create_app()
