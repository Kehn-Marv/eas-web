"""Persist idempotent learner turns and grounded response material."""

import sqlalchemy as sa
from alembic import op

revision = "0007_turns"
down_revision = "0006_learning_state_checks"
branch_labels = None
depends_on = None


def upgrade():
    if sa.inspect(op.get_bind()).has_table("turns"):
        return
    op.create_table(
        "turns",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.String(255), nullable=False, unique=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("trace_id", sa.String(64), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("response_text", sa.Text(), nullable=False),
        sa.Column("citations", sa.JSON(), nullable=False),
        sa.Column("learning_state", sa.JSON(), nullable=True),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("warnings", sa.JSON(), nullable=False),
        sa.Column("suggested_actions", sa.JSON(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_turns_session_id", "turns", ["session_id"])


def downgrade():
    op.drop_index("ix_turns_session_id", table_name="turns")
    op.drop_table("turns")
