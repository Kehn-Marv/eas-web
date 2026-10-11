"""Persistent, session-owned courses, share links, practice, and resume state."""

import json
import re
import secrets
from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select

from packages.shared.db import make_session_factory
from packages.shared.models import (
    Course,
    CourseLesson,
    CourseLessonProgress,
    CourseModule,
    Document,
    DocumentChunk,
    DocumentSection,
    LearningSession,
)
from packages.shared.understanding import evaluate_answer

router = APIRouter(prefix="/v1")
COURSE_STEPS = {"overview", "module-intro", "content", "question", "answer", "module-complete"}


class CourseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_ids: list[UUID] = Field(min_length=1, max_length=20)


class CourseProgressUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    module_index: int = Field(ge=0, le=99)
    lesson_index: int = Field(ge=0, le=99)
    step: str = Field(min_length=1, max_length=32)


class LessonAnswer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    answer: str | float | bool | list[str] | list[int] = Field(max_length=4000)


def _owner_id(request: Request) -> UUID:
    try:
        return UUID(request.cookies.get("eas_session", ""))
    except ValueError as exc:
        raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "Create a study session first."}) from exc


def _not_found() -> HTTPException:
    return HTTPException(404, detail={"code": "COURSE_NOT_FOUND", "message": "Course not found."})


async def _owned_course(db, course_id: UUID, session_id: UUID) -> Course:
    course = await db.scalar(select(Course).where(Course.id == course_id, Course.session_id == session_id))
    if course is None:
        raise _not_found()
    return course


def _safe_lesson(lesson: CourseLesson, *, reveal_answer: bool = False) -> dict[str, object]:
    value = dict(lesson.lesson)
    value["id"] = str(lesson.id)
    value["source_refs"] = lesson.source_refs or []
    if reveal_answer:
        value["answer"] = lesson.lesson.get("answer")
        value["explanation"] = lesson.lesson.get("explanation", "")
    else:
        value.pop("answer", None)
        value.pop("explanation", None)
    return value


def _public_lesson(value: dict[str, object]) -> dict[str, object]:
    value = dict(value)
    value["source_refs"] = [
        {"page_number": ref.get("page_number"), "excerpt": ref.get("excerpt")}
        for ref in value.get("source_refs", [])
        if isinstance(ref, dict)
    ]
    return value


async def _course_payload(db, course: Course, *, public: bool = False) -> dict[str, object]:
    modules = list((await db.scalars(select(CourseModule).where(CourseModule.course_id == course.id).order_by(CourseModule.position))).all())
    progress_by_lesson = {}
    if not public and modules:
        lesson_ids = list((await db.scalars(select(CourseLesson.id).where(CourseLesson.module_id.in_([item.id for item in modules])))).all())
        progress_by_lesson = {
            str(item.course_lesson_id): item
            for item in (await db.scalars(select(CourseLessonProgress).where(CourseLessonProgress.course_lesson_id.in_(lesson_ids)))).all()
        }
    result_modules = []
    for module in modules:
        lessons = list((await db.scalars(select(CourseLesson).where(CourseLesson.module_id == module.id).order_by(CourseLesson.position))).all())
        result_modules.append({
            "id": str(module.id),
            "title": module.title,
            "source_refs": (
                [{"page_number": ref.get("page_number"), "excerpt": ref.get("excerpt")} for ref in module.source_refs or []]
                if public else module.source_refs or []
            ),
            "lessons": [
                {
                    "success": True,
                    "data": (
                        _public_lesson(_safe_lesson(item))
                        if public
                        else _safe_lesson(
                            item,
                            reveal_answer=bool(
                                progress_by_lesson.get(str(item.id))
                                and progress_by_lesson[str(item.id)].attempt_count
                            ),
                        )
                    ),
                    "completed": bool(progress_by_lesson.get(str(item.id)) and progress_by_lesson[str(item.id)].last_correct),
                    "attempt_count": progress_by_lesson[str(item.id)].attempt_count if str(item.id) in progress_by_lesson else 0,
                    "last_correct": progress_by_lesson[str(item.id)].last_correct if str(item.id) in progress_by_lesson else None,
                    "last_answer": progress_by_lesson[str(item.id)].last_answer if str(item.id) in progress_by_lesson else None,
                }
                for item in lessons
            ],
        })
    completed = list(course.completed_lesson_ids or []) if not public else []
    total_lessons = sum(len(module["lessons"]) for module in result_modules)
    return {
        "course_id": str(course.id),
        "title": course.title,
        "source_titles": [] if public else course.source_titles or [],
        "is_public": course.is_public,
        "share_token": course.share_token if not public else None,
        "current_module_index": course.current_module_index if not public else 0,
        "current_lesson_index": course.current_lesson_index if not public else 0,
        "current_step": course.current_step if not public else "overview",
        "completed_lesson_ids": completed,
        "completed_count": len(completed),
        "total_lessons": total_lessons,
        "progress_percent": round(100 * len(completed) / total_lessons) if total_lessons else 0,
        "created_at": course.created_at.isoformat(),
        "updated_at": course.updated_at.isoformat(),
        "modules": result_modules,
    }


