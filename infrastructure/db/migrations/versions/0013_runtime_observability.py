"""Persist orchestration, learning signals, provider calls, jobs, and evaluations."""

import sqlalchemy as sa
from alembic import op

revision = "0013_runtime_observability"
down_revision = "0012_block_section_links"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "job_events",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "job_id", sa.Uuid(), sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("worker_id", sa.String(128), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("job_id", "sequence"),
    )
    op.create_index("ix_job_events_job_id", "job_events", ["job_id"])

    op.create_table(
        "agent_runs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "turn_id", sa.Uuid(), sa.ForeignKey("turns.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("trace_id", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("metadata_json", sa.JSON(), nullable=False),
    )
    op.create_index("ix_agent_runs_session_id", "agent_runs", ["session_id"])
    op.create_index("ix_agent_runs_turn_id", "agent_runs", ["turn_id"], unique=True)
    op.create_index("ix_agent_runs_trace_id", "agent_runs", ["trace_id"])

    op.create_table(
        "agent_steps",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "agent_run_id",
            sa.Uuid(),
            sa.ForeignKey("agent_runs.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("step_name", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("provider", sa.String(64), nullable=True),
        sa.Column("model", sa.String(128), nullable=True),
        sa.Column("latency_ms", sa.Float(), nullable=True),
        sa.Column("input_hash", sa.String(64), nullable=True),
        sa.Column("output_hash", sa.String(64), nullable=True),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("agent_run_id", "sequence"),
    )
    op.create_index("ix_agent_steps_agent_run_id", "agent_steps", ["agent_run_id"])

    op.create_table(
        "learning_signals",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Uuid(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "turn_id", sa.Uuid(), sa.ForeignKey("turns.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("concept_id", sa.String(255), nullable=True),
        sa.Column("signal_type", sa.String(64), nullable=False),
        sa.Column("strength", sa.Float(), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_learning_signals_session_id", "learning_signals", ["session_id"])
    op.create_index("ix_learning_signals_turn_id", "learning_signals", ["turn_id"])
    op.create_index("ix_learning_signals_concept_id", "learning_signals", ["concept_id"])
    op.create_index("ix_learning_signals_signal_type", "learning_signals", ["signal_type"])

    op.create_table(
        "provider_requests",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("trace_id", sa.String(64), nullable=False),
        sa.Column(
            "turn_id", sa.Uuid(), sa.ForeignKey("turns.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("model", sa.String(128), nullable=False),
        sa.Column("operation", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("latency_ms", sa.Float(), nullable=False),
        sa.Column("prompt_hash", sa.String(64), nullable=True),
        sa.Column("response_hash", sa.String(64), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_provider_requests_trace_id", "provider_requests", ["trace_id"])
    op.create_index("ix_provider_requests_turn_id", "provider_requests", ["turn_id"])
    op.create_index("ix_provider_requests_provider", "provider_requests", ["provider"])

    op.create_table(
        "evaluation_records",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("evaluation_set", sa.String(128), nullable=False),
        sa.Column("item_id", sa.String(128), nullable=False),
        sa.Column("metric", sa.String(64), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_evaluation_records_evaluation_set", "evaluation_records", ["evaluation_set"]
    )
    op.create_index("ix_evaluation_records_item_id", "evaluation_records", ["item_id"])
    op.create_index("ix_evaluation_records_metric", "evaluation_records", ["metric"])


def downgrade():
    op.drop_table("evaluation_records")
    op.drop_table("provider_requests")
    op.drop_table("learning_signals")
    op.drop_table("agent_steps")
    op.drop_table("agent_runs")
    op.drop_table("job_events")
