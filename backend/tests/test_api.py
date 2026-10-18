"""API tests against a real database: auth, roles, ingestion, retrieval, asking."""

from __future__ import annotations

import json

import pytest
from conftest import Api, invite, register

from ragdag.answer import AnswerEvent
from ragdag.ingest import pipeline

GUIDE = b"""# Meridian Handbook

## Power

The Meridian-3 robot runs for 9 hours on one charge. Charging takes 2 hours.

## Safety

Emergency stop is the red button on the left side panel. Error code E-417 means
the lidar is blocked.
"""


# --------------------------------------------------------------------------- auth


def test_first_user_bootstraps_then_signup_is_invite_only(client):
    assert client.get("/api/auth/bootstrap").json()["needs_setup"] is True
    owner = register(client, "owner@example.com")
    me = owner.get("/api/auth/me").json()
    assert me["memberships"][0]["role"] == "owner"
    assert client.get("/api/auth/bootstrap").json()["needs_setup"] is False

    resp = client.post(
        "/api/auth/register",
        json={"email": "x@example.com", "name": "x", "password": "long enough pw"},
    )
    assert resp.status_code == 403


def test_login_refresh_rotation_and_reuse_detection(client, owner):
    bad = client.post("/api/auth/login", json={"email": "owner@example.com", "password": "nope"})
    assert bad.status_code == 401

    resp = client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "correct horse battery"},
    )
    assert resp.status_code == 200
    first = client.cookies.get("ragdag_refresh")
    assert first

    assert client.post("/api/auth/refresh").status_code == 400  # missing CSRF header
    rotated = client.post("/api/auth/refresh", headers={"X-Ragdag": "1"})
    assert rotated.status_code == 200
    second = client.cookies.get("ragdag_refresh")
    assert second and second != first

    # Replaying the old token revokes the whole family, including the new one.
    client.cookies.set("ragdag_refresh", first, path="/api/auth")
    assert client.post("/api/auth/refresh", headers={"X-Ragdag": "1"}).status_code == 401
    client.cookies.set("ragdag_refresh", second, path="/api/auth")
    assert client.post("/api/auth/refresh", headers={"X-Ragdag": "1"}).status_code == 401


def test_requests_need_a_valid_token(client, owner):
    assert client.get("/api/auth/me").status_code == 401
    assert Api(client, "garbage").get("/api/auth/me").status_code == 401


def test_roles_and_isolation(client, owner):
    viewer = invite(owner, client, "viewer@example.com", "viewer")
    editor = invite(owner, client, "editor@example.com", "editor")

    coll = owner.post(f"/api/w/{owner.ws}/collections", json={"name": "Docs"}).json()
    assert viewer.post(f"/api/w/{owner.ws}/collections", json={"name": "V"}).status_code == 403
    assert editor.post(f"/api/w/{owner.ws}/collections", json={"name": "E"}).status_code == 201
    assert viewer.get(f"/api/w/{owner.ws}/collections/{coll['id']}").status_code == 200

    # Editors cannot manage members; admins cannot promote to owner.
    assert (
        editor.post(f"/api/w/{owner.ws}/invitations", json={"email": "z@example.com"}).status_code
        == 403
    )
    admin = invite(owner, client, "admin@example.com", "admin")
    me = admin.get("/api/auth/me").json()
    admin_id = me["user"]["id"]
    viewer_id = viewer.get("/api/auth/me").json()["user"]["id"]
    assert (
        admin.patch(f"/api/w/{owner.ws}/members/{viewer_id}", json={"role": "owner"}).status_code
        == 403
    )
    assert (
        admin.patch(f"/api/w/{owner.ws}/members/{viewer_id}", json={"role": "editor"}).status_code
        == 200
    )

    # The last owner cannot leave or be demoted.
    owner_id = owner.get("/api/auth/me").json()["user"]["id"]
    assert owner.delete(f"/api/w/{owner.ws}/members/{owner_id}").status_code == 400
    assert (
        owner.patch(f"/api/w/{owner.ws}/members/{owner_id}", json={"role": "admin"}).status_code
        == 400
    )
    assert admin.delete(f"/api/w/{owner.ws}/members/{admin_id}").status_code == 204  # leave

    # Another workspace's owner sees nothing (404, not 403).
    other = register(
        client, "other@example.com", password="another long pw", invite_token=_fresh_invite(owner)
    )
    other_ws = other.post("/api/workspaces", json={"name": "Other"}).json()["id"]
    assert owner.get(f"/api/w/{other_ws}/collections").status_code == 404
    assert other.get(f"/api/w/{other_ws}/collections").status_code == 200


