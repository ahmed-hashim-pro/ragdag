"""Local sentence embeddings via fastembed (ONNX, CPU). Loaded once per process."""

from __future__ import annotations

import threading
from collections.abc import Sequence
from functools import lru_cache

from ragdag.settings import EMBED_MODEL, get_settings

_lock = threading.Lock()


@lru_cache
def _model():
    from fastembed import TextEmbedding

    cache = get_settings().embed_cache_dir
    return TextEmbedding(model_name=EMBED_MODEL, cache_dir=str(cache) if cache else None)


def embed_texts(texts: Sequence[str], batch_size: int = 64) -> list[list[float]]:
    """L2-normalised vectors, one per input, in input order."""
    if not texts:
        return []
    with _lock:  # ONNX sessions are thread-safe, but loading is not
        model = _model()
    return [vec.tolist() for vec in model.embed(list(texts), batch_size=batch_size)]


def embed_query(text: str) -> list[float]:
    return embed_texts([text])[0]


def warm_up() -> None:
    embed_query("warm up")
