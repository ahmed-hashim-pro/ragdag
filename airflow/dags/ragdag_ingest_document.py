"""Ingest one document: prepare → extract → chunk → embed_and_index → finalize.

Triggered by the API on upload / re-ingest, and by the sync and reindex DAGs.
Text and chunks pass through the shared staging volume; XCom carries only paths
and counts. A document that changed or was deleted after the trigger makes the
run skip (a newer run owns it). Errors that retrying cannot fix fail fast.
"""

from __future__ import annotations

import pendulum
from airflow.sdk import Param, dag, get_current_context, task
from airflow.sdk.exceptions import AirflowFailException, AirflowSkipException
from ragdag.ingest.dag_support import DEFAULT_ARGS, TAGS, on_dag_failure, on_dag_success


def _on_task_failure(context) -> None:
    """After the last retry: mark the document failed with the error users will see."""
    from ragdag.ingest.pipeline import mark_failed

    params = context.get("params") or {}
    exc = context.get("exception")
    ti = context.get("task_instance")
    task_id = getattr(ti, "task_id", "task")
    if params.get("document_id"):
        mark_failed(
            params["document_id"],
            f"{task_id}: {type(exc).__name__ if exc else 'error'}: {exc}",
            getattr(context.get("dag_run"), "run_id", None),
        )


def _guard(fn, *args, **kwargs):
    """Run a pipeline step, turning stale runs into skips and bad input into hard failures."""
    from ragdag.ingest.extract import UnsupportedDocument
    from ragdag.ingest.pipeline import StaleRun, mark_skipped

    try:
        return fn(*args, **kwargs)
    except StaleRun as exc:
        mark_skipped(get_current_context()["dag_run"].run_id, str(exc))
        raise AirflowSkipException(str(exc)) from exc
    except (UnsupportedDocument, FileNotFoundError) as exc:
        raise AirflowFailException(str(exc)) from exc
    except ValueError as exc:  # e.g. no extractable text: retrying will not help
        raise AirflowFailException(str(exc)) from exc


@dag(
    dag_id="ragdag_ingest_document",
    description="Extract, chunk, embed and index one document",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=8,
    max_active_tasks=16,
    is_paused_upon_creation=False,
    default_args={**DEFAULT_ARGS, "on_failure_callback": _on_task_failure},
    on_success_callback=on_dag_success,
    on_failure_callback=on_dag_failure,
    params={
        "document_id": Param(type="string", description="documents.id"),
        "sha256": Param(None, type=["null", "string"], description="expected content hash"),
    },
    tags=TAGS,
    doc_md=__doc__,
)
def ragdag_ingest_document():
    @task
    def prepare() -> dict:
        from ragdag.ingest import pipeline

        ctx = get_current_context()
        params, dag_run = ctx["params"], ctx["dag_run"]
        return _guard(
            pipeline.prepare,
            params["document_id"],
            params.get("sha256"),
            dag_run.dag_id,
            dag_run.run_id,
        )

    @task
    def extract(info: dict) -> dict:
        from ragdag.ingest import pipeline

        return _guard(pipeline.extract, info)

    @task
    def chunk(info: dict) -> dict:
        from ragdag.ingest import pipeline

        return _guard(pipeline.chunk, info)

    # The embedding pool caps concurrent ONNX inference so ingestion bursts cannot
    # starve the API container of CPU.
    @task(pool="embedding")
    def embed_and_index(info: dict) -> dict:
        from ragdag.ingest import pipeline

        result = _guard(pipeline.embed_and_index, info)
        return {**info, **result}

    @task
    def finalize(info: dict) -> dict:
        from ragdag.ingest import pipeline

        return pipeline.finalize(info, get_current_context()["dag_run"].run_id)

    finalize(embed_and_index(chunk(extract(prepare()))))


ragdag_ingest_document()
