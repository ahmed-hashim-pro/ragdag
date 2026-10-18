"""Hybrid retrieval: pgvector cosine + Postgres full-text, fused by reciprocal rank fusion."""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from ragdag.ingest.embedder import embed_query

RRF_K = 60
CANDIDATES = 40

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


def retrieve(
    session: Session, collection_id: uuid.UUID, question: str, top_k: int
) -> RetrievalResult:
    vec = embed_query(question)
    vec_literal = "[" + ",".join(f"{x:.6f}" for x in vec) + "]"

    # pgvector >= 0.8: keep scanning the HNSW graph until enough rows pass the filter.
    session.execute(text("SET LOCAL hnsw.iterative_scan = relaxed_order"))
    session.execute(text("SET LOCAL hnsw.ef_search = 100"))
    dense = session.execute(
        _DENSE_SQL, {"vec": vec_literal, "cid": collection_id, "n": CANDIDATES}
    ).all()
    lexical = (
        session.execute(
            _LEXICAL_SQL, {"question": question, "cid": collection_id, "n": CANDIDATES}
        ).all()
        if _has_lexemes(session, question)
        else []
    )

    scores: dict[int, float] = {}
    sims: dict[int, float] = {}
    for rank, row in enumerate(dense):
        scores[row.id] = scores.get(row.id, 0.0) + 1.0 / (RRF_K + rank + 1)
        sims[row.id] = float(row.sim)
    lexical_ids = set()
    for rank, row in enumerate(lexical):
        scores[row.id] = scores.get(row.id, 0.0) + 1.0 / (RRF_K + rank + 1)
        lexical_ids.add(row.id)

    ranked = sorted(scores, key=scores.__getitem__, reverse=True)[:top_k]
    # Anchor each retriever's best hit: RRF can bury a strong exact-term match
    # (an error code, a part number) that only one retriever found.
    anchors = [r[0].id for r in (dense, lexical) if r]
    for anchor in anchors:
        if anchor in ranked:
            continue
        if len(ranked) < top_k:
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
    return RetrievalResult(
        chunks=chunks,
        best_similarity=max(sims.values(), default=0.0),
        lexical_hits=len(lexical),
    )
