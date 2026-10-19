# ragdag

[![CI](https://github.com/ahmed-hashim-pro/ragdag/actions/workflows/ci.yml/badge.svg)](https://github.com/ahmed-hashim-pro/ragdag/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A self-hosted, multi-user knowledge base. Teams upload documents (or point it at
folders and web pages); **Airflow DAGs** extract, chunk, embed and index them into
**Postgres + pgvector**; members ask questions and **Claude** answers strictly from
those documents, with numbered citations back to the exact passages.

```
 upload / folder / URL                                   question
        │                                                    │
        ▼                                                    ▼
 ┌─────────────────────── Airflow ───────────────────────┐  ┌──────── FastAPI ────────┐
 │ ragdag_sync_sources (*/15)  → trigger_ingest (mapped) │  │ hybrid retrieval         │
 │ ragdag_ingest_document:                               │  │  pgvector HNSW cosine    │
 │   prepare → extract → chunk → embed_and_index →       │  │  + Postgres full-text    │
 │   finalize                                            │  │  → RRF fusion            │
 │ ragdag_reindex_collection · ragdag_maintenance        │  │ local rerank · gate      │
 └───────────────────────────┬───────────────────────────┘  │ Claude (streamed, [n])   │
                             ▼                              └────────────┬─────────────┘
                    Postgres 17 + pgvector  ◀────────────────────────────┘
```

## Features

- **Workspaces and roles**: owner, admin, editor, viewer. Invitation links, audit log, usage stats.
- **Ingestion as DAGs**: every upload is an Airflow run with retries. You can see each task's
  state and logs in the app, and Airflow's UI is at `/airflow/`. Runs that become stale skip
  themselves, errors that retrying can't fix fail fast, and lost triggers are re-queued
  automatically.
- **Sources**: folders on the host (read-only mount) and web pages, polled on a per-source
  interval with SHA-256 change detection. URL fetches are blocked from reaching private
  addresses (SSRF guard).
- **RAG that refuses to guess**: hybrid dense + keyword retrieval fused by RRF, a similarity
  floor that refuses before any API call, retrieved text fenced as untrusted data, and
  citations checked against what was actually retrieved.
- **Question understanding**: Claude Haiku rewrites each question before searching. It fixes
  typos, turns follow-ups like "and the second one?" into standalone questions, and pulls out
  exact terms such as error codes. It also spots questions about the whole collection
  ("what's in here?"), which are answered from an outline of every document, and replies to
  greetings without calling the big model. It costs about $0.0001 a question.
- **English and Arabic**: multilingual embeddings (`paraphrase-multilingual-MiniLM-L12-v2`)
  and Arabic-aware full-text search (Postgres's Arabic stemmer and stopwords) match questions
  to documents in either language, including across languages. Claude answers in the
  language of the question.
- **Reranking**: a local multilingual cross-encoder (`bge-reranker-v2-m3`, Apache-2.0)
  re-scores the top 12 matches before the best are sent to Claude. It's free and runs
  offline, adding about 2 s per question on a 12-core CPU.
- **Search-quality test set**: `evals/` has 39 questions in English and Arabic, including
  cross-language and off-topic ones. `make eval` prints how well search does on them, and a
  test fails CI if quality drops.
- **Cost tracking**: every answer shows its token counts and estimated dollar cost, and the
  workspace usage page totals them. Prices are configurable.
- **Claude Opus 5.5**: answers stream over SSE. Each workspace has its own encrypted API key,
  and server-side refusal fallback is enabled.
- **Local embeddings**: fastembed ONNX `all-MiniLM-L6-v2`, baked into the images, so
  indexing costs nothing.
- **Production basics**: TLS, Argon2id, rotating refresh tokens with reuse detection, rate
  limits, migrations on deploy, health checks, JSON logs, nightly backups, memory caps, CI.

## Quick start (single host)

```bash
make setup     # .env with generated secrets + TLS certificate
make up        # build and start
```

Open `https://<host>:8443`. The first person to sign up becomes the owner. Then add an
Anthropic API key under **Settings**. Day-2 operations (backups, restore, upgrades, secret
rotation) are covered in [docs/operations.md](docs/operations.md).

## Development

```bash
make devdb                                   # pgvector on 127.0.0.1:55432
cd backend && uv venv -p 3.12 .venv && uv pip install -p .venv -e '.[api,dev]'
make test-backend test-dags test-web lint
RAGDAG_ENV=development RAGDAG_DATABASE_URL=postgresql+psycopg://ragdag:ragdag@127.0.0.1:55432/ragdag \
  backend/.venv/bin/uvicorn ragdag.api.main:app --reload      # API on :8000
cd web && npm start                                          # UI on :4200, proxies /api
docker compose exec -T api python - < scripts/smoke.py       # end-to-end check of a running stack
```

| Path | What |
|---|---|
| `backend/src/ragdag/` | the shared package: models, auth, retrieval, answers, ingestion steps |
| `backend/src/ragdag/api/` | FastAPI app and routers |
| `backend/migrations/` | Alembic migrations |
| `airflow/dags/` | the four DAGs (thin wrappers around `ragdag.ingest`) |
| `web/` | Angular 22 app |
| `deploy/` | nginx, Postgres init, backup script |
| `docs/openapi.json` | API contract |
