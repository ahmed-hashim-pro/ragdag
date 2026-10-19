"""Index chunk text under both the English and the Arabic full-text configurations.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-19
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

BILINGUAL = (
    "setweight(to_tsvector('english', coalesce(heading, '')), 'A') || "
    "setweight(to_tsvector('arabic', coalesce(heading, '')), 'A') || "
    "setweight(to_tsvector('english', content), 'B') || "
    "setweight(to_tsvector('arabic', content), 'B')"
)
ENGLISH = (
    "setweight(to_tsvector('english', coalesce(heading, '')), 'A') || "
    "setweight(to_tsvector('english', content), 'B')"
)


def upgrade() -> None:
    # Postgres 17: rewrites the column (and its GIN index) in place.
    op.execute(f"ALTER TABLE chunks ALTER COLUMN tsv SET EXPRESSION AS ({BILINGUAL})")


def downgrade() -> None:
    op.execute(f"ALTER TABLE chunks ALTER COLUMN tsv SET EXPRESSION AS ({ENGLISH})")
