"""Collections, their documents (upload, list, delete, retry) and their sources."""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ragdag.api.deps import WorkspaceAccess, audit, editor, viewer
from ragdag.api.schemas import (
    ChunkOut,
    CollectionIn,
    CollectionOut,
    CollectionPatch,
    DocumentOut,
    DocumentPage,
    PipelineRunOut,
    SourceIn,
    SourceOut,
    SourcePatch,
    UploadResult,
)
from ragdag.collection_settings import CollectionSettings
from ragdag.db import get_session
from ragdag.ingest.extract import UnsupportedDocument, mime_for
from ragdag.ingest.sources import SourceError, resolve_folder, validate_url
from ragdag.models import Chunk, Collection, Document, DocumentStatus, Source, SourceKind
from ragdag.pipelines import REINDEX_DAG, SYNC_DAG, trigger, trigger_ingest
from ragdag.settings import get_settings
from ragdag.storage import delete_document_files, store_bytes

router = APIRouter(prefix="/w/{ws_id}", tags=["collections"])


def _collection(session: Session, access: WorkspaceAccess, collection_id: uuid.UUID) -> Collection:
    coll = session.get(Collection, collection_id)
    if coll is None or coll.workspace_id != access.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "collection not found")
    return coll


def _document(session: Session, access: WorkspaceAccess, document_id: uuid.UUID) -> Document:
    doc = session.get(Document, document_id)
    if doc is None or doc.workspace_id != access.id or doc.status == DocumentStatus.deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "document not found")
    return doc


def _collection_out(session: Session, coll: Collection) -> CollectionOut:
    counts = session.execute(
        select(
            func.count(),
            func.count().filter(Document.status == DocumentStatus.ready),
            func.coalesce(func.sum(Document.chunk_count), 0),
        ).where(Document.collection_id == coll.id, Document.status != DocumentStatus.deleted)
    ).one()
    return CollectionOut(
        id=coll.id,
        name=coll.name,
        description=coll.description,
        settings=CollectionSettings.of(coll.settings),
        created_at=coll.created_at,
        document_count=counts[0],
        ready_count=counts[1],
        chunk_count=counts[2],
    )


# --------------------------------------------------------------------------- collections


@router.get("/collections", response_model=list[CollectionOut])
def list_collections(
    access: WorkspaceAccess = Depends(viewer), session: Session = Depends(get_session)
) -> list[CollectionOut]:
    rows = session.scalars(
        select(Collection).where(Collection.workspace_id == access.id).order_by(Collection.name)
    ).all()
    return [_collection_out(session, c) for c in rows]


@router.post("/collections", response_model=CollectionOut, status_code=201)
def create_collection(
    body: CollectionIn,
    request: Request,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> CollectionOut:
    coll = Collection(
        workspace_id=access.id,
        name=body.name.strip(),
        description=body.description,
        settings=body.settings.model_dump(),
    )
    session.add(coll)
    try:
        session.flush()
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a collection with this name exists"
        ) from None
    audit(
        session,
        "collection.create",
        workspace_id=access.id,
        user_id=access.user.id,
        target=coll.name,
        request=request,
    )
    session.commit()
    return _collection_out(session, coll)


