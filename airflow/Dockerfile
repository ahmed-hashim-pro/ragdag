# syntax=docker/dockerfile:1.7
# Airflow plus the ragdag package. Airflow's own pinned versions win: the image's
# installed set is frozen into a constraints file before ragdag is added.
FROM apache/airflow:3.3.2-python3.12
USER airflow
COPY --chown=airflow backend/pyproject.toml /opt/ragdag/pyproject.toml
COPY --chown=airflow backend/src /opt/ragdag/src
RUN pip freeze > /tmp/airflow-constraints.txt \
 && pip install --no-cache-dir -c /tmp/airflow-constraints.txt /opt/ragdag \
 && rm /tmp/airflow-constraints.txt
ENV RAGDAG_EMBED_CACHE_DIR=/opt/airflow/models \
    HF_HUB_OFFLINE=0
RUN python -c "from ragdag.ingest.embedder import warm_up; warm_up()"
ENV HF_HUB_OFFLINE=1
COPY --chown=airflow airflow/dags /opt/airflow/dags
