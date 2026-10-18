"""Re-chunk and re-embed every document of a collection (after a chunking settings change)."""

from __future__ import annotations

import pendulum
from airflow.providers.standard.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.sdk import Param, dag, get_current_context, task
from ragdag.ingest.dag_support import DEFAULT_ARGS, TAGS, mark_running, on_dag_failure, on_dag_success


@dag(
    dag_id="ragdag_reindex_collection",
    description="Trigger ingestion for every document in a collection",
    schedule=None,
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=2,
    is_paused_upon_creation=False,
    default_args=DEFAULT_ARGS,
    on_success_callback=on_dag_success,
    on_failure_callback=on_dag_failure,
    params={"collection_id": Param(type="string", description="collections.id")},
    tags=TAGS,
    doc_md=__doc__,
)
def ragdag_reindex_collection():
    @task
    def list_documents() -> list[dict]:
        from ragdag.ingest.pipeline import documents_for_reindex

        ctx = get_current_context()
        mark_running(ctx)
        return documents_for_reindex(ctx["params"]["collection_id"])

    TriggerDagRunOperator.partial(
        task_id="trigger_ingest",
        trigger_dag_id="ragdag_ingest_document",
        max_active_tis_per_dagrun=8,
    ).expand(conf=list_documents())


ragdag_reindex_collection()