def _fresh_invite(owner: Api) -> str:
    resp = owner.post(
        f"/api/w/{owner.ws}/invitations", json={"email": "other@example.com", "role": "viewer"}
    )
    return resp.json()["invite_url"].rsplit("/", 1)[1]


def test_invite_is_single_use_and_email_bound(client, owner):
    resp = owner.post(
        f"/api/w/{owner.ws}/invitations", json={"email": "a@example.com", "role": "editor"}
    )
    token = resp.json()["invite_url"].rsplit("/", 1)[1]
    preview = client.get(f"/api/auth/invite/{token}").json()
    assert preview["workspace_name"] == "Acme" and preview["role"] == "editor"
    wrong = client.post(
        "/api/auth/register",
        json={
            "email": "b@example.com",
            "name": "b",
            "password": "long enough pw",
            "invite_token": token,
        },
    )
    assert wrong.status_code == 400
    register(client, "a@example.com", invite_token=token)
    again = client.post(
        "/api/auth/register",
        json={
            "email": "c@example.com",
            "name": "c",
            "password": "long enough pw",
            "invite_token": token,
        },
    )
    assert again.status_code == 400


# --------------------------------------------------------------------------- ingestion


def _run_dag_steps(document_id: str, sha256: str, dag_run_id: str) -> None:
    """What ragdag_ingest_document does, minus Airflow."""
    info = pipeline.prepare(document_id, sha256, "ragdag_ingest_document", dag_run_id)
    info = pipeline.chunk(pipeline.extract(info))
    pipeline.embed_and_index(info)
    pipeline.finalize(info, dag_run_id)


@pytest.fixture
def indexed(owner, airflow):
    coll = owner.post(
        f"/api/w/{owner.ws}/collections",
        json={"name": "Handbook", "settings": {"similarity_floor": 0.3}},
    ).json()
    resp = owner.post(
        f"/api/w/{owner.ws}/collections/{coll['id']}/documents",
        files={"file": ("handbook.md", GUIDE, "text/markdown")},
    )
    assert resp.status_code == 201, resp.text
    doc = resp.json()["document"]
    assert doc["status"] == "pending"
    dag_id, conf, run_id = airflow.triggered[-1]
    assert dag_id == "ragdag_ingest_document" and conf["document_id"] == doc["id"]
    _run_dag_steps(conf["document_id"], conf["sha256"], run_id)
    return coll, doc, run_id


def test_upload_ingest_and_search(owner, indexed):
    coll, doc, run_id = indexed
    got = owner.get(f"/api/w/{owner.ws}/documents/{doc['id']}").json()
    assert got["status"] == "ready" and got["chunk_count"] == 2
    assert got["title"] == "Meridian Handbook"

    chunks = owner.get(f"/api/w/{owner.ws}/documents/{doc['id']}/chunks").json()
    assert [c["heading"] for c in chunks][0] == "Meridian Handbook > Power"

    runs = owner.get(f"/api/w/{owner.ws}/pipelines/runs").json()
    assert runs["total"] == 1 and runs["items"][0]["state"] == "success"

    hits = owner.post(
        f"/api/w/{owner.ws}/search",
        json={"query": "how long does the battery last", "collection_id": coll["id"]},
    )
    body = hits.json()
    assert body["confident"] is True
    assert body["hits"][0]["heading"].endswith("Power")

    exact = owner.post(
        f"/api/w/{owner.ws}/search", json={"query": "E-417", "collection_id": coll["id"]}
    ).json()
    assert any("E-417" in h["content"] for h in exact["hits"])

    coll_out = owner.get(f"/api/w/{owner.ws}/collections/{coll['id']}").json()
    assert coll_out["ready_count"] == 1 and coll_out["chunk_count"] == 2


