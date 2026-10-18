"""Passwords (Argon2id), access tokens (JWT), opaque refresh tokens, and the secrets vault."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from cryptography.fernet import Fernet, InvalidToken, MultiFernet

from ragdag.settings import get_settings

_hasher = PasswordHasher()
_JWT_ALG = "HS256"
_AUDIENCE = "ragdag-api"

# Verifying against this when the email is unknown keeps login timing uniform.
_DUMMY_HASH = _hasher.hash("timing-equaliser")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def create_access_token(user_id: uuid.UUID) -> tuple[str, int]:
    settings = get_settings()
    ttl = settings.access_token_minutes * 60
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "aud": _AUDIENCE,
        "iat": now,
        "exp": now + timedelta(seconds=ttl),
        "jti": secrets.token_hex(8),
    }
    token = jwt.encode(payload, settings.secret_key.get_secret_value(), algorithm=_JWT_ALG)
    return token, ttl


def decode_access_token(token: str) -> uuid.UUID | None:
    try:
        payload = jwt.decode(
            token,
            get_settings().secret_key.get_secret_value(),
            algorithms=[_JWT_ALG],
            audience=_AUDIENCE,
        )
        return uuid.UUID(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


def new_opaque_token() -> tuple[str, str]:
    """Return ``(token, sha256_hex)``. Only the hash is stored."""
    token = secrets.token_urlsafe(32)
    return token, hash_token(token)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# --------------------------------------------------------------------------- vault


class VaultError(RuntimeError):
    pass


def _vault() -> MultiFernet:
    raw = get_settings().vault_keys.get_secret_value()
    keys = [k.strip() for k in raw.split(",") if k.strip()]
    if not keys:
        raise VaultError("RAGDAG_VAULT_KEYS is not configured")
    return MultiFernet([Fernet(k.encode()) for k in keys])


def encrypt_secret(plaintext: str) -> str:
    return _vault().encrypt(plaintext.encode()).decode()


def decrypt_secret(ciphertext: str) -> str:
    try:
        return _vault().decrypt(ciphertext.encode()).decode()
    except InvalidToken as exc:
        raise VaultError("secret cannot be decrypted with the configured vault keys") from exc


def rotate_secret(ciphertext: str) -> str:
    """Re-encrypt under the first (newest) vault key."""
    return _vault().rotate(ciphertext.encode()).decode()


def secret_hint(plaintext: str) -> str:
    return f"…{plaintext[-4:]}" if len(plaintext) >= 8 else "…"
