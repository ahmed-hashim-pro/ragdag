"""Runtime configuration, read from the environment (``RAGDAG_*``) once per process."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# The vector column is fixed at this size: any embedding model must produce it.
EMBED_DIM = 384


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RAGDAG_", env_file=".env", extra="ignore")

    env: str = "production"  # production | development | test
    database_url: str = "postgresql+psycopg://ragdag:ragdag@localhost:5432/ragdag"

    # Signing key for JWTs, and Fernet keys for the secrets vault. VAULT_KEYS is a
    # comma-separated list: the first key encrypts, all keys decrypt (rotation).
    secret_key: SecretStr = SecretStr("dev-insecure-secret-change-me")
    vault_keys: SecretStr = SecretStr("")

    public_url: str = "https://localhost:8443"
    allow_signup: bool = False  # the first user may always sign up; later ones need an invite
    access_token_minutes: int = 15
    refresh_token_days: int = 14

    data_dir: Path = Path("/data")
    max_upload_mb: int = 50
    embed_cache_dir: Path | None = None
    # Changing the embedding model requires re-indexing every collection (`make reindex-all`).
    embed_model: str = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

    airflow_url: str = "http://airflow-apiserver:8080"
    airflow_username: str = "ragdag-service"
    airflow_password: SecretStr = SecretStr("")

    claude_model: str = "claude-opus-5-5"
    claude_max_tokens: int = 16000
    # USD per million tokens, used for the cost shown per answer and in usage.
    # Defaults are Claude Opus 5.5 list prices; change them with the model.
    price_input_per_mtok: float = 4.0
    price_output_per_mtok: float = 20.0
    price_cache_write_per_mtok: float = 5.0
    price_cache_read_per_mtok: float = 0.20
    # Query planning (rewrite + intent) runs on a small model at low effort.
    planner_model: str = "claude-haiku-5-5"
    planner_price_input_per_mtok: float = 0.10
    planner_price_output_per_mtok: float = 0.50
    # Multilingual cross-encoder (Apache-2.0). It is CPU-heavy: latency grows with the pool
    # size and passage length, so only the top candidates are re-scored, trimmed.
    reranker_model: str = "BAAI/bge-reranker-v2-m3-int8"
    rerank_pool: int = 12
    rerank_max_chars: int = 800
    login_rate_per_minute: int = 10
    ask_rate_per_minute: int = 30

    cors_origins: list[str] = Field(default_factory=list)

    def cost_usd(self, usage: dict) -> float:
        """Estimated cost of one request from its token counts."""
        per = 1_000_000
        return round(
            usage.get("input_tokens", 0) * self.price_input_per_mtok / per
            + usage.get("output_tokens", 0) * self.price_output_per_mtok / per
            + usage.get("cache_creation_input_tokens", 0) * self.price_cache_write_per_mtok / per
            + usage.get("cache_read_input_tokens", 0) * self.price_cache_read_per_mtok / per,
            6,
        )

    def planner_cost_usd(self, input_tokens: int, output_tokens: int) -> float:
        return round(
            (
                input_tokens * self.planner_price_input_per_mtok
                + output_tokens * self.planner_price_output_per_mtok
            )
            / 1_000_000,
            6,
        )

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def staging_dir(self) -> Path:
        return self.data_dir / "staging"

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
