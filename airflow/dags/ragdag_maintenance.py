"""Daily housekeeping: purge deleted documents, stale staging files, expired sessions."""

from __future__ import annotations

import pendulum
from airflow.sdk import TriggerRule, dag, task
from ragdag.ingest.dag_support import DEFAULT_ARGS, TAGS


@dag(
    dag_id="ragdag_maintenance",
    description="Purge deleted documents and staging files, expire sessions, ANALYZE",
    schedule="30 3 * * *",
    start_date=pendulum.datetime(2026, 1, 1, tz="UTC"),
    catchup=False,
    max_active_runs=1,
    is_paused_upon_creation=False,
    default_args=DEFAULT_ARGS,
    tags=TAGS,
    doc_md=__doc__,
)
def ragdag_maintenance():
    @task
    def purge_deleted_documents() -> int:
        from ragdag.ingest.maintenance import purge_deleted_documents as purge

        total = 0
        while (n := purge()) > 0:
            total += n
        return total

    @task
    def clean_staging() -> int:
        from ragdag.ingest.maintenance import clean_staging as clean

        return clean()

    @task
    def expire_refresh_tokens() -> int:
        from ragdag.ingest.maintenance import expire_refresh_tokens as expire

        return expire()

    @task
    def fail_stuck_documents() -> int:
        from ragdag.ingest.maintenance import fail_stuck_documents as fail_stuck

        return fail_stuck()

    @task(trigger_rule=TriggerRule.ALL_DONE)
    def analyze() -> None:
        from ragdag.ingest.maintenance import analyze as run_analyze

        run_analyze()

    [purge_deleted_documents(), clean_staging(), expire_refresh_tokens(), fail_stuck_documents()] >> analyze()


ragdag_maintenance()
