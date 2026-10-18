"""End-to-end smoke test against a running stack, without touching real users.

Creates a throwaway user + workspace directly in the database, then drives the HTTP
API: upload → Airflow ingestion → search → ask gating → run detail. Cleans up after.

    docker compose exec -T api python - < scripts/smoke.py
"""

from __future__ import annotations

import sys
import time
import uuid

import httpx
from sqlalchemy import delete

from ragdag.db import session_scope
from ragdag.models import Membership, Role, User, Workspace
from ragdag.security import create_access_token, hash_password

BASE = "http://127.0.0.1:8000/api"
DOC = b"""# Smoke Handbook

## Power

The Meridian-3 robot runs for 9 hours on one charge. Charging takes 2 hours.

## Safety

Error code E-417 means the lidar is blocked.
"""


def check(cond: bool, label: str) -> None:
    print(("ok   " if cond else "FAIL ") + label, flush=True)
    if not cond:
        raise SystemExit(1)


def main() -> int:
    tag = uuid.uuid4().hex[:8]
    with session_scope() as s:
        user = User(email=f"smoke-{tag}@ragdag.invalid", name="smoke",
                    password_hash=hash_password(uuid.uuid4().hex))
        ws = Workspace(name=f"smoke-{tag}", slug=f"smoke-{tag}")
        s.add_all([user, ws])
        s.flush()
        s.add(Membership(workspace_id=ws.id, user_id=user.id, role=Role.owner))
        user_id, ws_id = user.id, ws.id
    token, _ = create_access_token(user_id)
    http = httpx.Client(base_url=BASE, headers={"Authorization": f"Bearer {token}"}, timeout=30)

    try:
        check(http.get("/ready").json()["checks"]["airflow"], "api sees airflow")
        coll = http.post(f"/w/{ws_id}/collections", json={"name": "smoke"}).json()
        up = http.post(f"/w/{ws_id}/collections/{coll['id']}/documents",
                       files={"file": ("smoke.md", DOC, "text/markdown")})
        check(up.status_code == 201, "upload accepted")
        doc_id = up.json()["document"]["id"]

        status, deadline = "pending", time.monotonic() + 180
        while status in ("pending", "processing") and time.monotonic() < deadline:
            time.sleep(2)
            status = http.get(f"/w/{ws_id}/documents/{doc_id}").json()["status"]
        doc = http.get(f"/w/{ws_id}/documents/{doc_id}").json()
        check(status == "ready", f"airflow ingested the document (status={status}, "
                                 f"chunks={doc['chunk_count']}, error={doc['error']})")

        runs = http.get(f"/w/{ws_id}/pipelines/runs").json()["items"]
        check(runs and runs[0]["state"] == "success", f"run recorded as {runs[0]['state']}")
        detail = http.get(f"/w/{ws_id}/pipelines/runs/{runs[0]['id']}").json()
        states = {t["task_id"]: t["state"] for t in detail["tasks"]}
        check(set(states.values()) == {"success"}, f"task states from airflow: {states}")
        log = http.get(f"/w/{ws_id}/pipelines/runs/{runs[0]['id']}/tasks/embed_and_index/log")
        check(log.status_code == 200 and len(log.json()["content"]) > 0, "task log readable")

        hits = http.post(f"/w/{ws_id}/search", json={
            "query": "how long does the battery last", "collection_id": coll["id"]}).json()
        check(hits["confident"] and hits["hits"][0]["heading"].endswith("Power"),
              f"dense search finds the right section (sim={hits['best_similarity']:.2f})")
        exact = http.post(f"/w/{ws_id}/search", json={
            "query": "E-417", "collection_id": coll["id"]}).json()
        check(any(h["lexical"] for h in exact["hits"]), "full-text search finds E-417")

        ask = http.post(f"/w/{ws_id}/ask", json={"question": "battery?",
                                                 "collection_id": coll["id"]})
        check(ask.status_code == 409, "ask without an API key explains what is missing")

        reindex = http.post(f"/w/{ws_id}/collections/{coll['id']}/reindex")
        check(reindex.status_code == 202, "reindex DAG triggered")
        deadline = time.monotonic() + 180
        state = "queued"
        while state in ("queued", "running") and time.monotonic() < deadline:
            time.sleep(2)
            state = http.get(f"/w/{ws_id}/pipelines/runs/{reindex.json()['id']}").json()["run"]["state"]
        check(state == "success", f"reindex run finished ({state})")
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            doc = http.get(f"/w/{ws_id}/documents/{doc_id}").json()
            if doc["status"] == "ready":
                break
            time.sleep(2)
        check(doc["status"] == "ready", "document re-ingested by the fanned-out run")
    finally:
        with session_scope() as s:
            s.execute(delete(Workspace).where(Workspace.id == ws_id))
            s.execute(delete(User).where(User.id == user_id))
        print("cleaned up smoke user and workspace")
    return 0


if __name__ == "__main__":
    sys.exit(main())
