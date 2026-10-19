"""Raise collections still on the old default similarity floor to the multilingual default.

The multilingual embedding model scores everything a little more similar than the
English-only one, so the old 0.25 default let off-topic questions through. Only
collections that kept the old default are changed; hand-tuned values are left alone.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-19
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE collections SET settings = jsonb_set(settings, '{similarity_floor}', '0.35') "
        "WHERE (settings->>'similarity_floor')::numeric = 0.25"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE collections SET settings = jsonb_set(settings, '{similarity_floor}', '0.25') "
        "WHERE (settings->>'similarity_floor')::numeric = 0.35"
    )
