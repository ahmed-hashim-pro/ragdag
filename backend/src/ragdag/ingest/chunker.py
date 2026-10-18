"""Markdown-aware chunking, ported from rag-knowledge-agent.

Sections never bleed into each other: a chunk belongs to exactly one heading path,
which keeps citations precise. Within a section, paragraphs are packed greedily and
consecutive chunks overlap so a fact split across a boundary is retrievable from
either side. Fenced code blocks are never split on blank lines or headings.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")

HEADING_SEPARATOR = " > "


def estimate_tokens(text: str) -> int:
    """Cheap offline token estimate (~4 chars/token), used only for sizing."""
    return max(1, (len(text) + 3) // 4)


@dataclass(frozen=True)
class Chunk:
    text: str
    heading: str
    index: int

    @property
    def tokens(self) -> int:
        return estimate_tokens(self.text)


def _iter_sections(text: str) -> Iterator[tuple[str, str]]:
    stack: list[tuple[int, str]] = []
    body: list[str] = []
    in_fence = False
    fence_marker = ""

    def heading_path() -> str:
        return HEADING_SEPARATOR.join(title for _, title in stack)

    for line in text.splitlines():
        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            if not in_fence:
                in_fence, fence_marker = True, marker
            elif marker == fence_marker:
                in_fence, fence_marker = False, ""
            body.append(line)
            continue

        match = None if in_fence else _HEADING_RE.match(line)
        if match is None:
            body.append(line)
            continue

        chunk_body = "\n".join(body).strip()
        if chunk_body:
            yield heading_path(), chunk_body
        body = []

        level = len(match.group(1))
        while stack and stack[-1][0] >= level:
            stack.pop()
        stack.append((level, match.group(2).strip()))

    tail = "\n".join(body).strip()
    if tail:
        yield heading_path(), tail


def _iter_paragraphs(body: str) -> Iterator[str]:
    current: list[str] = []
    in_fence = False
    fence_marker = ""

    for line in body.splitlines():
        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            if not in_fence:
                in_fence, fence_marker = True, marker
            elif marker == fence_marker:
                in_fence, fence_marker = False, ""
            current.append(line)
            continue
        if not line.strip() and not in_fence:
            block = "\n".join(current).strip()
            if block:
                yield block
            current = []
            continue
        current.append(line)

    block = "\n".join(current).strip()
    if block:
        yield block


def _split_oversized(paragraph: str, max_tokens: int) -> list[str]:
    if estimate_tokens(paragraph) <= max_tokens:
        return [paragraph]

    pieces: list[str] = []
    buffer = ""
    for sentence in _SENTENCE_END_RE.split(paragraph):
        candidate = f"{buffer} {sentence}".strip() if buffer else sentence
        if buffer and estimate_tokens(candidate) > max_tokens:
            pieces.append(buffer)
            buffer = sentence
        else:
            buffer = candidate
    if buffer:
        pieces.append(buffer)

    # A single sentence can still exceed the budget (tables, minified blobs).
    limit = max_tokens * 4
    hard_split: list[str] = []
    for piece in pieces:
        while len(piece) > limit:
            hard_split.append(piece[:limit])
            piece = piece[limit:]
        if piece:
            hard_split.append(piece)
    return hard_split


def _overlap_tail(paragraphs: Sequence[str], overlap_tokens: int) -> list[str]:
    if overlap_tokens <= 0 or not paragraphs:
        return []
    tail: list[str] = []
    budget = overlap_tokens
    for paragraph in reversed(paragraphs):
        cost = estimate_tokens(paragraph)
        if cost > budget:
            if not tail:
                snippet = paragraph[-overlap_tokens * 4 :]
                _, _, remainder = snippet.partition(" ")
                tail.append(remainder or snippet)
            break
        tail.append(paragraph)
        budget -= cost
    tail.reverse()
    return tail


def chunk_markdown(text: str, chunk_tokens: int, overlap_tokens: int) -> list[Chunk]:
    if chunk_tokens <= 0:
        raise ValueError("chunk_tokens must be positive")
    if overlap_tokens >= chunk_tokens:
        raise ValueError("overlap_tokens must be smaller than chunk_tokens")

    chunks: list[Chunk] = []
    for heading, body in _iter_sections(text):
        chunks.extend(_pack_section(heading, body, chunk_tokens, overlap_tokens, len(chunks)))
    return chunks


def _pack_section(
    heading: str, body: str, chunk_tokens: int, overlap_tokens: int, start_index: int
) -> list[Chunk]:
    chunks: list[Chunk] = []
    index = start_index
    buffer: list[str] = []
    buffer_tokens = 0

    def flush(carry: bool) -> None:
        nonlocal buffer, buffer_tokens, index
        if not buffer:
            return
        joined = "\n\n".join(buffer).strip()
        if joined:
            chunks.append(Chunk(text=joined, heading=heading, index=index))
            index += 1
        buffer = list(_overlap_tail(buffer, overlap_tokens)) if carry else []
        buffer_tokens = sum(estimate_tokens(part) for part in buffer)

    for paragraph in _iter_paragraphs(body):
        for piece in _split_oversized(paragraph, chunk_tokens):
            cost = estimate_tokens(piece)
            if buffer and buffer_tokens + cost > chunk_tokens:
                flush(carry=True)
            buffer.append(piece)
            buffer_tokens += cost

    flush(carry=False)
    return chunks