def _clean_text(value: object, limit: int = 3000) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def _source_ref(row) -> dict[str, object]:
    return {
        "document_id": str(row.document_id),
        "page_number": row.page_number,
        "block_id": str(row.block_id),
        "excerpt": _clean_text(row.content, 700),
    }


def _fallback_lessons(module_title: str, rows: list[object]) -> list[dict[str, object]]:
    """Create varied practice directly from source sentences if no model is configured."""
    excerpts = [_clean_text(row.content, 1800) for row in rows]
    excerpts = [item for item in excerpts if len(item) > 45]
    if not excerpts:
        return []
    lessons: list[dict[str, object]] = []
    for index in range(4):
        text = excerpts[index % len(excerpts)]
        sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if len(part.strip()) > 35]
        if not sentences:
            sentences = [text]
        if index == 0:
            terms = list(dict.fromkeys(re.findall(r"\b[A-Za-z][A-Za-z'-]{4,}\b", text)))
            answer = max(terms, key=len) if terms else "the source's key idea"
            distractors = [term for term in terms if term.casefold() != answer.casefold()][:2]
            choices = [answer] + (distractors if len(distractors) == 2 else ["an unrelated detail", "the opposite claim"][: 2 - len(distractors)])
            source_sentence = sentences[0]
            question = re.sub(re.escape(answer), "_____", source_sentence, count=1, flags=re.IGNORECASE) if answer.casefold() in source_sentence.casefold() else f"Which term best completes the source's explanation of {module_title}?"
            lessons.append({"title": f"Choose the key idea: {module_title}", "content": text, "info": "Use the source passage to complete the idea.", "question": question, "questionType": "multiple-choice", "choices": choices[:3], "answer": 0, "explanation": f"The source passage completes this idea with “{answer}”."})
            continue
        if index == 1:
            statement = sentences[0]
            lessons.append({"title": f"Check the idea: {module_title}", "content": statement, "info": "Compare the statement with the source passage.", "question": f"According to the source, is this statement accurate?\n\n“{statement}”", "questionType": "true-false", "answer": True, "explanation": "This statement is drawn directly from the cited source passage."})
            continue
        sequence = sentences[:3]
        if len(sequence) >= 3 and index == 2:
            shuffled = [sequence[2], sequence[0], sequence[1]]
            lessons.append({"title": f"Put it together: {module_title}", "content": "\n\n".join(sequence), "info": "Use the order and relationship described in the passage.", "question": "Arrange these ideas in the order they appear in the source.", "questionType": "drag-drop", "choices": shuffled, "slots": ["First", "Next", "Then"], "answer": [1, 2, 0], "explanation": "The ordering follows the sequence of the source passage."})
            continue
        if len(sequence) >= 3 and index == 3:
            labels = [sentence[:110] for sentence in sequence]
            nodes = [
                {"id": f"step-{position + 1}", "label": label, "type": "start" if position == 0 else "output" if position == 2 else "process"}
                for position, label in enumerate(labels)
            ]
            lessons.append({
                "title": f"Trace the process: {module_title}",
                "content": "The source presents these ideas as a connected sequence.",
                "info": "Look for the relationships between each step.",
                "question": "Arrange the process steps in the order supported by the source.",
                "questionType": "flow-diagram",
                "flowConfig": {"nodes": nodes, "edges": [["step-1", "step-2"], ["step-2", "step-3"]]},
                "choices": [labels[2], labels[0], labels[1]],
                "slots": ["First", "Next", "Then"],
                "answer": [1, 2, 0],
                "explanation": "The sequence follows the relationships in the source passage.",
            })
    return lessons


