"""Add traceable lexical retrieval chunks and retrieval audit events."""

import sqlalchemy as sa
from alembic import op

revision = "0003_retrieval_index"
down_revision = "0002_document_pages"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "documents",
        sa.Column("index_status", sa.String(16), nullable=False, server_default="pending"),
    )
    op.add_column(
        "documents",
        sa.Column("index_mode", sa.String(32), nullable=False, server_default="lexical_only"),
    )
    op.add_column(
        "documents",
        sa.Column("indexed_chunk_count", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "document_chunks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column(
            "block_id",
            sa.Uuid(),
            sa.ForeignKey("document_blocks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("chunk_key", sa.String(96), nullable=False),
        sa.Column("chunk_index", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        sa.Column("bbox", sa.JSON(), nullable=True),
        sa.UniqueConstraint("document_id", "chunk_key"),
    )
    op.create_index("ix_document_chunks_document_id", "document_chunks", ["document_id"])
    op.create_index("ix_document_chunks_page_number", "document_chunks", ["page_number"])
    op.create_index("ix_document_chunks_block_id", "document_chunks", ["block_id"])
    op.create_table(
        "retrieval_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("query_hash", sa.String(64), nullable=False),
        sa.Column("result_ids", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_retrieval_events_session_id", "retrieval_events", ["session_id"])


def downgrade():
    op.drop_table("retrieval_events")
    op.drop_index("ix_document_chunks_block_id", table_name="document_chunks")
    op.drop_index("ix_document_chunks_page_number", table_name="document_chunks")
    op.drop_index("ix_document_chunks_document_id", table_name="document_chunks")
    op.drop_table("document_chunks")
    op.drop_column("documents", "indexed_chunk_count")
    op.drop_column("documents", "index_mode")
    op.drop_column("documents", "index_status")
