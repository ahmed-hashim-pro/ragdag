"""Request and response bodies for the HTTP API."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from ragdag.collection_settings import CollectionSettings
from ragdag.models import Role


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --------------------------------------------------------------------------- auth


class RegisterIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=10, max_length=256)
    workspace_name: str | None = Field(None, max_length=120)
    invite_token: str | None = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(max_length=256)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(max_length=256)
    new_password: str = Field(min_length=10, max_length=256)


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


class UserOut(ORM):
    id: uuid.UUID
    email: str
    name: str
    created_at: datetime


class MembershipOut(BaseModel):
    workspace_id: uuid.UUID
    workspace_name: str
    workspace_slug: str
    role: Role


class MeOut(BaseModel):
    user: UserOut
    memberships: list[MembershipOut]


class InvitePreviewOut(BaseModel):
    workspace_name: str
    email: str
    role: Role
    user_exists: bool


class AcceptInviteIn(BaseModel):
    token: str


class BootstrapOut(BaseModel):
    needs_setup: bool
    allow_signup: bool


# --------------------------------------------------------------------------- workspaces


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class WorkspaceOut(ORM):
    id: uuid.UUID
    name: str
    slug: str
    created_at: datetime


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    name: str
    role: Role
    joined_at: datetime


class MemberRoleIn(BaseModel):
    role: Role


class InviteIn(BaseModel):
    email: EmailStr
    role: Role = Role.viewer


class InviteOut(BaseModel):
    id: uuid.UUID
    email: str
    role: Role
    expires_at: datetime
    accepted_at: datetime | None
    created_at: datetime
    # Only present in the create response: the link is shown once, never stored in clear.
    invite_url: str | None = None


class ApiKeyIn(BaseModel):
    api_key: str = Field(min_length=20, max_length=300)

    @field_validator("api_key")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class ApiKeyStatusOut(BaseModel):
    configured: bool
    hint: str | None = None
    updated_at: datetime | None = None
    model: str


class AuditOut(BaseModel):
    id: int
    action: str
    target: str | None
    meta: dict[str, Any]
    user_email: str | None
    created_at: datetime


class UsageOut(BaseModel):
    questions: int
    answered: int
    refused: int
    no_evidence: int
    input_tokens: int
    output_tokens: int
    cache_read_input_tokens: int
    documents: int
    chunks: int


# --------------------------------------------------------------------------- collections


class CollectionIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=2000)
    settings: CollectionSettings = Field(default_factory=CollectionSettings)


class CollectionPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=2000)
    settings: CollectionSettings | None = None


class CollectionOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    settings: CollectionSettings
    created_at: datetime
    document_count: int = 0
    ready_count: int = 0
    chunk_count: int = 0


class DocumentOut(ORM):
    id: uuid.UUID
    collection_id: uuid.UUID
    source_id: uuid.UUID | None
    title: str
    filename: str
    mime_type: str
    size_bytes: int
    sha256: str
    status: str
    error: str | None
    chunk_count: int
    token_count: int
    created_at: datetime
    updated_at: datetime
    indexed_at: datetime | None


class DocumentPage(BaseModel):
    items: list[DocumentOut]
    total: int


class ChunkOut(ORM):
    id: int
    ordinal: int
    heading: str
    content: str
    token_count: int


class UploadResult(BaseModel):
    document: DocumentOut
    duplicate: bool = False


class SourceIn(BaseModel):
    kind: Literal["url", "folder"]
    name: str = Field(min_length=1, max_length=200)
    url: str | None = Field(None, max_length=2000)
    path: str | None = Field(None, max_length=500)
    glob: str = Field("**/*", max_length=200)
    interval_minutes: int = Field(60, ge=15, le=10080)
    enabled: bool = True


class SourcePatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    interval_minutes: int | None = Field(None, ge=15, le=10080)
    enabled: bool | None = None


class SourceOut(ORM):
    id: uuid.UUID
    collection_id: uuid.UUID
    kind: str
    name: str
    config: dict[str, Any]
    interval_minutes: int
    enabled: bool
    last_synced_at: datetime | None
    last_error: str | None
    created_at: datetime


# --------------------------------------------------------------------------- pipelines


class PipelineRunOut(ORM):
    id: uuid.UUID
    dag_id: str
    dag_run_id: str
    state: str
    collection_id: uuid.UUID | None
    document_id: uuid.UUID | None
    conf: dict[str, Any]
    error: str | None
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None


class RunPage(BaseModel):
    items: list[PipelineRunOut]
    total: int


class TaskNode(BaseModel):
    task_id: str
    downstream: list[str]
    state: str | None = None
    try_number: int | None = None
    map_index: int = -1
    mapped_count: int = 0
    start_date: datetime | None = None
    end_date: datetime | None = None
    duration: float | None = None


class RunDetailOut(BaseModel):
    run: PipelineRunOut
    airflow_state: str | None
    tasks: list[TaskNode]
    airflow_ui_url: str | None


class TaskLogOut(BaseModel):
    task_id: str
    try_number: int
    content: str


# --------------------------------------------------------------------------- ask


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=4000)
    collection_id: uuid.UUID
    conversation_id: uuid.UUID | None = None


class MessageOut(ORM):
    id: uuid.UUID
    role: str
    content: str
    citations: list[dict[str, Any]]
    status: str
    model: str | None
    usage: dict[str, Any]
    latency_ms: int | None
    created_at: datetime


class ConversationOut(ORM):
    id: uuid.UUID
    collection_id: uuid.UUID
    title: str
    created_at: datetime
    updated_at: datetime


class ConversationDetailOut(ConversationOut):
    messages: list[MessageOut]


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    collection_id: uuid.UUID
    top_k: int = Field(8, ge=1, le=30)


class SearchHit(BaseModel):
    chunk_id: int
    document_id: uuid.UUID
    title: str
    heading: str
    content: str
    score: float
    similarity: float | None
    lexical: bool


class SearchOut(BaseModel):
    hits: list[SearchHit]
    best_similarity: float
    confident: bool
