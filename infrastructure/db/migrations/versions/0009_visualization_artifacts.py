"""Persist validated visualization artifacts and learner interactions."""

import sqlalchemy as sa
from alembic import op

revision = "0009_visualization_artifacts"
down_revision = "0008_document_hierarchy"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "visualization_artifacts",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "turn_id",
            sa.Uuid(),
            sa.ForeignKey("turns.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "document_id",
            sa.Uuid(),
            sa.ForeignKey("documents.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("schema_version", sa.String(16), nullable=False),
        sa.Column("visual_type", sa.String(32), nullable=False),
        sa.Column("spec", sa.JSON(), nullable=False),
        sa.Column("source_refs", sa.JSON(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_visualization_artifacts_session_id", "visualization_artifacts", ["session_id"]
    )
    op.create_index("ix_visualization_artifacts_turn_id", "visualization_artifacts", ["turn_id"])
    op.create_index(
        "ix_visualization_artifacts_document_id", "visualization_artifacts", ["document_id"]
    )
    op.create_table(
        "interaction_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "artifact_id",
            sa.Uuid(),
            sa.ForeignKey("visualization_artifacts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("interaction_id", sa.String(64), nullable=False),
        sa.Column("target_id", sa.String(64), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("state_key", sa.String(64), nullable=True),
        sa.Column("value", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=True),
        sa.UniqueConstraint("artifact_id", "session_id", "idempotency_key"),
    )
    op.create_index("ix_interaction_events_artifact_id", "interaction_events", ["artifact_id"])
    op.create_index("ix_interaction_events_session_id", "interaction_events", ["session_id"])


def downgrade():
    op.drop_table("interaction_events")
    op.drop_table("visualization_artifacts")
