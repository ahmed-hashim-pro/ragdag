"""Questions (streamed over SSE), retrieval preview, and conversation history."""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any

import anthropic
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ragdag.answer import NO_EVIDENCE_ANSWER, citation_payload, stream_answer
from ragdag.api.deps import WorkspaceAccess, audit, limiter, viewer
from ragdag.api.routers.workspaces import API_KEY_KIND
from ragdag.api.schemas import (
    AskIn,
    ConversationDetailOut,
    ConversationOut,
    MessageOut,
    SearchHit,
    SearchIn,
    SearchOut,
)
from ragdag.collection_settings import CollectionSettings
from ragdag.db import get_session, session_scope
from ragdag.models import Collection, Conversation, Message, WorkspaceSecret
from ragdag.retrieval import retrieve
from ragdag.security import VaultError, decrypt_secret
from ragdag.settings import get_settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/w/{ws_id}", tags=["ask"])

HISTORY_MESSAGES = 6


def _sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n".encode()


def _collection(session: Session, access: WorkspaceAccess, collection_id: uuid.UUID) -> Collection:
    coll = session.get(Collection, collection_id)
    if coll is None or coll.workspace_id != access.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "collection not found")
    return coll


def _conversation(session: Session, access: WorkspaceAccess, conv_id: uuid.UUID) -> Conversation:
    conv = session.get(Conversation, conv_id)
    if conv is None or conv.workspace_id != access.id or conv.user_id != access.user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "conversation not found")
    return conv


def _api_key(session: Session, ws_id: uuid.UUID) -> str:
    row = session.scalar(
        select(WorkspaceSecret).where(
            WorkspaceSecret.workspace_id == ws_id, WorkspaceSecret.kind == API_KEY_KIND
        )
    )
    if row is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "No Anthropic API key is configured for this workspace. "
            "An admin can add one under Settings.",
        )
    try:
        return decrypt_secret(row.ciphertext)
    except VaultError:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "the stored API key cannot be decrypted; an admin must enter it again",
        ) from None


