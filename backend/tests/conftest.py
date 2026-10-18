"""Test fixtures: a real Postgres (pgvector) database, a stubbed Airflow, temp data dir.

Set RAGDAG_TEST_ADMIN_URL to a server where a throwaway ``ragdag_test`` database may
be created; defaults to the dev container from ``make devdb``.
"""

from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, text

ADMIN_URL = os.environ.get(
    "RAGDAG_TEST_ADMIN_URL", "postgresql+psycopg://ragdag:ragdag@127.0.0.1:55432/ragdag"
)
TEST_DB = "ragdag_test"
TEST_URL = ADMIN_URL.rsplit("/", 1)[0] + f"/{TEST_DB}"
DATA_DIR = Path(tempfile.mkdtemp(prefix="ragdag-test-"))

os.environ.update(
    RAGDAG_ENV="test",
    RAGDAG_DATABASE_URL=TEST_URL,
    RAGDAG_SECRET_KEY="test-secret-key-0123456789abcdef0123456789",
    RAGDAG_VAULT_KEYS=Fernet.generate_key().decode(),
    RAGDAG_DATA_DIR=str(DATA_DIR),
    RAGDAG_PUBLIC_URL="https://ragdag.test",
    RAGDAG_LOGIN_RATE_PER_MINUTE="1000",
    RAGDAG_ASK_RATE_PER_MINUTE="1000",
)
if cache := os.environ.get("RAGDAG_TEST_EMBED_CACHE"):
    os.environ["RAGDAG_EMBED_CACHE_DIR"] = cache


@pytest.fixture(scope="session", autouse=True)
def database():
    admin = create_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)"))
        conn.execute(text(f"CREATE DATABASE {TEST_DB}"))
    admin.dispose()

    from ragdag.api.main import run_migrations

    run_migrations()
    yield
    from ragdag.db import get_engine

    get_engine().dispose()


TABLES = (
    "audit_events, messages, conversations, chunks, pipeline_runs, documents, sources, "
    "collections, workspace_secrets, invitations, memberships, refresh_tokens, workspaces, users"
)


@pytest.fixture(autouse=True)
def clean_db(database):
    from ragdag.api.deps import limiter
    from ragdag.db import get_engine

    with get_engine().begin() as conn:
        conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    limiter.reset()
    yield


class FakeAirflow:
    def __init__(self) -> None:
        self.triggered: list[tuple[str, dict, str]] = []
        self.fail = False

    async def trigger(self, dag_id, conf, run_id):
        from ragdag.airflow_client import AirflowError

        if self.fail:
            raise AirflowError("down")
        self.triggered.append((dag_id, conf, run_id))
        return {"dag_run_id": run_id, "state": "queued"}

    async def dag_run(self, dag_id, run_id):
        return {"state": "running"}

    async def task_instances(self, dag_id, run_id):
        return [{"task_id": "prepare", "state": "success", "map_index": -1, "try_number": 1}]

    async def dag_structure(self, dag_id):
        return [
            {"task_id": "prepare", "downstream": ["extract"]},
            {"task_id": "extract", "downstream": []},
        ]

    async def task_log(self, *a):
        return "log line"

    async def health(self):
        return True

    async def aclose(self):
        pass


@pytest.fixture
def airflow(monkeypatch):
    fake = FakeAirflow()
    import ragdag.api.routers.pipelines as pipelines_router
    import ragdag.pipelines as pipelines

    monkeypatch.setattr(pipelines, "get_airflow", lambda: fake)
    monkeypatch.setattr(pipelines_router, "get_airflow", lambda: fake)
    return fake


@pytest.fixture
def client(airflow):
    from fastapi.testclient import TestClient

    from ragdag.api.main import create_app

    with TestClient(create_app(), base_url="https://testserver") as c:
        yield c


class Api:
    """Small helper so tests read as user actions."""

    def __init__(self, client, token: str):
        self.c = client
        self.h = {"Authorization": f"Bearer {token}"}

    def get(self, url, **kw):
        return self.c.get(url, headers=self.h, **kw)

    def post(self, url, **kw):
        return self.c.post(url, headers=self.h, **kw)

    def patch(self, url, **kw):
        return self.c.patch(url, headers=self.h, **kw)

    def put(self, url, **kw):
        return self.c.put(url, headers=self.h, **kw)

    def delete(self, url, **kw):
        return self.c.delete(url, headers=self.h, **kw)


def register(client, email: str, password: str = "correct horse battery", **extra) -> Api:
    resp = client.post(
        "/api/auth/register",
        json={"email": email, "name": email.split("@")[0], "password": password, **extra},
    )
    assert resp.status_code == 201, resp.text
    return Api(client, resp.json()["access_token"])


@pytest.fixture
def owner(client):
    api = register(client, "owner@example.com", workspace_name="Acme")
    me = api.get("/api/auth/me").json()
    api.ws = me["memberships"][0]["workspace_id"]
    return api


def invite(owner: Api, client, email: str, role: str) -> Api:
    resp = owner.post(f"/api/w/{owner.ws}/invitations", json={"email": email, "role": role})
    assert resp.status_code == 201, resp.text
    token = resp.json()["invite_url"].rsplit("/", 1)[1]
    api = register(client, email, invite_token=token)
    api.ws = owner.ws
    return api


def new_id() -> str:
    return str(uuid.uuid4())
