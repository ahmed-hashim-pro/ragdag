"""Import every DAG in the Airflow image and check its shape. Run via ``make test-dags``."""

from __future__ import annotations

import sys

try:
    from airflow.dag_processing.dagbag import DagBag
except ImportError:  # older layout
    from airflow.models.dagbag import DagBag

EXPECTED = {
    "ragdag_ingest_document": ["prepare", "extract", "chunk", "embed_and_index", "finalize"],
    "ragdag_sync_sources": [
        "list_sources", "fetch_source", "requeue_orphans", "collect_changes", "trigger_ingest",
        "report_errors",
    ],
    "ragdag_reindex_collection": ["list_documents", "trigger_ingest"],
    "ragdag_maintenance": [
        "purge_deleted_documents", "clean_staging", "expire_refresh_tokens",
        "fail_stuck_documents", "analyze",
    ],
}


def main() -> int:
    bag = DagBag(dag_folder="/opt/airflow/dags")
    failures = []
    if bag.import_errors:
        failures += [f"import error in {f}: {e}" for f, e in bag.import_errors.items()]
    for dag_id, tasks in EXPECTED.items():
        dag = bag.dags.get(dag_id)
        if dag is None:
            failures.append(f"missing DAG {dag_id}")
            continue
        if sorted(dag.task_ids) != sorted(tasks):
            failures.append(f"{dag_id}: tasks {sorted(dag.task_ids)} != {sorted(tasks)}")
        if not dag.tags or "ragdag" not in dag.tags:
            failures.append(f"{dag_id}: missing ragdag tag")
    ingest = bag.dags.get("ragdag_ingest_document")
    if ingest is not None:
        order = ["prepare", "extract", "chunk", "embed_and_index", "finalize"]
        for up, down in zip(order, order[1:], strict=False):
            if down not in ingest.get_task(up).downstream_task_ids:
                failures.append(f"ingest: {up} should feed {down}")
        if ingest.get_task("embed_and_index").pool != "embedding":
            failures.append("ingest: embed_and_index must use the embedding pool")
    extra = set(bag.dag_ids) - set(EXPECTED)
    if extra:
        failures.append(f"unexpected DAGs: {sorted(extra)}")
    for line in failures:
        print("FAIL", line)
    print(f"{len(bag.dags)} DAGs loaded, {len(failures)} problems")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
