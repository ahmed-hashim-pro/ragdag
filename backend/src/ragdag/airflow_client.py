"""Minimal async client for the Airflow 3 REST API (v2), authenticated as a service user."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from ragdag.settings import get_settings


class AirflowError(RuntimeError):
    pass


class AirflowClient:
    def __init__(self) -> None:
        s = get_settings()
        self._base = s.airflow_url.rstrip("/")
        self._username = s.airflow_username
        self._password = s.airflow_password.get_secret_value()
        self._http = httpx.AsyncClient(timeout=15)
        self._token: str | None = None
        self._token_expiry = 0.0
        self._lock = asyncio.Lock()

    async def _auth_header(self, force: bool = False) -> dict[str, str]:
        async with self._lock:
            if force or not self._token or time.monotonic() > self._token_expiry:
                resp = await self._http.post(
                    f"{self._base}/auth/token",
                    json={"username": self._username, "password": self._password},
                )
                if resp.status_code >= 400:
                    raise AirflowError(f"Airflow login failed ({resp.status_code})")
                self._token = resp.json()["access_token"]
                self._token_expiry = time.monotonic() + 20 * 60  # tokens last longer; refresh early
        return {"Authorization": f"Bearer {self._token}"}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self._base}/api/v2{path}"
        try:
            resp = await self._http.request(
                method, url, headers=await self._auth_header(), **kwargs
            )
            if resp.status_code == 401:
                headers = await self._auth_header(force=True)
                resp = await self._http.request(method, url, headers=headers, **kwargs)
        except httpx.HTTPError as exc:
            raise AirflowError(f"Airflow unreachable: {exc}") from exc
        if resp.status_code >= 400:
            raise AirflowError(f"Airflow {method} {path} -> {resp.status_code}: {resp.text[:300]}")
        return resp.json() if resp.content else None

    async def trigger(self, dag_id: str, conf: dict[str, Any], run_id: str) -> dict[str, Any]:
        return await self._request(
            "POST",
            f"/dags/{dag_id}/dagRuns",
            json={"dag_run_id": run_id, "logical_date": None, "conf": conf},
        )

    async def dag_run(self, dag_id: str, run_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/dags/{dag_id}/dagRuns/{run_id}")

    async def task_instances(self, dag_id: str, run_id: str) -> list[dict[str, Any]]:
        data = await self._request("GET", f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances")
        return data.get("task_instances", [])

    async def task_log(self, dag_id: str, run_id: str, task_id: str, try_number: int) -> str:
        data = await self._request(
            "GET",
            f"/dags/{dag_id}/dagRuns/{run_id}/taskInstances/{task_id}/logs/{try_number}",
            params={"full_content": "true"},
        )
        content = data.get("content", "") if isinstance(data, dict) else data
        if isinstance(content, list):  # structured log lines
            return "\n".join(
                str(line.get("event", line)) if isinstance(line, dict) else str(line)
                for line in content
            )
        return str(content)

    async def dag_structure(self, dag_id: str) -> list[dict[str, Any]]:
        data = await self._request("GET", f"/dags/{dag_id}/tasks")
        return [
            {"task_id": t["task_id"], "downstream": t.get("downstream_task_ids", [])}
            for t in data.get("tasks", [])
        ]

    async def health(self) -> bool:
        try:
            resp = await self._http.get(f"{self._base}/api/v2/monitor/health")
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    async def aclose(self) -> None:
        await self._http.aclose()


_client: AirflowClient | None = None


def get_airflow() -> AirflowClient:
    global _client
    if _client is None:
        _client = AirflowClient()
    return _client
