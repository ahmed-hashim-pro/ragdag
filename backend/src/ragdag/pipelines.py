"""Triggering DAG runs from the API, with our own run record written first."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from ragdag.airflow_client import AirflowError, get_airflow
from ragdag.models import Document, PipelineRun

log = logging.getLogger(__name__)

INGEST_DAG = "ragdag_ingest_document"
REINDEX_DAG = "ragdag_reindex_collection"
SYNC_DAG = "ragdag_sync_sources"


def _run_id(kind: str) -> str:
    return f"{kind}__{datetime.now(UTC):%Y%m%dT%H%M%S}__{uuid.uuid4().hex[:8]}"


async def trigger(
    session: Session,
    *,
    dag_id: str,
    conf: dict[str, Any],
    kind: str,
    workspace_id: uuid.UUID,
    collection_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
) -> PipelineRun:
    """Record the run, commit, then ask Airflow. A failed trigger is recorded, not raised."""
    run = PipelineRun(
        workspace_id=workspace_id,
        collection_id=collection_id,
        document_id=document_id,
        dag_id=dag_id,
        dag_run_id=_run_id(kind),
        state="queued",
        conf=conf,
        triggered_by=user_id,
    )
    session.add(run)
    session.commit()
    try:
        await get_airflow().trigger(dag_id, conf, run.dag_run_id)
    except AirflowError as exc:
        log.warning("trigger %s failed: %s", dag_id, exc)
        run.state = "failed"
        run.error = f"could not start the pipeline: {exc}"[:2000]
        run.ended_at = datetime.now(UTC)
        session.commit()
    return run


async def trigger_ingest(session: Session, doc: Document, user_id: uuid.UUID | None) -> PipelineRun:
    return await trigger(
        session,
        dag_id=INGEST_DAG,
        conf={"document_id": str(doc.id), "sha256": doc.sha256},
        kind="ingest",
        workspace_id=doc.workspace_id,
        collection_id=doc.collection_id,
        document_id=doc.id,
        user_id=user_id,
    )
