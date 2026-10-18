"""Shared FastAPI dependencies: current user, workspace access by role, rate limits, audit."""

from __future__ import annotations

import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from ragdag.db import get_session
from ragdag.models import ROLE_RANK, AuditEvent, Membership, Role, User, Workspace
from ragdag.security import decode_access_token

_bearer = HTTPBearer(auto_error=False)


def client_ip(request: Request) -> str:
    # nginx sets X-Real-IP; the API is never exposed without it.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    session: Session = Depends(get_session),
) -> User:
    user_id = decode_access_token(creds.credentials) if creds else None
    user = session.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


@dataclass
class WorkspaceAccess:
    workspace: Workspace
    user: User
    role: Role

    @property
    def id(self) -> uuid.UUID:
        return self.workspace.id


def require_role(minimum: Role):
    """Dependency factory: the caller must be a member of ``ws_id`` with at least ``minimum``."""

    def dependency(
        ws_id: uuid.UUID,
        user: User = Depends(current_user),
        session: Session = Depends(get_session),
    ) -> WorkspaceAccess:
        membership = session.scalar(
            select(Membership).where(
                Membership.workspace_id == ws_id, Membership.user_id == user.id
            )
        )
        # Non-members get 404, not 403: workspace ids are not confirmed to outsiders.
        if membership is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
        if ROLE_RANK[membership.role] < ROLE_RANK[minimum]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"requires {minimum.value} role")
        return WorkspaceAccess(membership.workspace, user, membership.role)

    return dependency


viewer = require_role(Role.viewer)
editor = require_role(Role.editor)
admin = require_role(Role.admin)
owner = require_role(Role.owner)


def audit(
    session: Session,
    action: str,
    *,
    workspace_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
    target: str | None = None,
    meta: dict[str, Any] | None = None,
    request: Request | None = None,
) -> None:
    session.add(
        AuditEvent(
            workspace_id=workspace_id,
            user_id=user_id,
            action=action,
            target=target,
            meta=meta or {},
            ip=client_ip(request) if request else None,
        )
    )


class RateLimiter:
    """Sliding-window limiter, per process. The API runs one process per container."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window: float = 60.0) -> None:
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= now - window:
                hits.popleft()
            if len(hits) >= limit:
                retry = int(window - (now - hits[0])) + 1
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    "too many requests; slow down",
                    headers={"Retry-After": str(retry)},
                )
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()
