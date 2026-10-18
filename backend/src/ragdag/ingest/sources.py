"""Fetching for ``ragdag_sync_sources``: URL and folder sources, with change detection.

URL fetches refuse private, loopback and link-local addresses (SSRF guard) and are
size-capped. Folder sources may only point inside ``<data_dir>/sources``, which is
where the host directories are mounted read-only.
"""

from __future__ import annotations

import fnmatch
import hashlib
import ipaddress
import socket
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from sqlalchemy import or_, select

from ragdag.db import session_scope
from ragdag.ingest.extract import SUPPORTED_TYPES, UnsupportedDocument, mime_for
from ragdag.models import Document, DocumentStatus, Source, SourceKind
from ragdag.settings import get_settings
from ragdag.storage import store_bytes

MAX_FETCH_BYTES = 20 * 1024 * 1024
MAX_FOLDER_FILES = 2000


class SourceError(RuntimeError):
    pass


@dataclass(frozen=True)
class FetchedItem:
    key: str  # URL or path relative to the folder root
    filename: str
    mime_type: str
    data: bytes


# --------------------------------------------------------------------------- guards


def _check_public_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise SourceError(f"cannot resolve {host}") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global:
            raise SourceError(f"{host} resolves to a non-public address ({ip}); refused")


def validate_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise SourceError("only absolute http(s) URLs are allowed")
    return url


def sources_root() -> Path:
    return (get_settings().data_dir / "sources").resolve()


def resolve_folder(path: str) -> Path:
    root = sources_root()
    target = (root / path.lstrip("/")).resolve()
    if not target.is_relative_to(root):
        raise SourceError("folder sources must be inside the mounted sources directory")
    return target


# --------------------------------------------------------------------------- fetch


def fetch_url(url: str) -> FetchedItem:
    validate_url(url)
    current = url
    with httpx.Client(
        timeout=30, follow_redirects=False, headers={"User-Agent": "ragdag/0.1"}
    ) as c:
        for _ in range(5):  # follow redirects manually so every hop is SSRF-checked
            _check_public_host(urlsplit(current).hostname or "")
            with c.stream("GET", current) as resp:
                if resp.is_redirect:
                    current = str(resp.url.join(resp.headers.get("location", "")))
                    validate_url(current)
                    continue
                resp.raise_for_status()
                body = bytearray()
                for part in resp.iter_bytes():
                    body.extend(part)
                    if len(body) > MAX_FETCH_BYTES:
                        raise SourceError(f"{url} is larger than {MAX_FETCH_BYTES >> 20} MB")
                ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                break
        else:
            raise SourceError("too many redirects")

    path_name = Path(urlsplit(current).path).name or "index.html"
    if ctype == "application/pdf" or path_name.lower().endswith(".pdf"):
        mime, filename = "application/pdf", path_name if path_name.endswith(".pdf") else "page.pdf"
    elif ctype in ("text/markdown", "text/plain") or Path(path_name).suffix in (".md", ".txt"):
        mime, filename = (
            ctype if ctype in ("text/markdown", "text/plain") else "text/plain",
            path_name,
        )
    else:
        mime = "text/html"
        filename = path_name if path_name.endswith((".html", ".htm")) else f"{path_name}.html"
    return FetchedItem(key=url, filename=filename, mime_type=mime, data=bytes(body))


def fetch_folder(path: str, pattern: str = "**/*") -> list[FetchedItem]:
    root = resolve_folder(path)
    if not root.is_dir():
        raise SourceError(f"folder {path!r} does not exist under the sources mount")
    items: list[FetchedItem] = []
    for file in sorted(root.rglob("*")):
        if not file.is_file() or file.suffix.lower() not in SUPPORTED_TYPES:
            continue
        rel = file.relative_to(root).as_posix()
        if any(part.startswith(".") for part in rel.split("/")):
            continue
        if pattern not in ("", "*", "**/*") and not fnmatch.fnmatch(rel, pattern):
            continue
        if file.stat().st_size > MAX_FETCH_BYTES:
            continue
        items.append(
            FetchedItem(
                key=rel, filename=file.name, mime_type=mime_for(file.name), data=file.read_bytes()
            )
        )
        if len(items) >= MAX_FOLDER_FILES:
            break
    return items


# --------------------------------------------------------------------------- DAG steps


def due_sources(now: datetime | None = None) -> list[str]:
    now = now or datetime.now(UTC)
    with session_scope() as session:
        sources = session.scalars(
            select(Source).where(
                Source.enabled.is_(True),
                or_(Source.last_synced_at.is_(None), Source.last_synced_at < now),
            )
        ).all()
        return [
            str(s.id)
            for s in sources
            if s.last_synced_at is None
            or s.last_synced_at + timedelta(minutes=s.interval_minutes) <= now
        ]


def sync_source(source_id: str) -> list[dict]:
    """Fetch one source and upsert its documents. Returns documents needing ingest."""
    sid = uuid.UUID(source_id)
    with session_scope() as session:
        src = session.get(Source, sid)
        if src is None or not src.enabled:
            return []
        kind, config = src.kind, dict(src.config)

    try:
        if kind == SourceKind.url:
            items = [fetch_url(config["url"])]
        else:
            items = fetch_folder(config.get("path", ""), config.get("glob", "**/*"))
    except (SourceError, httpx.HTTPError, UnsupportedDocument, OSError) as exc:
        with session_scope() as session:
            src = session.get(Source, sid)
            if src is not None:
                src.last_error = f"{type(exc).__name__}: {exc}"[:2000]
                src.last_synced_at = datetime.now(UTC)
        raise

    changed: list[dict] = []
    with session_scope() as session:
        src = session.get(Source, sid)
        if src is None:
            return []
        existing = {
            d.source_key: d
            for d in session.scalars(
                select(Document).where(
                    Document.source_id == sid, Document.status != DocumentStatus.deleted
                )
            )
        }
        seen: set[str] = set()
        for item in items:
            seen.add(item.key)
            sha = hashlib.sha256(item.data).hexdigest()
            doc = existing.get(item.key)
            if doc is not None and doc.sha256 == sha and doc.status != DocumentStatus.failed:
                continue
            if doc is None:
                doc = Document(
                    id=uuid.uuid4(),
                    workspace_id=src.workspace_id,
                    collection_id=src.collection_id,
                    source_id=sid,
                    source_key=item.key,
                    title=item.filename,
                    filename=item.filename,
                    mime_type=item.mime_type,
                    size_bytes=0,
                    sha256=sha,
                    storage_path="",
                )
                session.add(doc)
            path, sha = store_bytes(doc.workspace_id, doc.id, item.data, Path(item.filename).suffix)
            doc.storage_path, doc.sha256 = str(path), sha
            doc.size_bytes, doc.mime_type = len(item.data), item.mime_type
            doc.status, doc.error = DocumentStatus.pending, None
            session.flush()
            changed.append({"document_id": str(doc.id), "sha256": sha})

        # Items that vanished from a folder are soft-deleted; maintenance purges them.
        if kind == SourceKind.folder:
            for key, doc in existing.items():
                if key not in seen:
                    doc.status = DocumentStatus.deleted

        src.last_synced_at = datetime.now(UTC)
        src.last_error = None
    return changed
