"""Turn an uploaded or fetched file into markdown-ish text the chunker understands."""

from __future__ import annotations

import io
import re
from pathlib import Path

#: extension -> canonical MIME type. Anything else is rejected at upload time.
SUPPORTED_TYPES: dict[str, str] = {
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".pdf": "application/pdf",
    ".html": "text/html",
    ".htm": "text/html",
}

_BLANK_RUN = re.compile(r"\n{3,}")


class UnsupportedDocument(ValueError):
    pass


def mime_for(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_TYPES:
        allowed = ", ".join(sorted(SUPPORTED_TYPES))
        raise UnsupportedDocument(f"unsupported file type {suffix or '(none)'}; allowed: {allowed}")
    return SUPPORTED_TYPES[suffix]


def extract_text(data: bytes, mime_type: str) -> str:
    if mime_type == "application/pdf":
        return _pdf_to_markdown(data)
    if mime_type == "text/html":
        return html_to_markdown(data.decode("utf-8", errors="replace"))
    if mime_type in ("text/markdown", "text/plain"):
        return data.decode("utf-8", errors="replace")
    raise UnsupportedDocument(f"unsupported MIME type {mime_type}")


def _pdf_to_markdown(data: bytes) -> str:
    """One ``## Page N`` section per page, so PDF chunks cite a page."""
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    parts: list[str] = []
    # The embedded title becomes the document title and the root of every heading path.
    title = ((reader.metadata.title if reader.metadata else None) or "").strip()
    if title:
        parts.append(f"# {title}")
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            parts.append(f"## Page {number}\n\n{text}")
    return "\n\n".join(parts)


def html_to_markdown(html: str) -> str:
    """Keep headings, paragraphs, list items and code; drop chrome and scripts."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript", "nav", "footer", "header", "aside", "form"]):
        tag.decompose()
    root = soup.find("main") or soup.find("article") or soup.body or soup

    lines: list[str] = []
    title = soup.title.get_text(strip=True) if soup.title else ""
    if title:
        lines.append(f"# {title}")
    for el in root.find_all(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "pre", "td"]):
        if el.find_parent(["pre"]) is not None and el.name != "pre":
            continue
        if el.name == "pre":
            lines.append(f"```\n{el.get_text().rstrip()}\n```")
            continue
        text = " ".join(el.get_text(" ", strip=True).split())
        if not text:
            continue
        if el.name.startswith("h"):
            level = int(el.name[1])
            if level == 1 and title and text == title:
                continue
            lines.append(f"{'#' * level} {text}")
        elif el.name == "li":
            lines.append(f"- {text}")
        else:
            lines.append(text)
    return _BLANK_RUN.sub("\n\n", "\n\n".join(lines)).strip()


def title_from_text(text: str, fallback: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()[:500]
    return fallback[:500]
