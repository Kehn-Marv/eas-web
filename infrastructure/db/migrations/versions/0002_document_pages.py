"""Add page-level extraction and completeness reports."""

import sqlalchemy as sa
from alembic import op

revision = "0002_document_pages"
down_revision = "0001_phase2_core"
branch_labels = None
depends_on = None


def upgrade():
    for name, type_ in (
        ("pages_needing_fallback", sa.Integer()),
        ("text_char_count", sa.Integer()),
        ("tables_detected", sa.Integer()),
        ("figures_detected", sa.Integer()),
        ("formulas_detected", sa.Integer()),
        ("ocr_page_count", sa.Integer()),
    ):
        op.add_column("documents", sa.Column(name, type_, nullable=False, server_default="0"))
    op.add_column(
        "documents",
        sa.Column("completeness_status", sa.String(16), nullable=False, server_default="pending"),
    )
    op.create_table(
        "document_pages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("parser", sa.String(64), nullable=True),
        sa.Column("extracted_text", sa.Text(), nullable=False),
        sa.Column("text_hash", sa.String(64), nullable=True),
        sa.Column("char_count", sa.Integer(), nullable=False),
        sa.Column("word_count", sa.Integer(), nullable=False),
        sa.Column("block_count", sa.Integer(), nullable=False),
        sa.Column("quality_score", sa.Float(), nullable=False),
        sa.Column("fallback_required", sa.Boolean(), nullable=False),
        sa.Column("fallback_used", sa.Boolean(), nullable=False),
        sa.Column("is_ocr", sa.Boolean(), nullable=False),
        sa.Column("tables_detected", sa.Integer(), nullable=False),
        sa.Column("formulas_detected", sa.Integer(), nullable=False),
        sa.Column("warning", sa.JSON(), nullable=False),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("document_id", "page_number"),
    )
    op.create_index("ix_document_pages_document_id", "document_pages", ["document_id"])
    op.create_index("ix_document_pages_status", "document_pages", ["status"])
    op.create_table(
        "document_blocks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("block_index", sa.Integer(), nullable=False),
        sa.Column("source_type", sa.String(32), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("bbox", sa.JSON(), nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=False),
    )
    op.create_index("ix_document_blocks_document_id", "document_blocks", ["document_id"])
    op.create_index("ix_document_blocks_page_number", "document_blocks", ["page_number"])
    op.create_table(
        "document_assets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("page_number", sa.Integer(), nullable=False),
        sa.Column("asset_type", sa.String(32), nullable=False),
        sa.Column("object_key", sa.String(512), nullable=False, unique=True),
        sa.Column("media_type", sa.String(128), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
    )
    op.create_index("ix_document_assets_document_id", "document_assets", ["document_id"])
    op.create_index("ix_document_assets_page_number", "document_assets", ["page_number"])


def downgrade():
    op.drop_table("document_assets")
    op.drop_table("document_blocks")
    op.drop_table("document_pages")
    op.drop_column("documents", "completeness_status")
    for name in (
        "ocr_page_count",
        "formulas_detected",
        "figures_detected",
        "tables_detected",
        "text_char_count",
        "pages_needing_fallback",
    ):
        op.drop_column("documents", name)
