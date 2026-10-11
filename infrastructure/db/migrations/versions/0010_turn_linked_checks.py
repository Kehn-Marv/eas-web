"""Link automatically planned checks to the turn that produced them."""

import sqlalchemy as sa
from alembic import op

revision = "0010_turn_linked_checks"
down_revision = "0009_visualization_artifacts"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("micro_checks") as batch:
        batch.add_column(sa.Column("turn_id", sa.Uuid(), nullable=True))
        batch.create_foreign_key(
            "fk_micro_checks_turn_id_turns",
            "turns",
            ["turn_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch.create_index("ix_micro_checks_turn_id", ["turn_id"])


def downgrade():
    with op.batch_alter_table("micro_checks") as batch:
        batch.drop_index("ix_micro_checks_turn_id")
        batch.drop_constraint("fk_micro_checks_turn_id_turns", type_="foreignkey")
        batch.drop_column("turn_id")