def _parse_generated_lessons(raw: str, fallback: list[dict[str, object]], title: str) -> list[dict[str, object]]:
    """Read a constrained JSON course response; reject unsupported or malformed activities."""
    try:
        outer = json.loads(raw)
        payload = json.loads(outer.get("text", "")) if isinstance(outer, dict) and isinstance(outer.get("text"), str) else outer
        candidates = payload.get("lessons", []) if isinstance(payload, dict) else []
    except (json.JSONDecodeError, TypeError, AttributeError):
        return fallback
    result = []
    type_map = {"short-answer": "short-answer", "short_answer": "short-answer", "multiple-choice": "multiple-choice", "multiple_choice": "multiple-choice", "true-false": "true-false", "true_false": "true-false", "drag-drop": "drag-drop", "drag_drop": "drag-drop", "process-ordering": "flow-diagram", "process_ordering": "flow-diagram", "flow-diagram": "flow-diagram", "flow_diagram": "flow-diagram", "reorder_steps": "drag-drop"}
    for item in candidates[:4] if isinstance(candidates, list) else []:
        if not isinstance(item, dict):
            continue
        qtype = type_map.get(str(item.get("questionType", item.get("question_type", ""))).casefold())
        question = _clean_text(item.get("question"), 1500)
        content = _clean_text(item.get("content"), 3000)
        answer = item.get("answer")
        lesson = {"title": _clean_text(item.get("title"), 200) or title, "content": content, "info": _clean_text(item.get("info"), 700), "question": question, "questionType": qtype, "explanation": _clean_text(item.get("explanation"), 1200)}
        if not qtype or not question or not content or answer is None:
            continue
        if qtype == "multiple-choice":
            choices = item.get("choices")
            if not isinstance(choices, list) or len(choices) < 3 or type(answer) is not int or not 0 <= answer < len(choices):
                continue
            lesson.update({"choices": [_clean_text(choice, 300) for choice in choices[:6]], "answer": answer})
        elif qtype == "true-false":
            if not isinstance(answer, bool):
                continue
            lesson["answer"] = answer
        elif qtype in {"drag-drop", "flow-diagram"}:
            choices = item.get("choices")
            slots = item.get("slots") or ["First", "Next", "Then"]
            if not isinstance(choices, list) or len(choices) != 3 or any(not _clean_text(choice, 300) for choice in choices) or not isinstance(slots, list) or len(slots) != 3 or any(not _clean_text(slot, 100) for slot in slots) or not isinstance(answer, list) or any(type(index) is not int for index in answer) or sorted(answer) != [0, 1, 2]:
                continue
            lesson.update({"choices": [_clean_text(choice, 300) for choice in choices], "slots": [_clean_text(slot, 100) for slot in slots[:3]], "answer": answer})
            if qtype == "flow-diagram":
                flow = item.get("flowConfig", item.get("flow_config"))
                if not isinstance(flow, dict) or not isinstance(flow.get("nodes"), list) or not isinstance(flow.get("edges"), list):
                    continue
                nodes, edges = flow["nodes"], flow["edges"]
                if len(nodes) != 3 or len(edges) != 2 or any(not isinstance(node, dict) for node in nodes):
                    continue
                ids = [node.get("id") for node in nodes]
                labels = [ _clean_text(node.get("label"), 300) for node in nodes ]
                if any(not isinstance(node_id, str) or not node_id for node_id in ids) or len(set(ids)) != 3 or any(not label for label in labels):
                    continue
                if any(node.get("type") not in {"start", "process", "output"} for node in nodes):
                    continue
                if any(not isinstance(edge, (list, tuple)) or len(edge) != 2 or edge[0] not in ids or edge[1] not in ids or edge[0] == edge[1] for edge in edges):
                    continue
                next_node = {edge[0]: edge[1] for edge in edges}
                if len(next_node) != 2:
                    continue
                incoming = {edge[1] for edge in edges}
                starts = [node_id for node_id in ids if node_id not in incoming]
                if len(starts) != 1:
                    continue
                ordered_ids = [starts[0]]
                while ordered_ids[-1] in next_node and len(ordered_ids) < 3:
                    ordered_ids.append(next_node[ordered_ids[-1]])
                if len(ordered_ids) != 3 or len(set(ordered_ids)) != 3 or {node_id for edge in edges for node_id in edge} != set(ids):
                    continue
                label_by_id = dict(zip(ids, labels, strict=True))
                if [choices[index] for index in answer] != [label_by_id[node_id] for node_id in ordered_ids]:
                    continue
                lesson["flowConfig"] = {
                    "nodes": [
                        {"id": node["id"], "label": label, "type": node["type"]}
                        for node, label in zip(nodes, labels, strict=True)
                    ],
                    "edges": [[edge[0], edge[1]] for edge in edges],
                }
        else:
            if not isinstance(answer, (str, int, float)):
                continue
            lesson["answer"] = answer
        result.append(lesson)
    required = {"multiple-choice", "true-false", "drag-drop", "flow-diagram"}
    return result if len(result) == 4 and {item["questionType"] for item in result} == required else fallback


