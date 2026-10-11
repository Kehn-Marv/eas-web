"""Persist courses, lessons, sharing, and resume state."""

import sqlalchemy as sa
from alembic import op

revision = "0015_persistent_courses"
down_revision = "0014_shared_rate_limits"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "courses",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("source_document_ids", sa.JSON(), nullable=False),
        sa.Column("source_titles", sa.JSON(), nullable=False),
        sa.Column("is_public", sa.Boolean(), nullable=False),
        sa.Column("share_token", sa.String(96), nullable=True),
        sa.Column("current_module_index", sa.Integer(), nullable=False),
        sa.Column("current_lesson_index", sa.Integer(), nullable=False),
        sa.Column("current_step", sa.String(32), nullable=False),
        sa.Column("completed_lesson_ids", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("share_token"),
    )
    op.create_index("ix_courses_session_id", "courses", ["session_id"])
    op.create_index("ix_courses_is_public", "courses", ["is_public"])

    op.create_table(
        "course_modules",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("source_refs", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["course_id"], ["courses.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("course_id", "position"),
    )
    op.create_index("ix_course_modules_course_id", "course_modules", ["course_id"])

    op.create_table(
        "course_lessons",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("module_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("lesson", sa.JSON(), nullable=False),
        sa.Column("source_refs", sa.JSON(), nullable=False),
        sa.Column("check_type", sa.String(32), nullable=False),
        sa.Column("expected_answer", sa.JSON(), nullable=False),
        sa.ForeignKeyConstraint(["module_id"], ["course_modules.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("module_id", "position"),
    )
    op.create_index("ix_course_lessons_module_id", "course_lessons", ["module_id"])

    op.create_table(
        "course_lesson_progress",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("course_lesson_id", sa.Uuid(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False),
        sa.Column("correct_count", sa.Integer(), nullable=False),
        sa.Column("last_correct", sa.Boolean(), nullable=True),
        sa.Column("last_answer", sa.JSON(), nullable=True),
        sa.Column("answered_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["course_lesson_id"], ["course_lessons.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("course_lesson_id"),
    )
    op.create_index(
        "ix_course_lesson_progress_course_lesson_id",
        "course_lesson_progress",
        ["course_lesson_id"],
    )


def downgrade():
    op.drop_index(
        "ix_course_lesson_progress_course_lesson_id", table_name="course_lesson_progress"
    )
    op.drop_table("course_lesson_progress")
    op.drop_index("ix_course_lessons_module_id", table_name="course_lessons")
    op.drop_table("course_lessons")
    op.drop_index("ix_course_modules_course_id", table_name="course_modules")
    op.drop_table("course_modules")
    op.drop_index("ix_courses_is_public", table_name="courses")
    op.drop_index("ix_courses_session_id", table_name="courses")
    op.drop_table("courses")
