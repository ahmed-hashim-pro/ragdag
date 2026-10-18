"""Per-collection tunables, stored as JSON on ``collections.settings``."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CollectionSettings(BaseModel):
    model_config = ConfigDict(extra="ignore")

    chunk_tokens: int = Field(400, ge=100, le=2000)
    chunk_overlap: int = Field(60, ge=0, le=500)
    top_k: int = Field(8, ge=1, le=30)
    # Below this best dense cosine similarity the question is refused without an API call.
    similarity_floor: float = Field(0.25, ge=0.0, le=1.0)
    effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"

    @model_validator(mode="after")
    def _overlap_smaller(self) -> CollectionSettings:
        if self.chunk_overlap >= self.chunk_tokens:
            raise ValueError("chunk_overlap must be smaller than chunk_tokens")
        return self

    @classmethod
    def of(cls, raw: dict[str, Any] | None) -> CollectionSettings:
        return cls.model_validate(raw or {})

    def changes_chunking(self, other: CollectionSettings) -> bool:
        return (self.chunk_tokens, self.chunk_overlap) != (other.chunk_tokens, other.chunk_overlap)