async def _make_lessons(request: Request, title: str, rows: list[object]) -> list[dict[str, object]]:
    fallback = _fallback_lessons(title, rows)
    provider = getattr(request.app.state, "llm_provider", None)
    if not fallback or provider is None:
        return fallback
    settings = request.app.state.settings
    if not (settings.llm_api_url and settings.llm_api_key):
        return fallback
    sources = [
        {"chunk_id": str(row.id), "document_id": str(row.document_id), "page_number": row.page_number, "content": _clean_text(row.content, 1800)}
        for row in rows[:3]
    ]
    prompt = (
        f"Create exactly four concise, distinct interactive lessons for the module {title!r}, grounded only in the supplied excerpts. "
        "Return the JSON object as the value of the JSON 'text' field, with keys lessons and each lesson containing title, content, info, question, questionType, answer, explanation, choices, slots as needed. "
        "Use these activity types exactly once: multiple-choice, true-false, drag-drop, and process-ordering (questionType flow-diagram). "
        "For multiple-choice answer is a zero-based integer index; true-false answer is boolean; drag-drop has 3 choices, 3 slots, and answer is a permutation of [0,1,2]. "
        "For process-ordering include a flowConfig with exactly 3 connected nodes (each with a unique string id, label, and type start/process/output) and 2 directed edges forming a sequence supported by the excerpts. Include 3 shuffled choices, 3 slots, and answer as a permutation [0,1,2] such that choices[answer[i]] is the node label at step i. Do not invent process steps or orderings not supported by the source. "
        "Keep lesson content and questions brief, unambiguous, and factually supported. Do not include citations or markdown."
    )
    try:
        raw = await provider.generate(prompt, sources)
        return _parse_generated_lessons(raw, fallback, title)
    except Exception:
        return fallback


