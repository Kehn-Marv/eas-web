"""Persist understanding checks and lightweight per-concept learning state."""

import sqlalchemy as sa
from alembic import op

revision = "0006_learning_state_checks"
down_revision = "0005_postgres_full_text_index"
branch_labels = None
depends_on = None


def upgrade():
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("micro_checks") and inspector.has_table("learning_states"):
        return
    op.create_table(
        "micro_checks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("idempotency_key", sa.String(255), unique=True, nullable=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("concept_id", sa.String(255), nullable=False),
        sa.Column("check_type", sa.String(32), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("options", sa.JSON(), nullable=True),
        sa.Column("expected_answer", sa.JSON(), nullable=False),
        sa.Column("tolerance", sa.Float(), nullable=False),
        sa.Column("source_refs", sa.JSON(), nullable=False),
        sa.Column("representation_used", sa.String(64), nullable=False),
        sa.Column("learner_answer", sa.JSON(), nullable=True),
        sa.Column("correctness", sa.Boolean(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("time_to_answer_seconds", sa.Integer(), nullable=True),
        sa.Column("learning_signal", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_micro_checks_session_id", "micro_checks", ["session_id"])
    op.create_index("ix_micro_checks_concept_id", "micro_checks", ["concept_id"])
    op.create_table(
        "learning_states",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("concept_id", sa.String(255), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("correct_count", sa.Integer(), nullable=False),
        sa.Column("incorrect_count", sa.Integer(), nullable=False),
        sa.Column("confidence_history", sa.JSON(), nullable=False),
        sa.Column("representation_history", sa.JSON(), nullable=False),
        sa.Column("successful_representation", sa.String(64), nullable=True),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("recent_friction_score", sa.Float(), nullable=False),
        sa.UniqueConstraint("session_id", "concept_id"),
    )
    op.create_index("ix_learning_states_session_id", "learning_states", ["session_id"])


def downgrade():
    op.drop_table("learning_states")
    op.drop_index("ix_micro_checks_concept_id", table_name="micro_checks")
    op.drop_index("ix_micro_checks_session_id", table_name="micro_checks")
    op.drop_table("micro_checks")
