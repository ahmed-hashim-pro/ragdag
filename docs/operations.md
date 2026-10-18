# Operations

## First deploy (ubuntu-hub)

```bash
cd ~/projects/claude_projects/ragdag
make setup            # .env with fresh secrets + TLS cert (own CA, or RAGDAG_CA_CERT/RAGDAG_CA_KEY)
make up               # build images and start everything
make ps               # all services healthy?
```

Open `RAGDAG_PUBLIC_URL` (default `https://<host-ip>:8443`). The first account created
becomes the owner of a new workspace; after that, sign-up is invitation-only unless
`RAGDAG_ALLOW_SIGNUP=true`. Then **Settings → Anthropic API key** (admins) — answers
need it; ingestion and search do not.

Airflow's own UI is at `/airflow/` (user `admin`, password `AIRFLOW_ADMIN_PASSWORD` in `.env`).

## Services

| Service | Role | Memory cap |
|---|---|---|
| `web` | nginx: TLS, SPA, reverse proxy for `/api` and `/airflow` | 256 MB |
| `api` | FastAPI (2 workers); runs migrations on start | 2 GB |
| `db` | Postgres 17 + pgvector; databases `ragdag` and `airflow` | 2 GB |
| `airflow-apiserver` | Airflow UI + REST API (used by `api`) | 1.5 GB |
| `airflow-scheduler` | schedules DAGs; LocalExecutor runs the tasks here | 3 GB |
| `airflow-dag-processor` | parses DAG files, runs DAG callbacks | 1 GB |
| `airflow-init` | one-shot: migrate Airflow DB, users, `embedding` pool | — |
| `backup` | nightly `pg_dump` of both databases | 512 MB |

## Upgrades

```bash
git pull
make up           # rebuilds images; the API applies new migrations under an advisory lock
```

## Backups and restore

Backups land in `RAGDAG_BACKUP_DIR` (default `./backups`) every night at `BACKUP_HOUR`
UTC and are kept `BACKUP_KEEP_DAYS` days. `make backup` takes one now.
Uploaded files live in the `ragdag-data` volume — back it up too
(`docker run --rm -v ragdag_ragdag-data:/d -v $PWD/backups:/b alpine tar czf /b/data.tgz -C /d .`).
Keep a copy of `.env`: without `RAGDAG_VAULT_KEYS` the stored API keys cannot be decrypted.

Restore into a stopped stack:

```bash
docker compose stop api airflow-apiserver airflow-scheduler airflow-dag-processor
docker compose exec -T db pg_restore -U ragdag -d ragdag --clean --if-exists < backups/ragdag-<stamp>.dump
docker compose exec -T db pg_restore -U ragdag -d airflow --clean --if-exists < backups/airflow-<stamp>.dump
docker compose up -d
```

## Rotating secrets

- **Vault key**: prepend a new Fernet key to `RAGDAG_VAULT_KEYS` (`new,old`), restart `api`,
  re-save each workspace's API key (or leave old ciphertexts — the old key still decrypts),
  then drop the old key.
- **JWT secret** (`RAGDAG_SECRET_KEY`): changing it signs everyone out of the UI.
- **Airflow service password**: change `AIRFLOW_SERVICE_PASSWORD`, then `docker compose up -d`
  (airflow-init resets it, api picks it up).

## Folder sources

Put files under `RAGDAG_SOURCES_DIR` (default `./data/sources`, mounted read-only). A
folder source's path is relative to that directory. Supported types: `.md .markdown .txt
.pdf .html .htm`. Files removed from the folder are removed from the collection on the
next sync.

## Troubleshooting

- **Document stuck in pending**: Airflow was unreachable when it was uploaded. The sync DAG
  re-queues such documents after 10 minutes; or press *Re-ingest*.
- **Run shows failed with "could not start the pipeline"**: `docker compose logs airflow-apiserver`;
  the API logs in to Airflow as `ragdag-service`.
- **Answers say no API key**: an admin must add one under Settings.
- Logs are JSON on stdout: `docker compose logs -f api`.
