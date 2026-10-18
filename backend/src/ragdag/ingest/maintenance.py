"""Steps of ``ragdag_maintenance``."""

from __future__ import annotations

import shutil
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, text, update

from ragdag.db import get_engine, session_scope
from ragdag.models import Document, DocumentStatus, PipelineRun, RefreshToken
from ragdag.settings import get_settings
from ragdag.storage import delete_document_files


def purge_deleted_documents(batch: int = 500) -> int:
    """Hard-delete soft-deleted documents (chunks cascade) and their files."""
    with session_scope() as session:
        rows = session.execute(
            select(Document.id, Document.workspace_id)
            .where(Document.status == DocumentStatus.deleted)
            .limit(batch)
        ).all()
        for row in rows:
            delete_document_files(row.workspace_id, row.id)
        if rows:
            session.execute(delete(Document).where(Document.id.in_([r.id for r in rows])))
    return len(rows)


def clean_staging(max_age_hours: int = 24) -> int:
    root = get_settings().staging_dir
    if not root.exists():
        return 0
    cutoff = time.time() - max_age_hours * 3600
    removed = 0
    for entry in root.iterdir():
        if entry.is_dir() and entry.stat().st_mtime < cutoff:
            shutil.rmtree(entry, ignore_errors=True)
            removed += 1
    return removed


def expire_refresh_tokens() -> int:
    with session_scope() as session:
        result = session.execute(
            delete(RefreshToken).where(
                RefreshToken.expires_at < datetime.now(UTC) - timedelta(days=1)
            )
        )
        return result.rowcount or 0


def fail_stuck_documents(max_age_hours: int = 6) -> int:
    """Documents left 'processing' by a killed worker go to 'failed' so users can retry."""
    cutoff = datetime.now(UTC) - timedelta(hours=max_age_hours)
    with session_scope() as session:
        result = session.execute(
            update(Document)
            .where(Document.status == DocumentStatus.processing, Document.updated_at < cutoff)
            .values(status=DocumentStatus.failed, error="ingestion did not finish; retry it")
        )
        session.execute(
            update(PipelineRun)
            .where(PipelineRun.state.in_(["queued", "running"]), PipelineRun.created_at < cutoff)
            .values(state="failed", error="no result recorded", ended_at=datetime.now(UTC))
        )
        return result.rowcount or 0


def analyze() -> None:
    with get_engine().connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        conn.execute(text("ANALYZE chunks"))
        conn.execute(text("ANALYZE documents"))
