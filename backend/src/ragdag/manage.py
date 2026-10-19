"""Operator commands, run inside the api container.

    docker compose exec api python -m ragdag.manage reindex-all

``reindex-all`` triggers ``ragdag_reindex_collection`` for every collection, which is
needed after changing the embedding model (old vectors are not comparable to new ones).
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select

from ragdag.airflow_client import get_airflow
from ragdag.db import session_scope
from ragdag.models import Collection
from ragdag.pipelines import REINDEX_DAG, trigger


async def reindex_all() -> int:
    with session_scope() as s:
        collections = [(c.id, c.workspace_id, c.name) for c in s.scalars(select(Collection))]
    failed = 0
    for coll_id, ws_id, name in collections:
        with session_scope() as s:
            run = await trigger(
                s,
                dag_id=REINDEX_DAG,
                conf={"collection_id": str(coll_id)},
                kind="reindex",
                workspace_id=ws_id,
                collection_id=coll_id,
            )
            print(f"{name}: {run.state} ({run.dag_run_id})")
            failed += run.state == "failed"
    await get_airflow().aclose()
    print(f"triggered {len(collections) - failed} of {len(collections)} collections")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ragdag.manage")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("reindex-all", help="re-chunk and re-embed every collection")
    args = parser.parse_args(argv)
    if args.command == "reindex-all":
        return asyncio.run(reindex_all())
    return 2


if __name__ == "__main__":
    sys.exit(main())