@router.get("/collections/{collection_id}", response_model=CollectionOut)
def get_collection(
    collection_id: uuid.UUID,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> CollectionOut:
    return _collection_out(session, _collection(session, access, collection_id))


@router.patch("/collections/{collection_id}", response_model=CollectionOut)
async def update_collection(
    collection_id: uuid.UUID,
    body: CollectionPatch,
    request: Request,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> CollectionOut:
    coll = _collection(session, access, collection_id)
    reindex = False
    if body.name is not None:
        coll.name = body.name.strip()
    if body.description is not None:
        coll.description = body.description
    if body.settings is not None:
        reindex = body.settings.changes_chunking(CollectionSettings.of(coll.settings))
        coll.settings = body.settings.model_dump()
    try:
        session.flush()
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "a collection with this name exists"
        ) from None
    audit(
        session,
        "collection.update",
        workspace_id=access.id,
        user_id=access.user.id,
        target=coll.name,
        meta={"reindex": reindex},
        request=request,
    )
    session.commit()
    if reindex:
        # New chunk sizes only take effect once every document is re-chunked.
        await trigger(
            session,
            dag_id=REINDEX_DAG,
            conf={"collection_id": str(coll.id)},
            kind="reindex",
            workspace_id=access.id,
            collection_id=coll.id,
            user_id=access.user.id,
        )
    return _collection_out(session, coll)


@router.delete("/collections/{collection_id}", status_code=204)
def delete_collection(
    collection_id: uuid.UUID,
    request: Request,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> None:
    coll = _collection(session, access, collection_id)
    doc_ids = session.scalars(select(Document.id).where(Document.collection_id == coll.id)).all()
    session.delete(coll)  # documents, chunks, sources, conversations cascade
    audit(
        session,
        "collection.delete",
        workspace_id=access.id,
        user_id=access.user.id,
        target=coll.name,
        meta={"documents": len(doc_ids)},
        request=request,
    )
    session.commit()
    for doc_id in doc_ids:
        delete_document_files(access.id, doc_id)


@router.post("/collections/{collection_id}/reindex", response_model=PipelineRunOut, status_code=202)
async def reindex_collection(
    collection_id: uuid.UUID,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
):
    coll = _collection(session, access, collection_id)
    return await trigger(
        session,
        dag_id=REINDEX_DAG,
        conf={"collection_id": str(coll.id)},
        kind="reindex",
        workspace_id=access.id,
        collection_id=coll.id,
        user_id=access.user.id,
    )


# --------------------------------------------------------------------------- documents


@router.get("/collections/{collection_id}/documents", response_model=DocumentPage)
def list_documents(
    collection_id: uuid.UUID,
    q: str | None = None,
    status_filter: str | None = None,
    offset: int = 0,
    limit: int = 50,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> DocumentPage:
    _collection(session, access, collection_id)
    where = [Document.collection_id == collection_id, Document.status != DocumentStatus.deleted]
    if q:
        escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{escaped}%"
        where.append(or_(Document.title.ilike(like), Document.filename.ilike(like)))
    if status_filter:
        try:
            where.append(Document.status == DocumentStatus(status_filter))
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "unknown status") from None
    total = session.scalar(select(func.count()).where(*where))
    rows = session.scalars(
        select(Document)
        .where(*where)
        .order_by(Document.created_at.desc())
        .offset(max(offset, 0))
        .limit(min(max(limit, 1), 200))
    ).all()
    return DocumentPage(items=[DocumentOut.model_validate(d) for d in rows], total=total)


@router.post("/collections/{collection_id}/documents", response_model=UploadResult, status_code=201)
async def upload_document(
    collection_id: uuid.UUID,
    request: Request,
    file: UploadFile = File(...),
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> UploadResult:
    coll = _collection(session, access, collection_id)
    filename = Path(file.filename or "upload").name[:500]
    try:
        mime = mime_for(filename)
    except UnsupportedDocument as exc:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, str(exc)) from None

    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"file is larger than {get_settings().max_upload_mb} MB",
        )
    if not data:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "file is empty")

    sha = hashlib.sha256(data).hexdigest()
    dup = session.scalar(
        select(Document).where(
            Document.collection_id == coll.id,
            Document.sha256 == sha,
            Document.status != DocumentStatus.deleted,
        )
    )
    if dup is not None:
        return UploadResult(document=DocumentOut.model_validate(dup), duplicate=True)

    doc = Document(
        id=uuid.uuid4(),
        workspace_id=access.id,
        collection_id=coll.id,
        title=filename,
        filename=filename,
        mime_type=mime,
        size_bytes=len(data),
        sha256=sha,
        storage_path="",
        created_by=access.user.id,
    )
    path, _ = store_bytes(access.id, doc.id, data, Path(filename).suffix)
    doc.storage_path = str(path)
    session.add(doc)
    audit(
        session,
        "document.upload",
        workspace_id=access.id,
        user_id=access.user.id,
        target=filename,
        meta={"collection": coll.name, "bytes": len(data)},
        request=request,
    )
    session.commit()
    await trigger_ingest(session, doc, access.user.id)
    session.refresh(doc)
    return UploadResult(document=DocumentOut.model_validate(doc))


