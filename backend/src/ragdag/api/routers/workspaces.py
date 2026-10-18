"""Workspaces, members, invitations, the API-key vault, audit log and usage."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import anthropic
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import Integer, Numeric, case, cast, delete, func, select
from sqlalchemy.orm import Session

from ragdag.answer import check_api_key
from ragdag.api.deps import WorkspaceAccess, admin, audit, current_user, owner, viewer
from ragdag.api.routers.auth import unique_slug
from ragdag.api.schemas import (
    ApiKeyIn,
    ApiKeyStatusOut,
    AuditOut,
    InviteIn,
    InviteOut,
    MemberOut,
    MemberRoleIn,
    UsageOut,
    WorkspaceIn,
    WorkspaceOut,
)
from ragdag.db import get_session
from ragdag.models import (
    ROLE_RANK,
    AuditEvent,
    Chunk,
    Conversation,
    Document,
    DocumentStatus,
    Invitation,
    Membership,
    Message,
    Role,
    User,
    Workspace,
    WorkspaceSecret,
)
from ragdag.security import encrypt_secret, new_opaque_token, secret_hint
from ragdag.settings import get_settings
from ragdag.storage import delete_workspace_files

router = APIRouter(tags=["workspaces"])

API_KEY_KIND = "anthropic_api_key"
INVITE_DAYS = 7


@router.post("/workspaces", response_model=WorkspaceOut, status_code=201)
def create_workspace(
    body: WorkspaceIn,
    request: Request,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> Workspace:
    ws = Workspace(name=body.name.strip(), slug=unique_slug(session, body.name))
    session.add(ws)
    session.flush()
    session.add(Membership(workspace_id=ws.id, user_id=user.id, role=Role.owner))
    audit(
        session,
        "workspace.create",
        workspace_id=ws.id,
        user_id=user.id,
        target=ws.name,
        request=request,
    )
    session.commit()
    return ws


@router.get("/w/{ws_id}", response_model=WorkspaceOut)
def get_workspace(access: WorkspaceAccess = Depends(viewer)) -> Workspace:
    return access.workspace


@router.patch("/w/{ws_id}", response_model=WorkspaceOut)
def rename_workspace(
    body: WorkspaceIn,
    request: Request,
    access: WorkspaceAccess = Depends(admin),
    session: Session = Depends(get_session),
) -> Workspace:
    ws = session.get(Workspace, access.id)
    ws.name = body.name.strip()
    audit(
        session,
        "workspace.rename",
        workspace_id=ws.id,
        user_id=access.user.id,
        target=ws.name,
        request=request,
    )
    session.commit()
    return ws


@router.delete("/w/{ws_id}", status_code=204)
def delete_workspace(
    request: Request,
    access: WorkspaceAccess = Depends(owner),
    session: Session = Depends(get_session),
) -> None:
    session.execute(delete(Workspace).where(Workspace.id == access.id))
    audit(
        session,
        "workspace.delete",
        user_id=access.user.id,
        target=str(access.id),
        meta={"name": access.workspace.name},
        request=request,
    )
    session.commit()
    delete_workspace_files(access.id)


# --------------------------------------------------------------------------- members


@router.get("/w/{ws_id}/members", response_model=list[MemberOut])
def list_members(
    access: WorkspaceAccess = Depends(viewer), session: Session = Depends(get_session)
) -> list[MemberOut]:
    rows = session.scalars(
        select(Membership)
        .where(Membership.workspace_id == access.id)
        .order_by(Membership.created_at)
    ).all()
    return [
        MemberOut(
            user_id=m.user_id,
            email=m.user.email,
            name=m.user.name,
            role=m.role,
            joined_at=m.created_at,
        )
        for m in rows
    ]


def _owner_count(session: Session, ws_id: uuid.UUID) -> int:
    return session.scalar(
        select(func.count()).where(Membership.workspace_id == ws_id, Membership.role == Role.owner)
    )


@router.patch("/w/{ws_id}/members/{user_id}", response_model=MemberOut)
def change_role(
    user_id: uuid.UUID,
    body: MemberRoleIn,
    request: Request,
    access: WorkspaceAccess = Depends(admin),
    session: Session = Depends(get_session),
) -> MemberOut:
    m = session.scalar(
        select(Membership).where(
            Membership.workspace_id == access.id, Membership.user_id == user_id
        )
    )
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")
    # Admins manage editors and viewers; only owners touch owners or grant ownership.
    touches_owner = m.role == Role.owner or body.role == Role.owner
    if touches_owner and access.role != Role.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an owner can change ownership")
    if ROLE_RANK[m.role] >= ROLE_RANK[access.role] and access.role != Role.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "cannot change a member at your level")
    if m.role == Role.owner and body.role != Role.owner and _owner_count(session, access.id) <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "a workspace needs at least one owner")
    old = m.role
    m.role = body.role
    audit(
        session,
        "member.role",
        workspace_id=access.id,
        user_id=access.user.id,
        target=m.user.email,
        meta={"from": old.value, "to": body.role.value},
        request=request,
    )
    session.commit()
    return MemberOut(
        user_id=m.user_id, email=m.user.email, name=m.user.name, role=m.role, joined_at=m.created_at
    )


@router.delete("/w/{ws_id}/members/{user_id}", status_code=204)
def remove_member(
    user_id: uuid.UUID,
    request: Request,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> None:
    m = session.scalar(
        select(Membership).where(
            Membership.workspace_id == access.id, Membership.user_id == user_id
        )
    )
    if m is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "member not found")
    leaving = user_id == access.user.id
    if not leaving:
        if ROLE_RANK[access.role] < ROLE_RANK[Role.admin]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "requires admin role")
        if m.role == Role.owner and access.role != Role.owner:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "only an owner can remove an owner")
    if m.role == Role.owner and _owner_count(session, access.id) <= 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "a workspace needs at least one owner")
    email = m.user.email
    session.delete(m)
    audit(
        session,
        "member.leave" if leaving else "member.remove",
        workspace_id=access.id,
        user_id=access.user.id,
        target=email,
        request=request,
    )
    session.commit()


# --------------------------------------------------------------------------- invitations


def _invite_out(inv: Invitation, url: str | None = None) -> InviteOut:
    return InviteOut(
        id=inv.id,
        email=inv.email,
        role=inv.role,
        expires_at=inv.expires_at,
        accepted_at=inv.accepted_at,
        created_at=inv.created_at,
        invite_url=url,
    )


@router.get("/w/{ws_id}/invitations", response_model=list[InviteOut])
def list_invites(
    access: WorkspaceAccess = Depends(admin), session: Session = Depends(get_session)
) -> list[InviteOut]:
    rows = session.scalars(
        select(Invitation)
        .where(Invitation.workspace_id == access.id, Invitation.accepted_at.is_(None))
        .order_by(Invitation.created_at.desc())
    ).all()
    return [_invite_out(i) for i in rows]


@router.post("/w/{ws_id}/invitations", response_model=InviteOut, status_code=201)
def create_invite(
    body: InviteIn,
    request: Request,
    access: WorkspaceAccess = Depends(admin),
    session: Session = Depends(get_session),
) -> InviteOut:
    if body.role == Role.owner and access.role != Role.owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only an owner can invite an owner")
    email = body.email.lower()
    already = session.scalar(
        select(Membership.id)
        .join(User, User.id == Membership.user_id)
        .where(Membership.workspace_id == access.id, User.email == email)
    )
    if already:
        raise HTTPException(status.HTTP_409_CONFLICT, "already a member")
    token, digest = new_opaque_token()
    inv = Invitation(
        workspace_id=access.id,
        email=email,
        role=body.role,
        token_hash=digest,
        invited_by=access.user.id,
        expires_at=datetime.now(UTC) + timedelta(days=INVITE_DAYS),
    )
    session.add(inv)
    audit(
        session,
        "member.invite",
        workspace_id=access.id,
        user_id=access.user.id,
        target=email,
        meta={"role": body.role.value},
        request=request,
    )
    session.commit()
    url = f"{get_settings().public_url.rstrip('/')}/invite/{token}"
    return _invite_out(inv, url)


@router.delete("/w/{ws_id}/invitations/{invite_id}", status_code=204)
def revoke_invite(
    invite_id: uuid.UUID,
    request: Request,
    access: WorkspaceAccess = Depends(admin),
    session: Session = Depends(get_session),
) -> None:
    inv = session.get(Invitation, invite_id)
    if inv is None or inv.workspace_id != access.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    session.delete(inv)
    audit(
        session,
        "member.invite_revoked",
        workspace_id=access.id,
        user_id=access.user.id,
        target=inv.email,
        request=request,
    )
    session.commit()


# --------------------------------------------------------------------------- API key vault


def _key_status(session: Session, ws_id: uuid.UUID) -> ApiKeyStatusOut:
    row = session.scalar(
        select(WorkspaceSecret).where(
            WorkspaceSecret.workspace_id == ws_id, WorkspaceSecret.kind == API_KEY_KIND
        )
    )
    return ApiKeyStatusOut(
        configured=row is not None,
        hint=row.hint if row else None,
        updated_at=row.updated_at if row else None,
        model=get_settings().claude_model,
    )


@router.get("/w/{ws_id}/api-key", response_model=ApiKeyStatusOut)
def api_key_status(
    access: WorkspaceAccess = Depends(viewer), session: Session = Depends(get_session)
) -> ApiKeyStatusOut:
    return _key_status(session, access.id)


@router.put("/w/{ws_id}/api-key", response_model=ApiKeyStatusOut)
async def set_api_key(
    body: ApiKeyIn,
    request: Request,
    access: WorkspaceAccess = Depends(admin),
    session: Session = Depends(get_session),
) -> ApiKeyStatusOut:
    try:
        await check_api_key(body.api_key)
    except anthropic.AuthenticationError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "Anthropic rejected this API key"
        ) from None
    except anthropic.PermissionDeniedError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "this key cannot use the configured Claude model"
        ) from None
    except (anthropic.APIConnectionError, anthropic.APIStatusError) as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, f"could not verify the key with Anthropic: {exc}"
        ) from None

    row = session.scalar(
        select(WorkspaceSecret).where(
            WorkspaceSecret.workspace_id == access.id, WorkspaceSecret.kind == API_KEY_KIND
        )
    )
    if row is None:
        row = WorkspaceSecret(workspace_id=access.id, kind=API_KEY_KIND, ciphertext="", hint="")
        session.add(row)
    row.ciphertext = encrypt_secret(body.api_key)
    row.hint = secret_hint(body.api_key)
    row.updated_by = access.user.id
    row.updated_at = datetime.now(UTC)
    audit(
        session,
        "apikey.set",
        workspace_id=access.id,
        user_id=access.user.id,
        target=row.hint,
        request=request,
    )
    session.commit()
    return _key_status(session, access.id)


@router.delete("/w/{ws_id}/api-key", status_code=204)
def delete_api_key(
    request: Request,
    access: WorkspaceAccess = Depends(admin),
    session: Session = Depends(get_session),
) -> None:
    session.execute(
        delete(WorkspaceSecret).where(
            WorkspaceSecret.workspace_id == access.id, WorkspaceSecret.kind == API_KEY_KIND
        )
    )
    audit(session, "apikey.delete", workspace_id=access.id, user_id=access.user.id, request=request)
    session.commit()


# --------------------------------------------------------------------------- audit & usage


@router.get("/w/{ws_id}/audit", response_model=list[AuditOut])
def audit_log(
    limit: int = 100,
    before: int | None = None,
    access: WorkspaceAccess = Depends(admin),
    session: Session = Depends(get_session),
) -> list[AuditOut]:
    q = (
        select(AuditEvent, User.email)
        .outerjoin(User, User.id == AuditEvent.user_id)
        .where(AuditEvent.workspace_id == access.id)
        .order_by(AuditEvent.id.desc())
        .limit(min(max(limit, 1), 500))
    )
    if before:
        q = q.where(AuditEvent.id < before)
    return [
        AuditOut(
            id=e.id,
            action=e.action,
            target=e.target,
            meta=e.meta,
            user_email=email,
            created_at=e.created_at,
        )
        for e, email in session.execute(q).all()
    ]


@router.get("/w/{ws_id}/usage", response_model=UsageOut)
def usage(
    days: int = 30,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> UsageOut:
    since = datetime.now(UTC) - timedelta(days=min(max(days, 1), 365))

    def tokens(key: str):
        return func.coalesce(func.sum(cast(Message.usage[key].astext, Integer)), 0)

    row = session.execute(
        select(
            func.count(),
            func.count(case((Message.status == "ok", 1))),
            func.count(case((Message.status == "refused", 1))),
            func.count(case((Message.status == "no_evidence", 1))),
            tokens("input_tokens"),
            tokens("output_tokens"),
            tokens("cache_read_input_tokens"),
            func.coalesce(func.sum(cast(Message.usage["cost_usd"].astext, Numeric)), 0),
        )
        .join(Conversation, Conversation.id == Message.conversation_id)
        .where(
            Conversation.workspace_id == access.id,
            Message.role == "assistant",
            Message.created_at >= since,
        )
    ).one()
    docs = session.scalar(
        select(func.count()).where(
            Document.workspace_id == access.id, Document.status != DocumentStatus.deleted
        )
    )
    chunks = session.scalar(select(func.count()).where(Chunk.workspace_id == access.id))
    return UsageOut(
        questions=row[0],
        answered=row[1],
        refused=row[2],
        no_evidence=row[3],
        input_tokens=row[4],
        output_tokens=row[5],
        cache_read_input_tokens=row[6],
        cost_usd=round(float(row[7]), 4),
        documents=docs,
        chunks=chunks,
    )
