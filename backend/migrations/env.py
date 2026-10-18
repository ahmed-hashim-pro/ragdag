"""Alembic environment. Uses a connection passed in by the app, or the configured URL."""

from alembic import context
from sqlalchemy import create_engine

from ragdag.models import Base
from ragdag.settings import get_settings

config = context.config
target_metadata = Base.metadata


def run() -> None:
    connection = config.attributes.get("connection")
    if connection is not None:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = create_engine(get_settings().database_url)
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


run()