@router.get("/documents/{document_id}", response_model=DocumentOut)
def get_document(
    document_id: uuid.UUID,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> Document:
    return _document(session, access, document_id)


@router.get("/documents/{document_id}/chunks", response_model=list[ChunkOut])
def document_chunks(
    document_id: uuid.UUID,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> list[Chunk]:
    _document(session, access, document_id)
    return list(
        session.scalars(
            select(Chunk).where(Chunk.document_id == document_id).order_by(Chunk.ordinal)
        ).all()
    )


@router.post("/documents/{document_id}/reingest", response_model=PipelineRunOut, status_code=202)
async def reingest_document(
    document_id: uuid.UUID,
    request: Request,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
):
    doc = _document(session, access, document_id)
    doc.status, doc.error = DocumentStatus.pending, None
    audit(
        session,
        "document.reingest",
        workspace_id=access.id,
        user_id=access.user.id,
        target=doc.filename,
        request=request,
    )
    session.commit()
    return await trigger_ingest(session, doc, access.user.id)


@router.delete("/documents/{document_id}", status_code=204)
def delete_document(
    document_id: uuid.UUID,
    request: Request,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> None:
    doc = _document(session, access, document_id)
    # Soft delete: retrieval ignores it at once; the maintenance DAG purges rows and files.
    doc.status = DocumentStatus.deleted
    audit(
        session,
        "document.delete",
        workspace_id=access.id,
        user_id=access.user.id,
        target=doc.filename,
        request=request,
    )
    session.commit()


# --------------------------------------------------------------------------- sources


def _source(session: Session, access: WorkspaceAccess, source_id: uuid.UUID) -> Source:
    src = session.get(Source, source_id)
    if src is None or src.workspace_id != access.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "source not found")
    return src


@router.get("/collections/{collection_id}/sources", response_model=list[SourceOut])
def list_sources(
    collection_id: uuid.UUID,
    access: WorkspaceAccess = Depends(viewer),
    session: Session = Depends(get_session),
) -> list[Source]:
    _collection(session, access, collection_id)
    return list(
        session.scalars(
            select(Source).where(Source.collection_id == collection_id).order_by(Source.created_at)
        ).all()
    )


@router.post("/collections/{collection_id}/sources", response_model=SourceOut, status_code=201)
async def create_source(
    collection_id: uuid.UUID,
    body: SourceIn,
    request: Request,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> Source:
    _collection(session, access, collection_id)
    try:
        if body.kind == "url":
            if not body.url:
                raise SourceError("url is required")
            config = {"url": validate_url(body.url.strip(), resolve=True)}
        else:
            if not body.path:
                raise SourceError("path is required")
            resolve_folder(body.path)
            config = {"path": body.path.strip().lstrip("/"), "glob": body.glob}
    except SourceError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from None
    src = Source(
        workspace_id=access.id,
        collection_id=collection_id,
        kind=SourceKind(body.kind),
        name=body.name.strip(),
        config=config,
        interval_minutes=body.interval_minutes,
        enabled=body.enabled,
    )
    session.add(src)
    audit(
        session,
        "source.create",
        workspace_id=access.id,
        user_id=access.user.id,
        target=src.name,
        meta=config,
        request=request,
    )
    session.commit()
    await trigger(
        session,
        dag_id=SYNC_DAG,
        conf={"source_ids": [str(src.id)]},
        kind="sync",
        workspace_id=access.id,
        collection_id=collection_id,
        user_id=access.user.id,
    )
    return src


@router.patch("/sources/{source_id}", response_model=SourceOut)
def update_source(
    source_id: uuid.UUID,
    body: SourcePatch,
    request: Request,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> Source:
    src = _source(session, access, source_id)
    for field in ("name", "interval_minutes", "enabled"):
        value = getattr(body, field)
        if value is not None:
            setattr(src, field, value)
    audit(
        session,
        "source.update",
        workspace_id=access.id,
        user_id=access.user.id,
        target=src.name,
        request=request,
    )
    session.commit()
    return src


@router.post("/sources/{source_id}/sync", response_model=PipelineRunOut, status_code=202)
async def sync_source_now(
    source_id: uuid.UUID,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
):
    src = _source(session, access, source_id)
    return await trigger(
        session,
        dag_id=SYNC_DAG,
        conf={"source_ids": [str(src.id)]},
        kind="sync",
        workspace_id=access.id,
        collection_id=src.collection_id,
        user_id=access.user.id,
    )


@router.delete("/sources/{source_id}", status_code=204)
def delete_source(
    source_id: uuid.UUID,
    request: Request,
    delete_documents: bool = False,
    access: WorkspaceAccess = Depends(editor),
    session: Session = Depends(get_session),
) -> None:
    src = _source(session, access, source_id)
    if delete_documents:
        for doc in session.scalars(select(Document).where(Document.source_id == src.id)):
            doc.status = DocumentStatus.deleted
    session.delete(src)
    audit(
        session,
        "source.delete",
        workspace_id=access.id,
        user_id=access.user.id,
        target=src.name,
        meta={"delete_documents": delete_documents},
        request=request,
    )
    session.commit()
