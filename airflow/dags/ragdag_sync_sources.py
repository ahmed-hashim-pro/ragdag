"""Poll URL and folder sources for changes, then fan out one ingest run per changed document.

Runs every 15 minutes (each source has its own interval; only due sources are
fetched) or on demand from the API with ``source_ids``. It also re-queues pending
documents whose ingest run never started, so a lost trigger heals itself.
"""

from __future__ import annotations

import pendulum
from airflow.providers.standard.operators.trigger_dagrun import TriggerDagRunOperator
from airflow.sdk import Param, TriggerRule, dag, get_current_context, task
from airflow.sdk.exceptions import AirflowFailException
from ragdag.ingest.dag_support import DEFAULT_ARGS, TAGS, mark_running, on_dag_failure, on_dag_success


@dag(
    dag_id="ragdag_sync_sources",
    description="Fetch due sources, detect changes, trigger ingestion",
    schedule="*/15 * * * *",
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    default_args={**DEFAULT_ARGS, "retries": 1},
    on_success_callback=on_dag_success,
    on_failure_callback=on_dag_failure,
    params={
        "source_ids": Param(
            None, type=["null", "array"], description="sync only these sources (else: all due)"
        )
    },
    tags=TAGS,
    doc_md=__doc__,
)
def ragdag_sync_sources():
    @task
    def list_sources() -> list[str]:
        from ragdag.ingest.sources import due_sources

        ctx = get_current_context()
        mark_running(ctx)
        explicit = ctx["params"].get("source_ids")
        return list(explicit) if explicit else due_sources()

    # A failing source is reported, not raised: the other sources' changes still get
    # ingested, and report_errors fails the run at the end so the failure is visible.
    @task(max_active_tis_per_dagrun=4)
    def fetch_source(source_id: str) -> dict:
        from ragdag.ingest.sources import sync_source

        try:
            return {"source_id": source_id, "changed": sync_source(source_id), "error": None}
        except Exception as exc:  # noqa: BLE001 - recorded on the source row too
            return {"source_id": source_id, "changed": [], "error": f"{type(exc).__name__}: {exc}"}

    @task
    def requeue_orphans() -> list[dict]:
        from ragdag.ingest.pipeline import orphaned_pending

        return orphaned_pending()

    # all_done: one unreachable source must not stop the others' documents.
    @task(trigger_rule=TriggerRule.ALL_DONE)
    def collect_changes(results: list[dict] | None, orphans: list[dict]) -> list[dict]:
        seen: dict[str, dict] = {}
        for result in results or []:
            for item in result["changed"]:
                seen[item["document_id"]] = item
        for item in orphans or []:
            seen.setdefault(item["document_id"], item)
        return list(seen.values())

    @task(trigger_rule=TriggerRule.ALL_DONE)
    def report_errors(results: list[dict] | None) -> None:
        errors = [f"{r['source_id']}: {r['error']}" for r in results or [] if r["error"]]
        if errors:
            raise AirflowFailException("sources failed: " + "; ".join(errors))

    fetched = fetch_source.expand(source_id=list_sources())
    changes = collect_changes(fetched, requeue_orphans())
    triggers = TriggerDagRunOperator.partial(
        task_id="trigger_ingest",
        trigger_dag_id="ragdag_ingest_document",
        max_active_tis_per_dagrun=8,
    ).expand(conf=changes)
    triggers >> report_errors(fetched)


ragdag_sync_sources()
