"""Content storage on the shared data volume. Paths are built only from UUIDs and hashes."""

from __future__ import annotations

import hashlib
import shutil
import uuid
from pathlib import Path

from ragdag.settings import get_settings


def document_dir(workspace_id: uuid.UUID, document_id: uuid.UUID) -> Path:
    return get_settings().uploads_dir / str(workspace_id) / str(document_id)


def store_bytes(
    workspace_id: uuid.UUID, document_id: uuid.UUID, data: bytes, suffix: str
) -> tuple[Path, str]:
    """Write ``data`` atomically; returns ``(path, sha256)``. Old versions are removed."""
    sha = hashlib.sha256(data).hexdigest()
    folder = document_dir(workspace_id, document_id)
    folder.mkdir(parents=True, exist_ok=True)
    suffix = suffix.lower() if suffix.startswith(".") and suffix[1:].isalnum() else ""
    target = folder / f"{sha}{suffix}"
    if not target.exists():
        tmp = folder / f".{sha}.tmp"
        tmp.write_bytes(data)
        tmp.replace(target)
    for old in folder.iterdir():
        if old != target and not old.name.startswith("."):
            old.unlink(missing_ok=True)
    return target, sha


def delete_workspace_files(workspace_id: uuid.UUID) -> None:
    shutil.rmtree(get_settings().uploads_dir / str(workspace_id), ignore_errors=True)


def delete_document_files(workspace_id: uuid.UUID, document_id: uuid.UUID) -> None:
    shutil.rmtree(document_dir(workspace_id, document_id), ignore_errors=True)
