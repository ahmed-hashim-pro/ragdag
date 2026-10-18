"""The steps of ``ragdag_ingest_document``, as plain functions the DAG tasks call.

Large intermediate data (extracted text, chunks) goes through the shared staging
volume, not XCom: XCom only carries small JSON summaries.

Every step is idempotent and guards against stale runs: the trigger records the
document's SHA-256, and if the document has changed (or been deleted) since, the
step stops with :class:`StaleRun` and the newer run does the work.
"""

from __future__ import annotations

import json
import shutil
import uuid
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ragdag.collection_settings import CollectionSettings
from ragdag.db import session_scope
from ragdag.ingest.chunker import Chunk as TextChunk
from ragdag.ingest.chunker import chunk_markdown
from ragdag.ingest.embedder import embed_texts
from ragdag.ingest.extract import extract_text, title_from_text
from ragdag.models import Chunk, Collection, Document, DocumentStatus, PipelineRun
from ragdag.settings import get_settings


class StaleRun(Exception):
    """The document changed or disappeared after this run was triggered."""


def _staging(document_id: uuid.UUID) -> Path:
    path = get_settings().staging_dir / str(document_id)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _load_live(session, document_id: uuid.UUID, sha256: str | None) -> Document:
    doc = session.get(Document, document_id, with_for_update=True)
    if doc is None or doc.status == DocumentStatus.deleted:
        raise StaleRun(f"document {document_id} no longer exists")
    if sha256 and doc.sha256 != sha256:
        raise StaleRun(f"document {document_id} changed since this run was triggered")
    return doc


def prepare(
    document_id: str, sha256: str | None, dag_id: str | None = None, dag_run_id: str | None = None
) -> dict:
    doc_id = uuid.UUID(document_id)
    with session_scope() as session:
        doc = _load_live(session, doc_id, sha256)
        doc.status = DocumentStatus.processing
        doc.error = None
        if dag_id and dag_run_id:
            # Runs triggered inside Airflow (sync, reindex) have no row yet.
            record_run(
                session,
                dag_id=dag_id,
                dag_run_id=dag_run_id,
                state="running",
                workspace_id=doc.workspace_id,
                collection_id=doc.collection_id,
                document_id=doc.id,
                conf={"document_id": document_id, "sha256": sha256},
            )
        coll = session.get(Collection, doc.collection_id)
        settings = CollectionSettings.of(coll.settings if coll else None)
        return {
            "document_id": document_id,
            "sha256": doc.sha256,
            "storage_path": doc.storage_path,
            "mime_type": doc.mime_type,
            "filename": doc.filename,
            "chunk_tokens": settings.chunk_tokens,
            "chunk_overlap": settings.chunk_overlap,
        }


def extract(info: dict) -> dict:
    data = Path(info["storage_path"]).read_bytes()
    text = extract_text(data, info["mime_type"])
    if not text.strip():
        raise ValueError("no extractable text (a scanned PDF needs OCR first)")
    out = _staging(uuid.UUID(info["document_id"])) / "text.md"
    out.write_text(text, encoding="utf-8")
    return {**info, "text_path": str(out), "chars": len(text)}


def chunk(info: dict) -> dict:
    text = Path(info["text_path"]).read_text(encoding="utf-8")
    chunks = chunk_markdown(text, info["chunk_tokens"], info["chunk_overlap"])
    out = _staging(uuid.UUID(info["document_id"])) / "chunks.json"
    out.write_text(json.dumps([asdict(c) for c in chunks]), encoding="utf-8")
    return {
        **info,
        "chunks_path": str(out),
        "chunks": len(chunks),
        "title": title_from_text(text, Path(info["filename"]).stem),
    }


