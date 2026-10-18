"""Hybrid retrieval: pgvector cosine + Postgres full-text, fused by reciprocal rank fusion."""

from __future__ import annotations

import threading
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache

from sqlalchemy import text
from sqlalchemy.orm import Session

from ragdag.ingest.embedder import embed_query
from ragdag.settings import get_settings

RRF_K = 60
CANDIDATES = 40
RERANK_POOL = 30

_DENSE_SQL = text(
    """
    SELECT c.id, 1 - (c.embedding <=> CAST(:vec AS vector)) AS sim
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.collection_id = :cid AND d.status = 'ready'
    ORDER BY c.embedding <=> CAST(:vec AS vector)
    LIMIT :n
    """
)

# Questions are matched with OR semantics over their stemmed lexemes; the stored
# tsvector weights headings (A) above body text (B).
_LEXICAL_SQL = text(
    """
    WITH q AS (
        SELECT to_tsquery('simple', array_to_string(
            tsvector_to_array(to_tsvector('english', :question)), ' | ')) AS query
    )
    SELECT c.id, ts_rank_cd(c.tsv, q.query, 32) AS rank
    FROM chunks c JOIN documents d ON d.id = c.document_id, q
    WHERE c.collection_id = :cid AND d.status = 'ready' AND c.tsv @@ q.query
    ORDER BY rank DESC
    LIMIT :n
    """
)

_FETCH_SQL = text(
    """
    SELECT c.id, c.document_id, c.heading, c.content, c.ordinal, d.title, d.filename
    FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.id = ANY(:ids)
    """
)


@dataclass
class Retrieved:
    chunk_id: int
    document_id: uuid.UUID
    title: str
    filename: str
    heading: str
    content: str
    ordinal: int
    score: float  # fused RRF score
    similarity: float | None  # dense cosine similarity, if the dense retriever saw it
    lexical: bool  # matched the full-text query
    rerank_score: float | None = None  # cross-encoder relevance, when reranked


@dataclass
class RetrievalResult:
    chunks: list[Retrieved]
    best_similarity: float
    lexical_hits: int

    def is_confident(self, floor: float) -> bool:
        """Dense similarity clears the floor, or an exact-term match props up a near miss."""
        if not self.chunks:
            return False
        if self.best_similarity >= floor:
            return True
        return self.lexical_hits > 0 and self.best_similarity >= floor * 0.6


def _has_lexemes(session: Session, question: str) -> bool:
    return bool(
        session.execute(
            text("SELECT length(to_tsvector('english', :q)) > 0"), {"q": question}
        ).scalar()
    )


def _ranked_lists(session: Session, collection_id: uuid.UUID, query: str) -> tuple[list, list]:
    """Dense and lexical candidate lists for one query, best first."""
    vec = embed_query(query)
    vec_literal = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"
    # pgvector >= 0.8: keep scanning the HNSW graph until enough rows pass the filter.
    session.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
    session.execute(text("SET LOCAL hnsw.ef_search = 100"))
    dense = session.execute(
        _DENSE_SQL, {"vec": vec_literal, "cid": collection_id, "n": CANDIDATES}
    ).all()
    lexical = (
        session.execute(
            _LEXICAL_SQL, {"question": query, "cid": collection_id, "n": CANDIDATES}
        ).all()
        if _has_lexemes(session, query)
        else []
    )
    return dense, lexical


def search(
    session: Session,
    collection_id: uuid.UUID,
    queries: Sequence[str],
    top_k: int,
    rerank_query: str | None = None,
) -> RetrievalResult:
    """Hybrid search over one or more phrasings of a question.

    Every query contributes a dense and a lexical ranked list; all lists are fused
    by reciprocal rank fusion. With ``rerank_query`` the fused pool (top
    ``RERANK_POOL``) is re-scored by a local cross-encoder against that query and
    the best ``top_k`` kept; otherwise the RRF order stands.
    """
    queries = list(dict.fromkeys(q.strip() for q in queries if q and q.strip()))
    scores: dict[int, float] = {}
    sims: dict[int, float] = {}
    lexical_ids: set[int] = set()
    anchors: list[int] = []
    lexical_hits = 0
    for query in queries:
        dense, lexical = _ranked_lists(session, collection_id, query)
        for rank, row in enumerate(dense):
            scores[row.id] = scores.get(row.id, 0.0) + 1.0 / (RRF_K + rank + 1)
            sims[row.id] = max(sims.get(row.id, 0.0), float(row.sim))
        for rank, row in enumerate(lexical):
            scores[row.id] = scores.get(row.id, 0.0) + 1.0 / (RRF_K + rank + 1)
            lexical_ids.add(row.id)
        lexical_hits = max(lexical_hits, len(lexical))
        # Each retriever's best hit is kept in the pool: RRF can bury a strong
        # exact-term match (an error code, a part number) only one retriever found.
        anchors += [r[0].id for r in (dense, lexical) if r]

    pool_size = max(RERANK_POOL, top_k) if rerank_query else top_k
    ranked = sorted(scores, key=scores.__getitem__, reverse=True)[:pool_size]
    anchors = list(dict.fromkeys(anchors))
    for anchor in anchors:
        if anchor in ranked:
            continue
        if len(ranked) < pool_size:
            ranked.append(anchor)
            continue
        for i in range(len(ranked) - 1, -1, -1):
            if ranked[i] not in anchors:
                ranked[i] = anchor
                break

    rows = {r.id: r for r in session.execute(_FETCH_SQL, {"ids": ranked}).all()} if ranked else {}
    chunks = [
        Retrieved(
            chunk_id=cid,
            document_id=rows[cid].document_id,
            title=rows[cid].title,
            filename=rows[cid].filename,
            heading=rows[cid].heading,
            content=rows[cid].content,
            ordinal=rows[cid].ordinal,
            score=scores[cid],
            similarity=sims.get(cid),
            lexical=cid in lexical_ids,
        )
        for cid in ranked
        if cid in rows
    ]
    if rerank_query and chunks:
        for chunk, value in zip(chunks, rerank_scores(rerank_query, chunks), strict=True):
            chunk.rerank_score = value
        chunks.sort(key=lambda c: c.rerank_score, reverse=True)
    return RetrievalResult(
        chunks=chunks[:top_k],
        best_similarity=max(sims.values(), default=0.0),
        lexical_hits=lexical_hits,
    )


