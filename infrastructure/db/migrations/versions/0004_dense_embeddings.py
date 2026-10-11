"""Add pgvector embeddings while keeping SQLite development support."""

import sqlalchemy as sa
from alembic import op

revision = "0004_dense_embeddings"
down_revision = "0003_retrieval_index"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if inspector.has_table("document_embeddings"):
        return
    if bind.dialect.name == "postgresql":
        from pgvector.sqlalchemy import Vector

        op.execute("CREATE EXTENSION IF NOT EXISTS vector")
        vector_type = Vector(384)
    else:
        vector_type = sa.JSON()
    op.create_table(
        "document_embeddings",
        sa.Column(
            "chunk_id",
            sa.Uuid(),
            sa.ForeignKey("document_chunks.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("dimensions", sa.Integer(), nullable=False),
        sa.Column("embedding", vector_type, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_document_embeddings_document_id", "document_embeddings", ["document_id"])


def downgrade():
    op.drop_index("ix_document_embeddings_document_id", table_name="document_embeddings")
    op.drop_table("document_embeddings")
