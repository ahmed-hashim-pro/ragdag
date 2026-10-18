"""Sign-up, login, token refresh (rotating, reuse-detecting), logout, profile."""

from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ragdag.api.deps import audit, client_ip, current_user, limiter
from ragdag.api.schemas import (
    AcceptInviteIn,
    BootstrapOut,
    InvitePreviewOut,
    LoginIn,
    MembershipOut,
    MeOut,
    PasswordChangeIn,
    RegisterIn,
    TokenOut,
    UserOut,
)
from ragdag.db import get_session
from ragdag.ingest.extract import SUPPORTED_TYPES
from ragdag.models import Invitation, Membership, RefreshToken, Role, User, Workspace
from ragdag.security import (
    create_access_token,
    hash_password,
    hash_token,
    new_opaque_token,
    password_needs_rehash,
    verify_password,
)
from ragdag.settings import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE = "ragdag_refresh"
COOKIE_PATH = "/api/auth"


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
    return slug or "workspace"


def unique_slug(session: Session, name: str) -> str:
    base = slugify(name)
    slug, n = base, 1
    while session.scalar(select(Workspace.id).where(Workspace.slug == slug)):
        n += 1
        slug = f"{base}-{n}"
    return slug


def _set_refresh_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(
        REFRESH_COOKIE,
        token,
        max_age=s.refresh_token_days * 86400,
        httponly=True,
        secure=s.is_production,
        samesite="strict",
        path=COOKIE_PATH,
    )


def _issue_tokens(
    session: Session,
    response: Response,
    user: User,
    request: Request,
    family_id: uuid.UUID | None = None,
) -> TokenOut:
    token, digest = new_opaque_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=digest,
            family_id=family_id or uuid.uuid4(),
            expires_at=datetime.now(UTC) + timedelta(days=get_settings().refresh_token_days),
            user_agent=(request.headers.get("user-agent") or "")[:300],
        )
    )
    _set_refresh_cookie(response, token)
    access, ttl = create_access_token(user.id)
    return TokenOut(access_token=access, expires_in=ttl)


def _valid_invite(session: Session, token: str) -> Invitation:
    invite = session.scalar(select(Invitation).where(Invitation.token_hash == hash_token(token)))
    if invite is None or invite.accepted_at or invite.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invitation is invalid or has expired")
    return invite


def _join(session: Session, invite: Invitation, user: User) -> None:
    exists = session.scalar(
        select(Membership).where(
            Membership.workspace_id == invite.workspace_id, Membership.user_id == user.id
        )
    )
    if exists is None:
        session.add(Membership(workspace_id=invite.workspace_id, user_id=user.id, role=invite.role))
    invite.accepted_at = datetime.now(UTC)


@router.get("/bootstrap", response_model=BootstrapOut)
def bootstrap(session: Session = Depends(get_session)) -> BootstrapOut:
    has_users = session.scalar(select(func.count()).select_from(User)) > 0
    settings = get_settings()
    return BootstrapOut(
        needs_setup=not has_users,
        allow_signup=settings.allow_signup,
        max_upload_mb=settings.max_upload_mb,
        upload_extensions=sorted(SUPPORTED_TYPES),
    )


@router.get("/invite/{token}", response_model=InvitePreviewOut)
def invite_preview(token: str, session: Session = Depends(get_session)) -> InvitePreviewOut:
    invite = _valid_invite(session, token)
    ws = session.get(Workspace, invite.workspace_id)
    user_exists = session.scalar(select(User.id).where(User.email == invite.email)) is not None
    return InvitePreviewOut(
        workspace_id=ws.id,
        workspace_name=ws.name,
        email=invite.email,
        role=invite.role,
        user_exists=user_exists,
    )


@router.post("/register", response_model=TokenOut, status_code=201)
def register(
    body: RegisterIn,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
) -> TokenOut:
    limiter.check(f"register:{client_ip(request)}", get_settings().login_rate_per_minute)
    email = body.email.lower()
    # Serialise the "first user" check so two concurrent sign-ups cannot both become owner.
    session.execute(select(func.pg_advisory_xact_lock(7_741_001)))
    first_user = session.scalar(select(func.count()).select_from(User)) == 0

    invite = _valid_invite(session, body.invite_token) if body.invite_token else None
    if invite and invite.email != email:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this invitation is for another email")
    if not (first_user or invite or get_settings().allow_signup):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "sign-up is by invitation only")

    user = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password))
    session.add(user)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "an account with this email exists") from None

    if invite:
        _join(session, invite, user)
        ws_id = invite.workspace_id
    else:
        name = (body.workspace_name or f"{user.name}'s workspace").strip()
        ws = Workspace(name=name, slug=unique_slug(session, name))
        session.add(ws)
        session.flush()
        session.add(Membership(workspace_id=ws.id, user_id=user.id, role=Role.owner))
        ws_id = ws.id

    audit(
        session,
        "user.register",
        workspace_id=ws_id,
        user_id=user.id,
        target=email,
        meta={"first_user": first_user, "via_invite": bool(invite)},
        request=request,
    )
    user.last_login_at = datetime.now(UTC)
    tokens = _issue_tokens(session, response, user, request)
    session.commit()
    return tokens


