"""Persist section provenance on extracted blocks, including tables."""

import sqlalchemy as sa
from alembic import op

revision = "0012_block_section_links"
down_revision = "0011_asset_section_links"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("document_blocks") as batch:
        batch.add_column(sa.Column("section_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_document_blocks_section_id_document_sections",
            "document_sections",
            ["section_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_document_blocks_section_id", ["section_id"])


def downgrade():
    with op.batch_alter_table("document_blocks") as batch:
        batch.drop_index("ix_document_blocks_section_id")
        batch.drop_constraint(
            "fk_document_blocks_section_id_document_sections", type_="foreignkey"
        )
        batch.drop_column("section_id")
