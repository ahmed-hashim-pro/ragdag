"""Retrieval evaluation: does search put the passage that answers each question in front of Claude?

Indexes a corpus into a throwaway workspace (the same pipeline steps the ingest DAG
runs, without Airflow), runs every case through retrieval, reports per-group
metrics, and deletes the workspace again. Free and deterministic: no Claude calls.

    python -m ragdag.evals --corpus ../evals/corpus --cases ../evals/retrieval_cases.json
    python -m ragdag.evals ... --no-rerank --json results.json

Metrics per group: hit@1, hit@3, hit@k (k = what Claude is given), MRR, and the
share of lookups that clear the confidence gate. Off-topic cases report the share
that is correctly refused.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path

from sqlalchemy import delete

from ragdag.collection_settings import CollectionSettings
from ragdag.db import session_scope
from ragdag.ingest import pipeline
from ragdag.ingest.extract import mime_for
from ragdag.models import Collection, Document, Workspace
from ragdag.retrieval import retrieve
from ragdag.settings import get_settings
from ragdag.storage import delete_workspace_files, store_bytes


@dataclass
class CaseResult:
    id: str
    group: str
    question: str
    rank: int | None  # 1-based rank of the expected passage, None if not retrieved
    confident: bool
    top: list[str]  # "file › heading" of the first three results


@dataclass
class GroupMetrics:
    group: str
    cases: int
    hit_at_1: float = 0.0
    hit_at_3: float = 0.0
    hit_at_k: float = 0.0
    mrr: float = 0.0
    gate_pass: float = 0.0  # lookups: answered (not refused); offtopic: correctly refused


@dataclass
class EvalReport:
    embed_model: str
    rerank: bool
    top_k: int
    seconds: float
    groups: list[GroupMetrics]
    results: list[CaseResult] = field(default_factory=list)

    def group(self, name: str) -> GroupMetrics:
        return next(g for g in self.groups if g.group == name)


def _index_corpus(corpus: Path) -> tuple[uuid.UUID, uuid.UUID, dict[uuid.UUID, str]]:
    tag = uuid.uuid4().hex[:8]
    with session_scope() as s:
        ws = Workspace(name=f"eval-{tag}", slug=f"eval-{tag}")
        s.add(ws)
        s.flush()
        coll = Collection(
            workspace_id=ws.id, name="eval", settings=CollectionSettings().model_dump()
        )
        s.add(coll)
        s.flush()
        ws_id, coll_id = ws.id, coll.id

    files: dict[uuid.UUID, str] = {}
    for path in sorted(p for p in corpus.iterdir() if p.is_file()):
        data = path.read_bytes()
        doc_id = uuid.uuid4()
        stored, sha = store_bytes(ws_id, doc_id, data, path.suffix)
        with session_scope() as s:
            s.add(
                Document(
                    id=doc_id,
                    workspace_id=ws_id,
                    collection_id=coll_id,
                    title=path.name,
                    filename=path.name,
                    mime_type=mime_for(path.name),
                    size_bytes=len(data),
                    sha256=sha,
                    storage_path=str(stored),
                )
            )
        info = pipeline.prepare(str(doc_id), sha)
        info = pipeline.chunk(pipeline.extract(info))
        pipeline.embed_and_index(info)
        pipeline.finalize(info)
        files[doc_id] = path.name
    return ws_id, coll_id, files


def _metrics(group: str, results: list[CaseResult], top_k: int) -> GroupMetrics:
    m = GroupMetrics(group=group, cases=len(results))
    if not results:
        return m
    n = len(results)
    if group == "offtopic":
        m.gate_pass = sum(not r.confident for r in results) / n
        return m
    m.hit_at_1 = sum(r.rank == 1 for r in results) / n
    m.hit_at_3 = sum(r.rank is not None and r.rank <= 3 for r in results) / n
    m.hit_at_k = sum(r.rank is not None and r.rank <= top_k for r in results) / n
    m.mrr = sum(1 / r.rank for r in results if r.rank) / n
    m.gate_pass = sum(r.confident for r in results) / n
    return m


def run(
    corpus: Path, cases_path: Path, rerank: bool = True, top_k: int | None = None
) -> EvalReport:
    settings = CollectionSettings()
    top_k = top_k or settings.top_k
    cases = json.loads(cases_path.read_text(encoding="utf-8"))["cases"]
    started = time.monotonic()
    ws_id, coll_id, files = _index_corpus(corpus)
    results: list[CaseResult] = []
    try:
        for case in cases:
            with session_scope() as s:
                res = retrieve(s, coll_id, case["q"], top_k, rerank=rerank)
            labels = [(files.get(c.document_id, "?"), c.heading) for c in res.chunks]
            rank = None
            if case["group"] != "offtopic":
                rank = next(
                    (
                        i
                        for i, (f, h) in enumerate(labels, start=1)
                        if f == case["file"] and case["heading"].lower() in h.lower()
                    ),
                    None,
                )
            results.append(
                CaseResult(
                    id=case["id"],
                    group=case["group"],
                    question=case["q"],
                    rank=rank,
                    confident=res.is_confident(settings.similarity_floor),
                    top=[f"{f} › {h.split(' > ')[-1]}" for f, h in labels[:3]],
                )
            )
    finally:
        with session_scope() as s:
            s.execute(delete(Workspace).where(Workspace.id == ws_id))
        delete_workspace_files(ws_id)

    groups = list(dict.fromkeys(c["group"] for c in cases))
    return EvalReport(
        embed_model=get_settings().embed_model,
        rerank=rerank,
        top_k=top_k,
        seconds=round(time.monotonic() - started, 1),
        groups=[_metrics(g, [r for r in results if r.group == g], top_k) for g in groups],
        results=results,
    )


def format_report(report: EvalReport) -> str:
    lines = [
        f"embed model: {report.embed_model} | rerank: {report.rerank} | top_k: {report.top_k} "
        f"| {report.seconds}s",
        "",
        f"{'group':<10} {'cases':>5} {'hit@1':>6} {'hit@3':>6} {'hit@k':>6} {'MRR':>5} {'gate':>5}",
    ]
    for g in report.groups:
        if g.group == "offtopic":
            lines.append(
                f"{g.group:<10} {g.cases:>5} {'':>6} {'':>6} {'':>6} {'':>5} "
                f"{g.gate_pass:>5.0%}   (refused)"
            )
        else:
            lines.append(
                f"{g.group:<10} {g.cases:>5} {g.hit_at_1:>6.0%} {g.hit_at_3:>6.0%} "
                f"{g.hit_at_k:>6.0%} {g.mrr:>5.2f} {g.gate_pass:>5.0%}"
            )
    misses = [
        r
        for r in report.results
        if (r.group == "offtopic" and r.confident)
        or (r.group != "offtopic" and (r.rank is None or r.rank > 3 or not r.confident))
    ]
    if misses:
        lines += ["", "weak cases:"]
        for r in misses:
            what = (
                "answered off-topic"
                if r.group == "offtopic"
                else (f"rank {r.rank or '-'}" + ("" if r.confident else ", refused"))
            )
            lines.append(f"  {r.id:<18} {what:<20} {r.question}")
            lines.append(f"  {'':<18} top: {' | '.join(r.top)}")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--cases", type=Path, required=True)
    parser.add_argument("--no-rerank", action="store_true")
    parser.add_argument("--top-k", type=int)
    parser.add_argument("--json", type=Path, help="write the full report here")
    args = parser.parse_args(argv)
    report = run(args.corpus, args.cases, rerank=not args.no_rerank, top_k=args.top_k)
    print(format_report(report))
    if args.json:
        args.json.write_text(json.dumps(asdict(report), indent=1, ensure_ascii=False), "utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
