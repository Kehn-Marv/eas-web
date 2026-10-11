"""Persist heuristic sections and a traceable document tree."""

import sqlalchemy as sa
from alembic import op

revision = "0008_document_hierarchy"
down_revision = "0007_turns"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "document_sections",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            sa.Uuid(),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("section_key", sa.String(128), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("level", sa.Integer(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("start_page", sa.Integer(), nullable=False),
        sa.Column("end_page", sa.Integer(), nullable=False),
        sa.Column("detection_method", sa.String(32), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.UniqueConstraint("document_id", "section_key"),
    )
    op.create_index("ix_document_sections_document_id", "document_sections", ["document_id"])
    op.create_index("ix_document_sections_parent_id", "document_sections", ["parent_id"])
    with op.batch_alter_table("document_chunks") as batch:
        batch.add_column(sa.Column("section_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_document_chunks_section_id_document_sections",
            "document_sections",
            ["section_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_document_chunks_section_id", ["section_id"])
    op.create_table(
        "document_tree_nodes",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_id",
            sa.Uuid(),
            sa.ForeignKey("document_tree_nodes.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("node_key", sa.String(255), nullable=False),
        sa.Column("node_type", sa.String(16), nullable=False),
        sa.Column("label", sa.String(500), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("page_number", sa.Integer(), nullable=True),
        sa.Column(
            "section_id",
            sa.Uuid(),
            sa.ForeignKey("document_sections.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "block_id",
            sa.Uuid(),
            sa.ForeignKey("document_blocks.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "chunk_id",
            sa.Uuid(),
            sa.ForeignKey("document_chunks.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("content_hash", sa.String(64), nullable=True),
        sa.UniqueConstraint("document_id", "node_key"),
    )
    op.create_index("ix_document_tree_nodes_document_id", "document_tree_nodes", ["document_id"])
    op.create_index("ix_document_tree_nodes_parent_id", "document_tree_nodes", ["parent_id"])
    op.create_index("ix_document_tree_nodes_node_type", "document_tree_nodes", ["node_type"])
    op.create_index("ix_document_tree_nodes_section_id", "document_tree_nodes", ["section_id"])
    op.create_index("ix_document_tree_nodes_block_id", "document_tree_nodes", ["block_id"])
    op.create_index("ix_document_tree_nodes_chunk_id", "document_tree_nodes", ["chunk_id"])


def downgrade():
    op.drop_table("document_tree_nodes")
    with op.batch_alter_table("document_chunks") as batch:
        batch.drop_index("ix_document_chunks_section_id")
        batch.drop_constraint(
            "fk_document_chunks_section_id_document_sections", type_="foreignkey"
        )
        batch.drop_column("section_id")
    op.drop_index("ix_document_sections_parent_id", table_name="document_sections")
    op.drop_index("ix_document_sections_document_id", table_name="document_sections")
    op.drop_table("document_sections")