def embed_and_index(info: dict) -> dict:
    """Embed every chunk, then swap the document's chunks in one transaction."""
    raw = json.loads(Path(info["chunks_path"]).read_text(encoding="utf-8"))
    chunks = [TextChunk(**c) for c in raw]
    # Embed the heading together with the body: the heading path carries context
    # ("Billing > Refunds") that the body alone often lacks.
    vectors = embed_texts([f"{c.heading}\n\n{c.text}" if c.heading else c.text for c in chunks])

    doc_id = uuid.UUID(info["document_id"])
    with session_scope() as session:
        doc = _load_live(session, doc_id, info["sha256"])
        session.execute(delete(Chunk).where(Chunk.document_id == doc_id))
        if chunks:
            session.execute(
                insert(Chunk),
                [
                    {
                        "workspace_id": doc.workspace_id,
                        "collection_id": doc.collection_id,
                        "document_id": doc_id,
                        "ordinal": c.index,
                        "heading": c.heading,
                        "content": c.text,
                        "token_count": c.tokens,
                        "embedding": vec,
                    }
                    for c, vec in zip(chunks, vectors, strict=True)
                ],
            )
        doc.chunk_count = len(chunks)
        doc.token_count = sum(c.tokens for c in chunks)
        if info.get("title") and doc.title == doc.filename:
            doc.title = info["title"]
    return {"document_id": info["document_id"], "chunks": len(chunks)}


def finalize(info: dict, dag_run_id: str | None = None) -> dict:
    doc_id = uuid.UUID(info["document_id"])
    now = datetime.now(UTC)
    with session_scope() as session:
        doc = session.get(Document, doc_id)
        if doc is not None and doc.status == DocumentStatus.processing:
            doc.status = DocumentStatus.ready
            doc.indexed_at = now
        if dag_run_id:
            _mark_run(session, dag_run_id, "success")
    shutil.rmtree(get_settings().staging_dir / str(doc_id), ignore_errors=True)
    return info


def mark_failed(document_id: str, error: str, dag_run_id: str | None = None) -> None:
    doc_id = uuid.UUID(document_id)
    with session_scope() as session:
        doc = session.get(Document, doc_id)
        if doc is not None and doc.status in (DocumentStatus.pending, DocumentStatus.processing):
            doc.status = DocumentStatus.failed
            doc.error = error[:2000]
        if dag_run_id:
            _mark_run(session, dag_run_id, "failed", error)


def mark_skipped(dag_run_id: str | None, reason: str) -> None:
    if not dag_run_id:
        return
    with session_scope() as session:
        _mark_run(session, dag_run_id, "skipped", reason)


def record_run(
    session,
    *,
    dag_id: str,
    dag_run_id: str,
    state: str,
    workspace_id: uuid.UUID | None = None,
    collection_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    conf: dict | None = None,
    triggered_by: uuid.UUID | None = None,
) -> None:
    """Insert or update our mirror row for an Airflow DAG run."""
    now = datetime.now(UTC)
    values = {
        "id": uuid.uuid4(),
        "dag_id": dag_id,
        "dag_run_id": dag_run_id,
        "state": state,
        "workspace_id": workspace_id,
        "collection_id": collection_id,
        "document_id": document_id,
        "conf": conf or {},
        "triggered_by": triggered_by,
        "started_at": now if state == "running" else None,
    }
    stmt = pg_insert(PipelineRun).values(**values)
    session.execute(
        stmt.on_conflict_do_update(
            index_elements=["dag_id", "dag_run_id"],
            set_={
                "state": stmt.excluded.state,
                "started_at": func.coalesce(PipelineRun.started_at, stmt.excluded.started_at),
            },
        )
    )


def _mark_run(session, dag_run_id: str, state: str, error: str | None = None) -> None:
    session.execute(
        update(PipelineRun)
        .where(PipelineRun.dag_run_id == dag_run_id)
        .values(state=state, ended_at=datetime.now(UTC), error=(error or None) and error[:2000])
    )


def documents_for_reindex(collection_id: str) -> list[dict]:
    with session_scope() as session:
        rows = session.execute(
            select(Document.id, Document.sha256).where(
                Document.collection_id == uuid.UUID(collection_id),
                Document.status != DocumentStatus.deleted,
            )
        ).all()
    return [{"document_id": str(r.id), "sha256": r.sha256} for r in rows]
