"""Shared defaults and callbacks for the ragdag DAGs (kept in the package so DAG files import it
without relying on the dags folder being on sys.path).

The DAG tasks import the ``ragdag`` package (installed in the Airflow image) and
write straight to the app database; nothing heavy travels through XCom.
"""

from __future__ import annotations

from datetime import timedelta

TAGS = ["ragdag"]

DEFAULT_ARGS = {
    "owner": "ragdag",
    "retries": 2,
    "retry_delay": timedelta(seconds=20),
    "retry_exponential_backoff": True,
    "max_retry_delay": timedelta(minutes=5),
    "execution_timeout": timedelta(minutes=30),
}


def _run_id(context) -> str | None:
    dag_run = context.get("dag_run")
    return getattr(dag_run, "run_id", None)


def on_dag_success(context) -> None:
    from ragdag.ingest.pipeline import finish_run

    if run_id := _run_id(context):
        finish_run(run_id, "success")


def on_dag_failure(context) -> None:
    from ragdag.ingest.pipeline import finish_run

    if run_id := _run_id(context):
        finish_run(run_id, "failed", str(context.get("reason") or "a task failed"))


def mark_running(context) -> None:
    from ragdag.ingest.pipeline import mark_running as _mark

    if run_id := _run_id(context):
        _mark(run_id)
