from datetime import UTC, datetime
from enum import StrEnum
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    TypeDecorator,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from packages.shared.db import Base


class EmbeddingVector(TypeDecorator):
    """JSON in SQLite development; a fixed-dimension pgvector column in PostgreSQL."""

    impl = JSON
    cache_ok = True
    from pgvector.sqlalchemy import Vector as _Vector

    comparator_factory = _Vector.comparator_factory

    def __init__(self, dimensions: int = 384):
        super().__init__()
        self.dimensions = dimensions

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            from pgvector.sqlalchemy import Vector

            return dialect.type_descriptor(Vector(self.dimensions))
        return dialect.type_descriptor(JSON())


def utcnow() -> datetime:
    return datetime.now(UTC)


class DocumentStatus(StrEnum):
    UPLOADING = "UPLOADING"
    VALIDATING = "VALIDATING"
    STORING = "STORING"
    PREFLIGHT = "PREFLIGHT"
    PARSING = "PARSING"
    OCR_FALLBACK = "OCR_FALLBACK"
    EXTRACTING_ASSETS = "EXTRACTING_ASSETS"
    BUILDING_STRUCTURE = "BUILDING_STRUCTURE"
    BUILDING_INDEX = "BUILDING_INDEX"
    VALIDATING_COVERAGE = "VALIDATING_COVERAGE"
    READY = "READY"
    DEGRADED = "DEGRADED"
    FAILED = "FAILED"


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    RETRYABLE = "retryable"
    CANCELLED = "cancelled"


