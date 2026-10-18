# ragdag — common tasks. `make help` lists them.
SHELL := /bin/bash
COMPOSE := docker compose
NODE := source ~/.nvm/nvm.sh >/dev/null && nvm use 22.23.3 >/dev/null &&

.PHONY: help setup up down logs ps test test-backend test-dags test-web lint devdb build backup restore-check

help:
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-14s %s\n", $$1, $$2}'

setup: ## First-time setup: secrets + TLS certificate
	./scripts/init-env.sh
	./scripts/make-certs.sh

build: ## Build all images
	$(COMPOSE) build

up: ## Start (or update) the stack
	$(COMPOSE) up -d --build --remove-orphans

down: ## Stop the stack (data volumes are kept)
	$(COMPOSE) down

ps: ## Service status
	$(COMPOSE) ps

logs: ## Follow logs
	$(COMPOSE) logs -f --tail=100

backup: ## Take a backup right now
	$(COMPOSE) exec backup /backup.sh now

devdb: ## Throwaway pgvector container for tests (port 55432)
	docker start ragdag-devdb 2>/dev/null || docker run -d --name ragdag-devdb \
	  -e POSTGRES_USER=ragdag -e POSTGRES_PASSWORD=ragdag -e POSTGRES_DB=ragdag \
	  -p 127.0.0.1:55432:5432 pgvector/pgvector:0.8.7-pg17

test: test-backend test-dags test-web ## Run every test suite

test-backend: ## Backend unit + API tests (needs `make devdb`)
	cd backend && .venv/bin/pytest -q -p no:logging

test-dags: ## Import every DAG inside the Airflow image
	docker run --rm --entrypoint python -v $(PWD)/airflow/tests:/tests:ro \
	  -e RAGDAG_DATABASE_URL=postgresql+psycopg://x:x@localhost/x \
	  ragdag-airflow:$${RAGDAG_VERSION:-latest} /tests/test_dags.py

test-web: ## Angular unit tests + production build
	cd web && $(NODE) npm test -- --watch=false && $(NODE) npm run build

lint: ## Ruff
	cd backend && .venv/bin/ruff check src tests && .venv/bin/ruff format --check src tests