@router.post("/search", response_model=SearchOut)
async def search(
    body: SearchIn,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> SearchOut:
    coll = _collection(session, access, body.collection_id)
    settings = CollectionSettings.of(coll.settings)
    result = await run_in_threadpool(retrieve, session, coll.id, body.query, body.top_k)
    session.rollback()  # ends the read transaction holding the SET LOCALs
    return SearchOut(
        hits=[
            SearchHit(
                chunk_id=c.chunk_id,
                document_id=c.document_id,
                title=c.title,
                heading=c.heading,
                content=c.content,
                score=c.score,
                similarity=c.similarity,
                lexical=c.lexical,
            )
            for c in result.chunks
        ],
        best_similarity=result.best_similarity,
        confident=result.is_confident(settings.similarity_floor),
    )


@router.post("/ask")
async def ask(
    body: AskIn,
    request: Request,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> StreamingResponse:
    limiter.check(f"ask:{access.user.id}", get_settings().ask_rate_per_minute)
    coll = _collection(session, access, body.collection_id)
    settings = CollectionSettings.of(coll.settings)
    api_key = _api_key(session, access.id)

    if body.conversation_id:
        conv = _conversation(session, access, body.conversation_id)
        if conv.collection_id != coll.id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "conversation is for another collection"
            )
    else:
        conv = Conversation(
            workspace_id=access.id,
            collection_id=coll.id,
            user_id=access.user.id,
            title=body.question.strip()[:120],
        )
        session.add(conv)
        session.flush()

    prior = session.scalars(
        select(Message)
        .where(Message.conversation_id == conv.id, Message.status.in_(["ok", "no_evidence"]))
        .order_by(Message.created_at.desc())
        .limit(HISTORY_MESSAGES)
    ).all()[::-1]
    # Keep strictly alternating user/assistant pairs, starting with a user turn.
    history: list[tuple[str, str]] = []
    for m in prior:
        if (m.role == "user") == (len(history) % 2 == 0):
            history.append((m.role, m.content))
    if len(history) % 2:
        history.pop()

    question = body.question.strip()
    # Follow-ups ("and the second one?") retrieve better with the previous question attached.
    retrieval_query = f"{history[-2][1]}\n{question}" if history else question

    user_msg = Message(conversation_id=conv.id, role="user", content=question)
    session.add(user_msg)
    session.commit()
    conv_id, user_msg_id = conv.id, user_msg.id

    result = await run_in_threadpool(retrieve, session, coll.id, retrieval_query, settings.top_k)
    session.rollback()
    chunks = result.chunks
    confident = result.is_confident(settings.similarity_floor)

    async def events() -> AsyncIterator[bytes]:
        started = time.monotonic()
        yield _sse("meta", {"conversation_id": conv_id, "user_message_id": user_msg_id})

        def save(content: str, status_: str, citations: list, model: str | None, usage: dict):
            with session_scope() as s:
                msg = Message(
                    conversation_id=conv_id,
                    role="assistant",
                    content=content,
                    citations=citations,
                    status=status_,
                    model=model,
                    usage=usage,
                    latency_ms=int((time.monotonic() - started) * 1000),
                )
                s.add(msg)
                s.flush()
                conv_row = s.get(Conversation, conv_id)
                if conv_row is not None:
                    conv_row.updated_at = msg.created_at
                return MessageOut.model_validate(msg).model_dump(mode="json")

        if not confident:
            saved = save(NO_EVIDENCE_ANSWER, "no_evidence", [], None, {})
            yield _sse("delta", {"text": NO_EVIDENCE_ANSWER})
            yield _sse("done", {"message": saved, "best_similarity": result.best_similarity})
            return

        candidates = citation_payload(chunks)
        yield _sse("sources", {"sources": candidates})
        partial: list[str] = []
        try:
            async for ev in stream_answer(
                api_key=api_key,
                history=history,
                question=question,
                chunks=chunks,
                effort=settings.effort,
            ):
                if ev.type == "delta":
                    partial.append(ev.data["text"])
                    yield _sse("delta", ev.data)
                elif ev.type == "reset":
                    partial.clear()
                    yield _sse("reset", {})
                elif ev.type == "done":
                    used = [c for c in candidates if c["n"] in ev.data["used"]]
                    saved = await run_in_threadpool(
                        save,
                        ev.data["answer"],
                        ev.data["status"],
                        used,
                        ev.data["model"],
                        ev.data["usage"],
                    )
                    yield _sse("done", {"message": saved})
        except anthropic.AuthenticationError:
            msg = "The workspace's Anthropic API key was rejected. An admin must update it."
            await run_in_threadpool(save, msg, "error", [], None, {})
            yield _sse("error", {"message": msg})
        except anthropic.RateLimitError:
            msg = "Anthropic rate limit reached. Try again in a minute."
            await run_in_threadpool(save, msg, "error", [], None, {})
            yield _sse("error", {"message": msg})
        except anthropic.APIError as exc:
            log.exception("answer failed")
            msg = f"The model request failed ({type(exc).__name__}). Try again."
            await run_in_threadpool(save, "".join(partial) or msg, "error", [], None, {})
            yield _sse("error", {"message": msg})

    with session_scope() as s:
        audit(
            s,
            "ask",
            workspace_id=access.id,
            user_id=access.user.id,
            target=str(conv_id),
            meta={"collection": coll.name, "confident": confident},
            request=request,
        )

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- conversations


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations(
    collection_id: uuid.UUID | None = None,
    limit: int = 50,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> list[Conversation]:
    q = select(Conversation).where(
        Conversation.workspace_id == access.id, Conversation.user_id == access.user.id
    )
    if collection_id:
        q = q.where(Conversation.collection_id == collection_id)
    return list(
        session.scalars(q.order_by(Conversation.updated_at.desc()).limit(min(limit, 200))).all()
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationDetailOut)
def get_conversation(
    conversation_id: uuid.UUID,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> ConversationDetailOut:
    conv = _conversation(session, access, conversation_id)
    msgs = session.scalars(
        select(Message).where(Message.conversation_id == conv.id).order_by(Message.created_at)
    ).all()
    return ConversationDetailOut(
        **ConversationOut.model_validate(conv).model_dump(),
        messages=[MessageOut.model_validate(m) for m in msgs],
    )


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: uuid.UUID,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> None:
    session.delete(_conversation(session, access, conversation_id))
    session.commit()
