"""Add a PostgreSQL GIN index for simple-config full-text retrieval."""

import sqlalchemy as sa
from alembic import op

revision = "0005_postgres_full_text_index"
down_revision = "0004_dense_embeddings"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.create_index(
            "ix_document_chunks_content_fts",
            "document_chunks",
            [sa.text("to_tsvector('simple', content)")],
            postgresql_using="gin",
        )


def downgrade():
    if op.get_bind().dialect.name == "postgresql":
        op.drop_index("ix_document_chunks_content_fts", table_name="document_chunks")