@router.post("/courses", status_code=201)
async def create_course(request: Request, body: CourseCreate) -> dict[str, object]:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        session = await db.get(LearningSession, session_id)
        if session is None:
            raise HTTPException(404, detail={"code": "SESSION_NOT_FOUND", "message": "Study session not found."})
        docs = list((await db.scalars(select(Document).where(Document.session_id == session_id, Document.id.in_(body.document_ids), Document.status.in_(["READY", "DEGRADED"]), Document.index_status == "ready"))).all())
        if len(docs) != len(set(body.document_ids)) or not docs:
            raise HTTPException(422, detail={"code": "SOURCES_NOT_READY", "message": "Wait until each selected source is ready, then try again."})
        rows = list((await db.execute(
            select(DocumentChunk, DocumentSection.title.label("section_title"))
            .outerjoin(DocumentSection, DocumentSection.id == DocumentChunk.section_id)
            .where(DocumentChunk.document_id.in_([doc.id for doc in docs]))
            .order_by(DocumentChunk.document_id, DocumentChunk.page_number, DocumentChunk.chunk_index)
            .limit(5000)
        )).all())
        if not rows:
            raise HTTPException(422, detail={"code": "SOURCE_TEXT_UNAVAILABLE", "message": "EAS could not find searchable text in those sources."})
        groups: dict[str, list[object]] = {}
        for row, section_title in rows:
            label = _clean_text(section_title, 300) or next(doc.filename for doc in docs if doc.id == row.document_id)
            groups.setdefault(label, []).append(row)
        grouped = [(label, values) for label, values in groups.items() if any(len(_clean_text(row.content)) > 45 for row in values)]
        if not grouped:
            raise HTTPException(422, detail={"code": "SOURCE_TEXT_UNAVAILABLE", "message": "The selected source does not contain enough readable text to build lessons."})
        module_groups = grouped[:4]
        if len(module_groups) == 1 and len(module_groups[0][1]) >= 6:
            label, source_chunks = module_groups[0]
            part_size = max(3, (len(source_chunks) + 2) // 3)
            module_groups = [
                (f"{label} · Part {part + 1}", source_chunks[part * part_size : (part + 1) * part_size])
                for part in range(3)
                if source_chunks[part * part_size : (part + 1) * part_size]
            ]
        display_title = docs[0].filename.rsplit(".", 1)[0] if len(docs) == 1 else f"Learning path · {len(docs)} sources"
        course = Course(session_id=session_id, title=display_title[:500], source_document_ids=[str(doc.id) for doc in docs], source_titles=[doc.filename for doc in docs])
        db.add(course)
        await db.flush()
        total = 0
        for module_index, (module_title, source_rows) in enumerate(module_groups):
            sample_rows = source_rows[:3] if len(source_rows) >= 3 else source_rows
            module = CourseModule(course_id=course.id, position=module_index, title=module_title[:500], source_refs=[_source_ref(row) for row in sample_rows])
            db.add(module)
            await db.flush()
            lessons = await _make_lessons(request, module_title, sample_rows)
            if len(lessons) < 2:
                continue
            for lesson_index, payload in enumerate(lessons):
                payload["source_refs"] = [_source_ref(sample_rows[lesson_index % len(sample_rows)])]
                qtype = payload["questionType"]
                if qtype == "multiple-choice":
                    check_type, expected = "multiple_choice", payload["answer"]
                elif qtype == "true-false":
                    check_type, expected = "multiple_choice", "True" if payload["answer"] else "False"
                elif qtype == "drag-drop":
                    check_type = "reorder_steps"
                    expected = [payload["choices"][index] for index in payload["answer"]]
                elif qtype == "flow-diagram":
                    check_type = "reorder_steps"
                    expected = [payload["choices"][index] for index in payload["answer"]]
                else:
                    check_type, expected = "short_answer", payload["answer"]
                record = CourseLesson(module_id=module.id, position=lesson_index, title=str(payload["title"]), lesson=payload, source_refs=payload["source_refs"], check_type=check_type, expected_answer=expected)
                db.add(record)
                total += 1
        if total < 2:
            raise HTTPException(422, detail={"code": "LESSONS_NOT_GENERATED", "message": "EAS could not build enough grounded lessons from this source."})
        course.current_step = "overview"
        await db.commit()
        await db.refresh(course)
        return await _course_payload(db, course)


@router.get("/courses")
async def list_courses(request: Request) -> dict[str, object]:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        if await db.get(LearningSession, session_id) is None:
            raise HTTPException(404, detail={"code": "SESSION_NOT_FOUND", "message": "Study session not found."})
        courses = list((await db.scalars(select(Course).where(Course.session_id == session_id).order_by(Course.updated_at.desc()))).all())
        return {"courses": [await _course_payload(db, course) for course in courses]}


@router.get("/courses/{course_id}")
async def get_course(request: Request, course_id: UUID) -> dict[str, object]:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        course = await _owned_course(db, course_id, session_id)
        return await _course_payload(db, course)


@router.delete("/courses/{course_id}", status_code=204)
async def delete_course(request: Request, course_id: UUID) -> Response:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        course = await _owned_course(db, course_id, session_id)
        module_ids = select(CourseModule.id).where(CourseModule.course_id == course.id)
        lesson_ids = select(CourseLesson.id).where(CourseLesson.module_id.in_(module_ids))
        await db.execute(delete(CourseLessonProgress).where(CourseLessonProgress.course_lesson_id.in_(lesson_ids)))
        await db.execute(delete(CourseLesson).where(CourseLesson.module_id.in_(module_ids)))
        await db.execute(delete(CourseModule).where(CourseModule.course_id == course.id))
        await db.delete(course)
        await db.commit()
    return Response(status_code=204)


@router.put("/courses/{course_id}/progress")
async def update_course_progress(request: Request, course_id: UUID, body: CourseProgressUpdate) -> dict[str, object]:
    session_id = _owner_id(request)
    if body.step not in COURSE_STEPS:
        raise HTTPException(422, detail={"code": "INVALID_COURSE_STEP", "message": "That learning step is invalid."})
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        course = await _owned_course(db, course_id, session_id)
        modules = list((await db.scalars(select(CourseModule).where(CourseModule.course_id == course.id).order_by(CourseModule.position))).all())
        if body.module_index >= len(modules):
            raise HTTPException(422, detail={"code": "INVALID_MODULE", "message": "That module does not exist."})
        lessons = list((await db.scalars(select(CourseLesson).where(CourseLesson.module_id == modules[body.module_index].id).order_by(CourseLesson.position))).all())
        if body.lesson_index >= len(lessons):
            raise HTTPException(422, detail={"code": "INVALID_LESSON", "message": "That lesson does not exist."})
        course.current_module_index = body.module_index
        course.current_lesson_index = body.lesson_index
        course.current_step = body.step
        course.updated_at = datetime.now(UTC)
        await db.commit()
        return {"ok": True, "current_module_index": course.current_module_index, "current_lesson_index": course.current_lesson_index, "current_step": course.current_step}


async def _answer_lesson(db, lesson: CourseLesson, body: LessonAnswer) -> dict[str, object]:
    answer = body.answer
    if lesson.check_type == "reorder_steps":
        choices = lesson.lesson.get("choices", [])
        if (
            not isinstance(answer, list)
            or not isinstance(choices, list)
            or len(answer) != len(choices)
            or any(type(index) is not int for index in answer)
            or sorted(answer) != list(range(len(choices)))
        ):
            raise HTTPException(422, detail={"code": "INVALID_ANSWER", "message": "Arrange the items in order before checking."})
        answer = [choices[index] for index in answer]
    elif lesson.lesson.get("questionType") == "true-false" and isinstance(answer, bool):
        answer = "True" if answer else "False"
    correctness = evaluate_answer(lesson.check_type, lesson.expected_answer, answer)
    progress = await db.scalar(select(CourseLessonProgress).where(CourseLessonProgress.course_lesson_id == lesson.id))
    if progress is None:
        progress = CourseLessonProgress(course_lesson_id=lesson.id)
        db.add(progress)
    progress.attempt_count += 1
    progress.correct_count += int(correctness)
    progress.last_correct = correctness
    progress.last_answer = body.answer
    progress.answered_at = datetime.now(UTC)
    return {"correctness": correctness, "answer": lesson.lesson.get("answer"), "explanation": lesson.lesson.get("explanation", ""), "attempt_count": progress.attempt_count}


@router.post("/courses/{course_id}/lessons/{lesson_id}/answer")
async def answer_course_lesson(request: Request, course_id: UUID, lesson_id: UUID, body: LessonAnswer) -> dict[str, object]:
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        course = await _owned_course(db, course_id, session_id)
        lesson = await db.scalar(select(CourseLesson).join(CourseModule).where(CourseLesson.id == lesson_id, CourseModule.course_id == course.id))
        if lesson is None:
            raise HTTPException(404, detail={"code": "LESSON_NOT_FOUND", "message": "Lesson not found."})
        result = await _answer_lesson(db, lesson, body)
        completed = set(course.completed_lesson_ids or [])
        if result["correctness"]:
            completed.add(str(lesson.id))
        course.completed_lesson_ids = sorted(completed)
        course.updated_at = datetime.now(UTC)
        await db.commit()
        return result


@router.put("/courses/{course_id}/share")
async def set_course_visibility(request: Request, course_id: UUID, body: dict[str, bool]) -> dict[str, object]:
    if set(body) != {"is_public"} or not isinstance(body["is_public"], bool):
        raise HTTPException(422, detail={"code": "INVALID_VISIBILITY", "message": "Choose public or private sharing."})
    session_id = _owner_id(request)
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        course = await _owned_course(db, course_id, session_id)
        if body["is_public"] and not course.share_token:
            course.share_token = secrets.token_urlsafe(32)
        elif not body["is_public"]:
            course.share_token = None
        course.is_public = body["is_public"]
        course.updated_at = datetime.now(UTC)
        await db.commit()
        path = f"/shared?token={course.share_token}" if course.is_public else None
        return {"is_public": course.is_public, "share_path": path}


@router.get("/shared/{share_token}")
async def get_shared_course(request: Request, share_token: str) -> dict[str, object]:
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        course = await db.scalar(select(Course).where(Course.share_token == share_token, Course.is_public.is_(True)))
        if course is None:
            raise _not_found()
        return await _course_payload(db, course, public=True)


@router.post("/shared/{share_token}/lessons/{lesson_id}/answer")
async def answer_shared_lesson(request: Request, share_token: str, lesson_id: UUID, body: LessonAnswer) -> dict[str, object]:
    factory = make_session_factory(request.app.state.db_engine)
    async with factory() as db:
        course = await db.scalar(select(Course).where(Course.share_token == share_token, Course.is_public.is_(True)))
        if course is None:
            raise _not_found()
        lesson = await db.scalar(select(CourseLesson).join(CourseModule).where(CourseLesson.id == lesson_id, CourseModule.course_id == course.id))
        if lesson is None:
            raise HTTPException(404, detail={"code": "LESSON_NOT_FOUND", "message": "Lesson not found."})
        # Public learners get feedback, but their attempts never affect the owner's progress.
        answer = body.answer
        if lesson.check_type == "reorder_steps":
            choices = lesson.lesson.get("choices", [])
            if (
                not isinstance(answer, list)
                or not isinstance(choices, list)
                or len(answer) != len(choices)
                or any(type(index) is not int for index in answer)
                or sorted(answer) != list(range(len(choices)))
            ):
                raise HTTPException(422, detail={"code": "INVALID_ANSWER", "message": "Arrange the items in order before checking."})
            answer = [choices[index] for index in answer]
        elif lesson.lesson.get("questionType") == "true-false" and isinstance(answer, bool):
            answer = "True" if answer else "False"
        correctness = evaluate_answer(lesson.check_type, lesson.expected_answer, answer)
        return {"correctness": correctness, "answer": lesson.lesson.get("answer"), "explanation": lesson.lesson.get("explanation", "")}
