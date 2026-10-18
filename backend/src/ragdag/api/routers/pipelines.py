"""Pipeline runs for a workspace, with live task states and logs read from Airflow."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ragdag.airflow_client import AirflowError, get_airflow
from ragdag.api.deps import WorkspaceAccess, editor, viewer
from ragdag.api.schemas import PipelineRunOut, RunDetailOut, RunPage, TaskLogOut, TaskNode
from ragdag.db import get_session
from ragdag.models import PipelineRun
from ragdag.settings import get_settings

router = APIRouter(prefix="/w/{ws_id}/pipelines", tags=["pipelines"])

TERMINAL = {"success", "failed", "skipped"}
_structure_cache: dict[str, list[dict]] = {}


def _run(session: Session, access: WorkspaceAccess, run_id: uuid.UUID) -> PipelineRun:
    run = session.get(PipelineRun, run_id)
    if run is None or run.workspace_id != access.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    return run


@router.get("/runs", response_model=RunPage)
def list_runs(
    dag_id: str | None = None,
    state: str | None = None,
    collection_id: uuid.UUID | None = None,
    document_id: uuid.UUID | None = None,
    offset: int = 0,
    limit: int = 50,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> RunPage:
    where = [PipelineRun.workspace_id == access.id]
    if dag_id:
        where.append(PipelineRun.dag_id == dag_id)
    if state:
        where.append(PipelineRun.state == state)
    if collection_id:
        where.append(PipelineRun.collection_id == collection_id)
    if document_id:
        where.append(PipelineRun.document_id == document_id)
    total = session.scalar(select(func.count()).where(*where))
    rows = session.scalars(
        select(PipelineRun)
        .where(*where)
        .order_by(PipelineRun.created_at.desc())
        .offset(max(offset, 0))
        .limit(min(max(limit, 1), 200))
    ).all()
    return RunPage(items=[PipelineRunOut.model_validate(r) for r in rows], total=total)


async def _structure(dag_id: str) -> list[dict]:
    if dag_id not in _structure_cache:
        _structure_cache[dag_id] = await get_airflow().dag_structure(dag_id)
    return _structure_cache[dag_id]


def _merge_tasks(structure: list[dict], instances: list[dict]) -> list[TaskNode]:
    by_task: dict[str, list[dict]] = {}
    for ti in instances:
        by_task.setdefault(ti["task_id"], []).append(ti)
    nodes = []
    for t in structure:
        tis = by_task.get(t["task_id"], [])
        node = TaskNode(task_id=t["task_id"], downstream=t["downstream"])
        if len(tis) == 1 and tis[0].get("map_index", -1) == -1:
            ti = tis[0]
            node.state = ti.get("state")
            node.try_number = ti.get("try_number")
            node.start_date = ti.get("start_date")
            node.end_date = ti.get("end_date")
            node.duration = ti.get("duration")
        elif tis:  # mapped task: summarise the worst state
            states = [ti.get("state") for ti in tis]
            for s in ("failed", "upstream_failed", "running", "queued", "scheduled", "success"):
                if s in states:
                    node.state = s
                    break
            node.mapped_count = len(tis)
            node.try_number = max(ti.get("try_number") or 0 for ti in tis)
        nodes.append(node)
    return nodes


@router.get("/runs/{run_id}", response_model=RunDetailOut)
async def run_detail(
    run_id: uuid.UUID,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> RunDetailOut:
    run = _run(session, access, run_id)
    airflow_state = None
    tasks: list[TaskNode] = []
    try:
        client = get_airflow()
        dag_run = await client.dag_run(run.dag_id, run.dag_run_id)
        airflow_state = dag_run.get("state")
        tasks = _merge_tasks(
            await _structure(run.dag_id), await client.task_instances(run.dag_id, run.dag_run_id)
        )
        # Reconcile: a run Airflow finished but our tasks never reported (killed worker).
        if airflow_state in ("success", "failed") and run.state not in TERMINAL:
            run.state = airflow_state
            run.ended_at = run.ended_at or datetime.now(UTC)
            session.commit()
    except AirflowError:
        pass
    ui = f"{get_settings().public_url.rstrip('/')}/airflow/dags/{run.dag_id}/runs/{run.dag_run_id}"
    return RunDetailOut(
        run=PipelineRunOut.model_validate(run),
        airflow_state=airflow_state,
        tasks=tasks,
        airflow_ui_url=ui,
    )


@router.get("/runs/{run_id}/tasks/{task_id}/log", response_model=TaskLogOut)
async def task_log(
    run_id: uuid.UUID,
    task_id: str,
    try_number: int = 1,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> TaskLogOut:
    run = _run(session, access, run_id)
    if task_id not in {t["task_id"] for t in await _structure(run.dag_id)}:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    try:
        content = await get_airflow().task_log(run.dag_id, run.dag_run_id, task_id, try_number)
    except AirflowError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from None
    return TaskLogOut(task_id=task_id, try_number=try_number, content=content[-200_000:])