class PageStatus(StrEnum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    READY = "READY"
    DEGRADED = "DEGRADED"
    FAILED = "FAILED"


class LearningSession(Base):
    __tablename__ = "sessions"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_active_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    learning_mode: Mapped[str] = mapped_column(String(16), default="ADAPTIVE")


class Course(Base):
    """Persistent, session-owned learning path and its public share handle."""

    __tablename__ = "courses"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(500))
    source_document_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    source_titles: Mapped[list[str]] = mapped_column(JSON, default=list)
    is_public: Mapped[bool] = mapped_column(default=False, index=True)
    share_token: Mapped[str | None] = mapped_column(String(96), unique=True, nullable=True)
    current_module_index: Mapped[int] = mapped_column(Integer, default=0)
    current_lesson_index: Mapped[int] = mapped_column(Integer, default=0)
    current_step: Mapped[str] = mapped_column(String(32), default="overview")
    completed_lesson_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class CourseModule(Base):
    __tablename__ = "course_modules"
    __table_args__ = (UniqueConstraint("course_id", "position"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    course_id: Mapped[UUID] = mapped_column(
        ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(500))
    source_refs: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)


class CourseLesson(Base):
    __tablename__ = "course_lessons"
    __table_args__ = (UniqueConstraint("module_id", "position"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    module_id: Mapped[UUID] = mapped_column(
        ForeignKey("course_modules.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(500))
    lesson: Mapped[dict[str, object]] = mapped_column(JSON)
    source_refs: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    check_type: Mapped[str] = mapped_column(String(32))
    expected_answer: Mapped[object] = mapped_column(JSON)


class CourseLessonProgress(Base):
    __tablename__ = "course_lesson_progress"
    __table_args__ = (UniqueConstraint("course_lesson_id"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    course_lesson_id: Mapped[UUID] = mapped_column(
        ForeignKey("course_lessons.id", ondelete="CASCADE"), index=True
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    correct_count: Mapped[int] = mapped_column(Integer, default=0)
    last_correct: Mapped[bool | None] = mapped_column(nullable=True)
    last_answer: Mapped[object | None] = mapped_column(JSON, nullable=True)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        UniqueConstraint("session_id", "content_hash", name="uq_document_session_hash"),
    )

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    media_type: Mapped[str] = mapped_column(String(128))
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    object_key: Mapped[str] = mapped_column(String(512), unique=True)
    byte_size: Mapped[int] = mapped_column(Integer)
    status: Mapped[DocumentStatus] = mapped_column(
        Enum(DocumentStatus, native_enum=False, length=32), default=DocumentStatus.VALIDATING
    )
    expected_page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    processed_page_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_page_count: Mapped[int] = mapped_column(Integer, default=0)
    pages_needing_fallback: Mapped[int] = mapped_column(Integer, default=0)
    text_char_count: Mapped[int] = mapped_column(Integer, default=0)
    tables_detected: Mapped[int] = mapped_column(Integer, default=0)
    figures_detected: Mapped[int] = mapped_column(Integer, default=0)
    formulas_detected: Mapped[int] = mapped_column(Integer, default=0)
    ocr_page_count: Mapped[int] = mapped_column(Integer, default=0)
    completeness_status: Mapped[str] = mapped_column(String(16), default="pending")
    index_status: Mapped[str] = mapped_column(String(16), default="pending")
    index_mode: Mapped[str] = mapped_column(String(32), default="lexical_only")
    indexed_chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    warnings: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    job_type: Mapped[str] = mapped_column(String(100), index=True)
    payload: Mapped[dict[str, object]] = mapped_column(JSON)
    idempotency_key: Mapped[str] = mapped_column(String(255), unique=True)
    status: Mapped[JobStatus] = mapped_column(
        Enum(JobStatus, native_enum=False, length=16), default=JobStatus.QUEUED, index=True
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class JobEvent(Base):
    __tablename__ = "job_events"
    __table_args__ = (UniqueConstraint("job_id", "sequence"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    job_id: Mapped[UUID] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    sequence: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(16))
    worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DocumentPage(Base):
    __tablename__ = "document_pages"
    __table_args__ = (UniqueConstraint("document_id", "page_number"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    page_number: Mapped[int] = mapped_column(Integer)
    status: Mapped[PageStatus] = mapped_column(
        Enum(PageStatus, native_enum=False, length=16), default=PageStatus.PENDING, index=True
    )
    parser: Mapped[str | None] = mapped_column(String(64), nullable=True)
    extracted_text: Mapped[str] = mapped_column(Text, default="")
    text_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    char_count: Mapped[int] = mapped_column(Integer, default=0)
    word_count: Mapped[int] = mapped_column(Integer, default=0)
    block_count: Mapped[int] = mapped_column(Integer, default=0)
    quality_score: Mapped[float] = mapped_column(Float, default=0.0)
    fallback_required: Mapped[bool] = mapped_column(default=False)
    fallback_used: Mapped[bool] = mapped_column(default=False)
    is_ocr: Mapped[bool] = mapped_column(default=False)
    tables_detected: Mapped[int] = mapped_column(Integer, default=0)
    formulas_detected: Mapped[int] = mapped_column(Integer, default=0)
    warning: Mapped[list[str]] = mapped_column(JSON, default=list)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DocumentBlock(Base):
    __tablename__ = "document_blocks"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    page_number: Mapped[int] = mapped_column(Integer, index=True)
    section_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_sections.id", ondelete="SET NULL"), index=True, nullable=True
    )
    block_index: Mapped[int] = mapped_column(Integer)
    source_type: Mapped[str] = mapped_column(String(32), default="paragraph")
    text: Mapped[str] = mapped_column(Text)
    bbox: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64))


class DocumentAsset(Base):
    __tablename__ = "document_assets"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    page_number: Mapped[int] = mapped_column(Integer, index=True)
    section_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_sections.id", ondelete="SET NULL"), index=True, nullable=True
    )
    asset_type: Mapped[str] = mapped_column(String(32))
    object_key: Mapped[str] = mapped_column(String(512), unique=True)
    media_type: Mapped[str] = mapped_column(String(128))
    content_hash: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int] = mapped_column(Integer)


class DocumentSection(Base):
    __tablename__ = "document_sections"
    __table_args__ = (UniqueConstraint("document_id", "section_key"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    parent_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_sections.id", ondelete="CASCADE"), nullable=True, index=True
    )
    section_key: Mapped[str] = mapped_column(String(128))
    title: Mapped[str] = mapped_column(String(500))
    level: Mapped[int] = mapped_column(Integer, default=1)
    ordinal: Mapped[int] = mapped_column(Integer)
    start_page: Mapped[int] = mapped_column(Integer)
    end_page: Mapped[int] = mapped_column(Integer)
    detection_method: Mapped[str] = mapped_column(String(32), default="heuristic")
    confidence: Mapped[float] = mapped_column(Float, default=1.0)


class DocumentChunk(Base):
    """Searchable text span with a direct link to its source block and page."""

    __tablename__ = "document_chunks"
    __table_args__ = (UniqueConstraint("document_id", "chunk_key"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    page_number: Mapped[int] = mapped_column(Integer, index=True)
    block_id: Mapped[UUID] = mapped_column(
        ForeignKey("document_blocks.id", ondelete="CASCADE"), index=True
    )
    section_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_sections.id", ondelete="SET NULL"), index=True, nullable=True
    )
    chunk_key: Mapped[str] = mapped_column(String(96))
    chunk_index: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    token_count: Mapped[int] = mapped_column(Integer)
    bbox: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)


class DocumentTreeNode(Base):
    __tablename__ = "document_tree_nodes"
    __table_args__ = (UniqueConstraint("document_id", "node_key"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    parent_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_tree_nodes.id", ondelete="CASCADE"), nullable=True, index=True
    )
    node_key: Mapped[str] = mapped_column(String(255))
    node_type: Mapped[str] = mapped_column(String(16), index=True)
    label: Mapped[str] = mapped_column(String(500))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    section_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_sections.id", ondelete="CASCADE"), nullable=True, index=True
    )
    block_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_blocks.id", ondelete="CASCADE"), nullable=True, index=True
    )
    chunk_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_chunks.id", ondelete="CASCADE"), nullable=True, index=True
    )
    asset_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("document_assets.id", ondelete="CASCADE"), nullable=True, index=True
    )
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)


class DocumentEmbedding(Base):
    __tablename__ = "document_embeddings"

    chunk_id: Mapped[UUID] = mapped_column(
        ForeignKey("document_chunks.id", ondelete="CASCADE"), primary_key=True
    )
    document_id: Mapped[UUID] = mapped_column(
        ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    model: Mapped[str] = mapped_column(String(128))
    dimensions: Mapped[int] = mapped_column(Integer)
    embedding: Mapped[list[float]] = mapped_column(EmbeddingVector(384))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RetrievalEvent(Base):
    __tablename__ = "retrieval_events"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    query_hash: Mapped[str] = mapped_column(String(64))
    result_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MicroCheck(Base):
    __tablename__ = "micro_checks"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    idempotency_key: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    turn_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("turns.id", ondelete="SET NULL"), nullable=True, index=True
    )
    concept_id: Mapped[str] = mapped_column(String(255), index=True)
    check_type: Mapped[str] = mapped_column(String(32))
    question: Mapped[str] = mapped_column(Text)
    options: Mapped[list[object] | None] = mapped_column(JSON, nullable=True)
    expected_answer: Mapped[object] = mapped_column(JSON)
    tolerance: Mapped[float] = mapped_column(Float, default=0.0)
    source_refs: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    representation_used: Mapped[str] = mapped_column(String(64), default="normal_response")
    learner_answer: Mapped[object | None] = mapped_column(JSON, nullable=True)
    correctness: Mapped[bool | None] = mapped_column(nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    time_to_answer_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    learning_signal: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LearningState(Base):
    __tablename__ = "learning_states"
    __table_args__ = (UniqueConstraint("session_id", "concept_id"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    concept_id: Mapped[str] = mapped_column(String(255))
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    correct_count: Mapped[int] = mapped_column(Integer, default=0)
    incorrect_count: Mapped[int] = mapped_column(Integer, default=0)
    confidence_history: Mapped[list[float]] = mapped_column(JSON, default=list)
    representation_history: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    successful_representation: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    recent_friction_score: Mapped[float] = mapped_column(Float, default=0.0)


class Turn(Base):
    __tablename__ = "turns"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    idempotency_key: Mapped[str] = mapped_column(String(255), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    trace_id: Mapped[str] = mapped_column(String(64))
    query: Mapped[str] = mapped_column(Text)
    response_text: Mapped[str] = mapped_column(Text)
    citations: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    learning_state: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)
    mode: Mapped[str] = mapped_column(String(16), default="ADAPTIVE")
    warnings: Mapped[list[str]] = mapped_column(JSON, default=list)
    suggested_actions: Mapped[list[str]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(16), default="completed")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    turn_id: Mapped[UUID] = mapped_column(
        ForeignKey("turns.id", ondelete="CASCADE"), unique=True, index=True
    )
    trace_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), default="completed")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    metadata_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)


class AgentStep(Base):
    __tablename__ = "agent_steps"
    __table_args__ = (UniqueConstraint("agent_run_id", "sequence"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    agent_run_id: Mapped[UUID] = mapped_column(
        ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True
    )
    sequence: Mapped[int] = mapped_column(Integer)
    step_name: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="completed")
    provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    input_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    output_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LearningSignal(Base):
    __tablename__ = "learning_signals"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    turn_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("turns.id", ondelete="SET NULL"), nullable=True, index=True
    )
    concept_id: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    signal_type: Mapped[str] = mapped_column(String(64), index=True)
    strength: Mapped[float] = mapped_column(Float, default=0.0)
    source: Mapped[str] = mapped_column(String(32))
    details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ProviderRequest(Base):
    __tablename__ = "provider_requests"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    trace_id: Mapped[str] = mapped_column(String(64), index=True)
    turn_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("turns.id", ondelete="SET NULL"), nullable=True, index=True
    )
    provider: Mapped[str] = mapped_column(String(64), index=True)
    model: Mapped[str] = mapped_column(String(128))
    operation: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16))
    latency_ms: Mapped[float] = mapped_column(Float)
    prompt_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    response_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class EvaluationRecord(Base):
    __tablename__ = "evaluation_records"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    evaluation_set: Mapped[str] = mapped_column(String(128), index=True)
    item_id: Mapped[str] = mapped_column(String(128), index=True)
    metric: Mapped[str] = mapped_column(String(64), index=True)
    value: Mapped[float] = mapped_column(Float)
    details: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class RateLimitBucket(Base):
    __tablename__ = "rate_limit_buckets"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    request_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, index=True
    )


class VisualizationArtifact(Base):
    __tablename__ = "visualization_artifacts"

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    turn_id: Mapped[UUID] = mapped_column(
        ForeignKey("turns.id", ondelete="CASCADE"), unique=True, index=True
    )
    document_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("documents.id", ondelete="SET NULL"), nullable=True, index=True
    )
    schema_version: Mapped[str] = mapped_column(String(16), default="1.0")
    visual_type: Mapped[str] = mapped_column(String(32))
    spec: Mapped[dict[str, object]] = mapped_column(JSON)
    source_refs: Mapped[list[dict[str, object]]] = mapped_column(JSON, default=list)
    content_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class InteractionEvent(Base):
    __tablename__ = "interaction_events"
    __table_args__ = (UniqueConstraint("artifact_id", "session_id", "idempotency_key"),)

    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    artifact_id: Mapped[UUID] = mapped_column(
        ForeignKey("visualization_artifacts.id", ondelete="CASCADE"), index=True
    )
    session_id: Mapped[UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True
    )
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    interaction_id: Mapped[str] = mapped_column(String(64))
    target_id: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(16))
    state_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    value: Mapped[object | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