def retrieve(
    session: Session,
    collection_id: uuid.UUID,
    question: str,
    top_k: int,
    rerank: bool = False,
) -> RetrievalResult:
    return search(session, collection_id, [question], top_k, question if rerank else None)


def retrieve_for_turn(
    session: Session,
    collection_id: uuid.UUID,
    question: str,
    previous_question: str | None,
    top_k: int,
    rerank: bool = False,
) -> RetrievalResult:
    """Retrieve for a chat turn without a query plan. The question alone leads.

    A follow-up like "and the second one?" needs the previous question to retrieve
    anything, but a self-contained question must not have its passages crowded out by
    the previous topic. With reranking, scoring against the current question does
    that; without it, the combined query contributes at most a quarter of the slots.
    """
    if not previous_question:
        return retrieve(session, collection_id, question, top_k, rerank)
    combined_query = f"{previous_question}\n{question}"
    if rerank:
        return search(session, collection_id, [question, combined_query], top_k, question)
    primary = retrieve(session, collection_id, question, top_k)
    combined = retrieve(session, collection_id, combined_query, top_k)
    seen = {c.chunk_id for c in primary.chunks}
    extra = [c for c in combined.chunks if c.chunk_id not in seen][: max(2, top_k // 4)]
    keep = primary.chunks[: max(top_k - len(extra), 0)]
    return RetrievalResult(
        chunks=keep + extra,
        best_similarity=max(primary.best_similarity, combined.best_similarity),
        lexical_hits=max(primary.lexical_hits, combined.lexical_hits),
    )


def retrieve_with_plan(
    session: Session,
    collection_id: uuid.UUID,
    question: str,
    search_query: str,
    keywords: Sequence[str],
    top_k: int,
    rerank: bool,
) -> RetrievalResult:
    """Search with the raw question, the rewritten query and the exact keywords together."""
    queries = [question, search_query]
    if keywords:
        queries.append(" ".join(keywords))
    return search(session, collection_id, queries, top_k, search_query if rerank else None)


# --------------------------------------------------------------------------- reranking

_rerank_lock = threading.Lock()


@lru_cache
def _cross_encoder():
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    settings = get_settings()
    cache = settings.embed_cache_dir
    return TextCrossEncoder(
        model_name=settings.reranker_model, cache_dir=str(cache) if cache else None
    )


def rerank_scores(query: str, chunks: Sequence[Retrieved]) -> list[float]:
    """Cross-encoder relevance of each chunk to ``query`` (higher is better)."""
    with _rerank_lock:  # loading is not thread-safe
        model = _cross_encoder()
    docs = [f"{c.heading}\n{c.content}" if c.heading else c.content for c in chunks]
    return [float(s) for s in model.rerank(query, docs, batch_size=32)]


def warm_up_reranker() -> None:
    rerank_scores(
        "warm up", [Retrieved(0, uuid.uuid4(), "", "", "", "warm up", 0, 0.0, None, False)]
    )


# --------------------------------------------------------------------------- overview

_OVERVIEW_SQL = text(
    """
    SELECT d.id, d.title, d.filename,
           (SELECT c.id FROM chunks c WHERE c.document_id = d.id ORDER BY c.ordinal LIMIT 1)
               AS first_chunk,
           (SELECT c.content FROM chunks c WHERE c.document_id = d.id ORDER BY c.ordinal LIMIT 1)
               AS intro,
           ARRAY(SELECT h FROM (SELECT c.heading AS h, min(c.ordinal) AS o FROM chunks c
                 WHERE c.document_id = d.id AND c.heading <> '' GROUP BY c.heading) x
                 ORDER BY o) AS headings
    FROM documents d
    WHERE d.collection_id = :cid AND d.status = 'ready'
    ORDER BY d.title
    LIMIT :n
    """
)


def overview(
    session: Session, collection_id: uuid.UUID, max_docs: int = 40
) -> tuple[list[Retrieved], int]:
    """One synthetic passage per document (title, section outline, opening text).

    Used for questions about the collection as a whole, which no single chunk
    answers. Returns the passages and the collection's total ready documents.
    """
    total = session.execute(
        text("SELECT count(*) FROM documents WHERE collection_id = :cid AND status = 'ready'"),
        {"cid": collection_id},
    ).scalar()
    passages = []
    for row in session.execute(_OVERVIEW_SQL, {"cid": collection_id, "n": max_docs}).all():
        if row.first_chunk is None:
            continue
        # Show each section path relative to the document title, at most 15 of them.
        sections = [h.split(" > ", 1)[-1] if " > " in h else h for h in row.headings][:15]
        outline = "\n".join(f"- {h}" for h in sections) or "- (no sections)"
        body = (
            f"File: {row.filename}\nSections:\n{outline}\n\nOpening text:\n"
            f"{(row.intro or '')[:600]}"
        )
        passages.append(
            Retrieved(
                row.first_chunk,
                row.id,
                row.title,
                row.filename,
                "Document overview",
                body,
                0,
                0.0,
                None,
                False,
            )
        )
    return passages, total or 0