def test_duplicate_upload_and_type_checks(owner, indexed):
    coll, doc, _ = indexed
    dup = owner.post(
        f"/api/w/{owner.ws}/collections/{coll['id']}/documents",
        files={"file": ("copy.md", GUIDE, "text/markdown")},
    )
    assert dup.json()["duplicate"] is True and dup.json()["document"]["id"] == doc["id"]
    bad = owner.post(
        f"/api/w/{owner.ws}/collections/{coll['id']}/documents",
        files={"file": ("x.exe", b"MZ", "application/octet-stream")},
    )
    assert bad.status_code == 415


def test_stale_run_is_ignored(owner, indexed):
    _, doc, _ = indexed
    with pytest.raises(pipeline.StaleRun):
        pipeline.prepare(doc["id"], "0" * 64)


def test_delete_hides_document_from_search(owner, indexed):
    coll, doc, _ = indexed
    assert owner.delete(f"/api/w/{owner.ws}/documents/{doc['id']}").status_code == 204
    hits = owner.post(
        f"/api/w/{owner.ws}/search", json={"query": "battery", "collection_id": coll["id"]}
    ).json()
    assert hits["hits"] == []
    from ragdag.ingest.maintenance import purge_deleted_documents

    assert purge_deleted_documents() == 1


def test_airflow_down_records_failed_run(owner, airflow):
    airflow.fail = True
    coll = owner.post(f"/api/w/{owner.ws}/collections", json={"name": "C"}).json()
    resp = owner.post(
        f"/api/w/{owner.ws}/collections/{coll['id']}/documents",
        files={"file": ("a.txt", b"hello world", "text/plain")},
    )
    assert resp.status_code == 201
    run = owner.get(f"/api/w/{owner.ws}/pipelines/runs").json()["items"][0]
    assert run["state"] == "failed" and "could not start" in run["error"]


def test_run_detail_merges_airflow_tasks(owner, indexed):
    runs = owner.get(f"/api/w/{owner.ws}/pipelines/runs").json()["items"]
    detail = owner.get(f"/api/w/{owner.ws}/pipelines/runs/{runs[0]['id']}").json()
    assert [t["task_id"] for t in detail["tasks"]] == ["prepare", "extract"]
    assert detail["tasks"][0]["state"] == "success"


def test_rechunk_setting_triggers_reindex(owner, indexed, airflow):
    coll, _, _ = indexed
    owner.patch(
        f"/api/w/{owner.ws}/collections/{coll['id']}",
        json={"settings": {"chunk_tokens": 300, "chunk_overlap": 30}},
    )
    assert airflow.triggered[-1][0] == "ragdag_reindex_collection"


# --------------------------------------------------------------------------- asking


def _events(resp) -> list[tuple[str, dict]]:
    out = []
    for block in resp.text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        out.append((lines["event"], json.loads(lines["data"])))
    return out


def test_ask_requires_api_key(owner, indexed):
    coll, _, _ = indexed
    resp = owner.post(
        f"/api/w/{owner.ws}/ask", json={"question": "battery?", "collection_id": coll["id"]}
    )
    assert resp.status_code == 409


@pytest.fixture
def with_key(owner, monkeypatch):
    async def ok(_key):
        return None

    import ragdag.api.routers.workspaces as ws_router

    monkeypatch.setattr(ws_router, "check_api_key", ok)
    resp = owner.put(f"/api/w/{owner.ws}/api-key", json={"api_key": "sk-ant-test-0123456789abcd"})
    assert resp.status_code == 200 and resp.json()["hint"] == "…abcd"
    assert "sk-ant" not in resp.text