@router.post("/login", response_model=TokenOut)
def login(
    body: LoginIn,
    request: Request,
    response: Response,
    session: Session = Depends(get_session),
) -> TokenOut:
    email = body.email.lower()
    rate = get_settings().login_rate_per_minute
    limiter.check(f"login-ip:{client_ip(request)}", rate * 3)
    limiter.check(f"login-email:{email}", rate)
    user = session.scalar(select(User).where(User.email == email))
    if not verify_password(user.password_hash if user else None, body.password) or not (
        user and user.is_active
    ):
        audit(session, "user.login_failed", target=email, request=request)
        session.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "wrong email or password")
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    user.last_login_at = datetime.now(UTC)
    tokens = _issue_tokens(session, response, user, request)
    audit(session, "user.login", user_id=user.id, request=request)
    session.commit()
    return tokens


@router.post("/refresh", response_model=TokenOut)
def refresh(
    request: Request, response: Response, session: Session = Depends(get_session)
) -> TokenOut:
    # Custom header: a cross-site form post cannot set it (belt to SameSite's braces).
    if request.headers.get("x-ragdag") != "1":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "missing X-Ragdag header")
    token = request.cookies.get(REFRESH_COOKIE)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "no session")
    row = session.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_token(token)).with_for_update()
    )
    now = datetime.now(UTC)
    if row is None or row.expires_at < now:
        response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired")
    if row.revoked_at is not None:
        # A rotated token came back: assume theft and end every session in the family.
        session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == row.family_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        audit(session, "user.refresh_reuse", user_id=row.user_id, request=request)
        session.commit()
        response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session revoked")
    user = session.get(User, row.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "account disabled")
    row.revoked_at = now
    tokens = _issue_tokens(session, response, user, request, family_id=row.family_id)
    session.commit()
    return tokens


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, session: Session = Depends(get_session)) -> None:
    token = request.cookies.get(REFRESH_COOKIE)
    if token:
        row = session.scalar(
            select(RefreshToken).where(RefreshToken.token_hash == hash_token(token))
        )
        if row is not None:
            session.execute(
                update(RefreshToken)
                .where(RefreshToken.family_id == row.family_id, RefreshToken.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )
            session.commit()
    response.delete_cookie(REFRESH_COOKIE, path=COOKIE_PATH)


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(current_user), session: Session = Depends(get_session)) -> MeOut:
    memberships = session.scalars(
        select(Membership).where(Membership.user_id == user.id).order_by(Membership.created_at)
    ).all()
    return MeOut(
        user=UserOut.model_validate(user),
        memberships=[
            MembershipOut(
                workspace_id=m.workspace_id,
                workspace_name=m.workspace.name,
                workspace_slug=m.workspace.slug,
                role=m.role,
            )
            for m in memberships
        ],
    )


@router.post("/password", status_code=204)
def change_password(
    body: PasswordChangeIn,
    request: Request,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> None:
    limiter.check(f"password:{user.id}", 5)
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "current password is wrong")
    user.password_hash = hash_password(body.new_password)
    # Other sessions end; the caller keeps working until its access token expires.
    session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    audit(session, "user.password_changed", user_id=user.id, request=request)
    session.commit()


@router.post("/accept-invite", response_model=MeOut)
def accept_invite(
    body: AcceptInviteIn,
    request: Request,
    user: User = Depends(current_user),
    session: Session = Depends(get_session),
) -> MeOut:
    invite = _valid_invite(session, body.token)
    if invite.email != user.email:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "this invitation is for another email")
    _join(session, invite, user)
    audit(
        session,
        "member.joined",
        workspace_id=invite.workspace_id,
        user_id=user.id,
        target=user.email,
        meta={"role": invite.role.value},
        request=request,
    )
    session.commit()
    return me(user, session)
