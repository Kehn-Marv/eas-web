"""Link figure assets into document sections and the hierarchy tree."""

import sqlalchemy as sa
from alembic import op

revision = "0011_asset_section_links"
down_revision = "0010_turn_linked_checks"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("document_assets") as batch:
        batch.add_column(sa.Column("section_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_document_assets_section_id_document_sections",
            "document_sections",
            ["section_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_document_assets_section_id", ["section_id"])
    with op.batch_alter_table("document_tree_nodes") as batch:
        batch.add_column(sa.Column("asset_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_document_tree_nodes_asset_id_document_assets",
            "document_assets",
            ["asset_id"],
            ["id"],
            ondelete="CASCADE",
        )
        batch.create_index("ix_document_tree_nodes_asset_id", ["asset_id"])


def downgrade():
    with op.batch_alter_table("document_tree_nodes") as batch:
        batch.drop_index("ix_document_tree_nodes_asset_id")
        batch.drop_constraint("fk_document_tree_nodes_asset_id_document_assets", type_="foreignkey")
        batch.drop_column("asset_id")
    with op.batch_alter_table("document_assets") as batch:
        batch.drop_index("ix_document_assets_section_id")
        batch.drop_constraint("fk_document_assets_section_id_document_sections", type_="foreignkey")
        batch.drop_column("section_id")