def test_ask_streams_answer_with_valid_citations(owner, indexed, with_key, monkeypatch):
    coll, _, _ = indexed
    seen = {}

    async def fake_stream(*, api_key, history, question, chunks, effort):
        seen.update(api_key=api_key, n=len(chunks), history=list(history))
        yield AnswerEvent("delta", {"text": "It runs 9 hours [1]."})
        yield AnswerEvent(
            "done",
            {
                "status": "ok",
                "answer": "It runs 9 hours [1].",
                "used": [1],
                "usage": {"input_tokens": 10, "output_tokens": 5},
                "model": "claude-opus-5-5",
            },
        )

    import ragdag.api.routers.ask as ask_router

    monkeypatch.setattr(ask_router, "stream_answer", fake_stream)
    resp = owner.post(
        f"/api/w/{owner.ws}/ask",
        json={"question": "How long does the battery last?", "collection_id": coll["id"]},
    )
    assert resp.status_code == 200
    events = _events(resp)
    kinds = [e for e, _ in events]
    assert kinds == ["meta", "sources", "delta", "done"]
    assert seen["api_key"] == "sk-ant-test-0123456789abcd"
    done = events[-1][1]["message"]
    assert done["status"] == "ok" and done["citations"][0]["n"] == 1

    conv_id = events[0][1]["conversation_id"]
    resp2 = owner.post(
        f"/api/w/{owner.ws}/ask",
        json={"question": "And charging?", "collection_id": coll["id"], "conversation_id": conv_id},
    )
    assert resp2.status_code == 200
    assert seen["history"] == [
        ("user", "How long does the battery last?"),
        ("assistant", "It runs 9 hours [1]."),
    ]

    conv = owner.get(f"/api/w/{owner.ws}/conversations/{conv_id}").json()
    assert len(conv["messages"]) == 4
    usage = owner.get(f"/api/w/{owner.ws}/usage").json()
    assert usage["questions"] == 2 and usage["input_tokens"] == 20


def test_off_topic_question_is_refused_without_api_call(owner, indexed, with_key, monkeypatch):
    coll, _, _ = indexed

    async def boom(**_):
        raise AssertionError("must not call the model")
        yield  # pragma: no cover

    import ragdag.api.routers.ask as ask_router

    monkeypatch.setattr(ask_router, "stream_answer", boom)
    resp = owner.post(
        f"/api/w/{owner.ws}/ask",
        json={"question": "What is the capital of Peru?", "collection_id": coll["id"]},
    )
    events = _events(resp)
    assert events[-1][1]["message"]["status"] == "no_evidence"


def test_conversations_are_private_to_their_user(client, owner, indexed, with_key, monkeypatch):
    coll, _, _ = indexed
    viewer = invite(owner, client, "v@example.com", "viewer")

    async def fake_stream(**_):
        yield AnswerEvent(
            "done", {"status": "ok", "answer": "x", "used": [], "usage": {}, "model": "m"}
        )

    import ragdag.api.routers.ask as ask_router

    monkeypatch.setattr(ask_router, "stream_answer", fake_stream)
    resp = owner.post(
        f"/api/w/{owner.ws}/ask", json={"question": "battery hours", "collection_id": coll["id"]}
    )
    conv_id = _events(resp)[0][1]["conversation_id"]
    assert viewer.get(f"/api/w/{owner.ws}/conversations/{conv_id}").status_code == 404
    assert (
        viewer.post(
            f"/api/w/{owner.ws}/ask",
            json={"question": "battery", "collection_id": coll["id"], "conversation_id": conv_id},
        ).status_code
        == 404
    )


def test_audit_log_records_actions(owner, indexed):
    actions = [e["action"] for e in owner.get(f"/api/w/{owner.ws}/audit").json()]
    assert "document.upload" in actions and "collection.create" in actions


def test_follow_up_question_is_not_crowded_out_by_previous_topic(owner, indexed):
    from ragdag.db import session_scope
    from ragdag.retrieval import retrieve_for_turn

    coll, _, _ = indexed
    with session_scope() as s:
        result = retrieve_for_turn(
            s,
            coll["id"],
            "What does error code E-417 mean?",
            "How long does the robot run on one charge?",
            top_k=2,
        )
    assert result.chunks[0].heading.endswith("Safety")


def test_usage_reports_cost(owner, indexed, with_key, monkeypatch):
    coll, _, _ = indexed

    async def fake_stream(**_):
        usage = {"input_tokens": 2000, "output_tokens": 300, "cost_usd": 0.014}
        yield AnswerEvent(
            "done",
            {
                "status": "ok",
                "answer": "x [1]",
                "used": [1],
                "usage": usage,
                "model": "claude-opus-5-5",
            },
        )

    import ragdag.api.routers.ask as ask_router

    monkeypatch.setattr(ask_router, "stream_answer", fake_stream)
    owner.post(
        f"/api/w/{owner.ws}/ask", json={"question": "battery hours", "collection_id": coll["id"]}
    )
    assert owner.get(f"/api/w/{owner.ws}/usage").json()["cost_usd"] == 0.014
