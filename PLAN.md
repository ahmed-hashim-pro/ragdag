# ragdag — build plan

A multi-user, self-hosted knowledge app. Documents are ingested by **Airflow DAGs**
(extract → chunk → embed → index) into **Postgres + pgvector**, and questions are
answered by **Claude** with retrieval-grounded, cited answers (RAG).

Working name: `ragdag` (rename later with one search/replace).

## Decisions

| Area | Choice |
|---|---|
| Host | Docker Compose on a single Linux server |
| Backend | Python 3.12, FastAPI, SQLAlchemy 2, Alembic |
| Frontend | Angular 22 (standalone components, signals), served by nginx |
| Pipelines | Apache Airflow 3.3.2, LocalExecutor, FAB auth manager |
| Database | Postgres 17 + pgvector 0.8.7 — app data, vectors, full-text, Airflow metadata (separate DB) |
| Embeddings | fastembed (ONNX) `sentence-transformers/all-MiniLM-L6-v2`, 384-d, local, no API cost |
| LLM | Claude Opus 5.5 via the Anthropic Python SDK; API key per workspace, encrypted at rest |
| Users | Multi-user, workspaces, roles owner / admin / editor / viewer, invitations |

## Architecture

```
browser ──https──▶ nginx (web) ─┬─ /            Angular SPA
                                ├─ /api/        FastAPI  ──┬─ Postgres (ragdag DB: users, docs, chunks+vectors)
                                └─ /airflow/    Airflow UI │   └─ Airflow REST (trigger DAG runs, read task states)
                                                           └─ Anthropic API (answers)
Airflow scheduler (LocalExecutor) runs DAG tasks that import the same `ragdag` package
and write chunks + embeddings straight into Postgres. Uploads live on a shared volume.
```

## DAGs

| DAG | Trigger | Shape |
|---|---|---|
| `ragdag_ingest_document` | API, per uploaded/changed document | `prepare → extract → chunk → embed_and_index → finalize` (+ failure callback marks the document failed) |
| `ragdag_sync_sources` | every 15 min | `list_due_sources → fetch_source (mapped) → collect_changes → trigger_ingest (mapped)` — URL and folder sources, SHA-256 change detection |
| `ragdag_reindex_collection` | API (settings change) | `list_documents → trigger_ingest (mapped)` |
| `ragdag_maintenance` | daily | purge deleted documents & staging files, expire tokens, `ANALYZE` |

## RAG

- Markdown-aware chunking (heading paths kept on every chunk), ~400 tokens, 60 overlap — ported from `rag-knowledge-agent`.
- Hybrid retrieval in one SQL round-trip each: pgvector HNSW cosine + Postgres `websearch_to_tsquery` full-text, fused by reciprocal rank fusion.
- Confidence floor: if the best dense similarity is below the collection's floor, refuse locally — no API call.
- Retrieved text is wrapped in `<document index="n">` envelopes and treated as data, never as instruction.
- Answers stream over SSE; Claude cites `[n]`; citations are validated against the retrieved set before saving.
- Refusal handling: `stop_reason == "refusal"` checked; server-side `fallbacks: "default"` enabled.

## Production checklist

- Alembic migrations run on API start (advisory-locked); health/readiness endpoints for every service.
- Argon2id passwords, 15-min access JWT + rotating httpOnly refresh cookie, login rate limit, audit log.
- Per-workspace API key in a Fernet vault (`MultiFernet`, key rotation supported); never returned to the client.
- Upload limits (size, type allow-list), path-safe storage, SHA-256 dedupe.
- TLS at nginx (certs from `scripts/make-certs.sh`), security headers, CORS locked to the app origin.
- Nightly `pg_dump` with 14-day retention (`backup` service); restore documented.
- Tests: pytest (unit + API against real Postgres), DAG import test, Angular build/tests; GitHub Actions CI.

## Milestones

1. Backend core: settings, models, migrations, auth, workspaces, vault.
2. Ingestion package + Airflow image + DAGs.
3. Retrieval + answer streaming.
4. Angular app.
5. Compose, nginx/TLS, backups, CI, docs; deploy on ubuntu-hub and smoke-test end to end.
