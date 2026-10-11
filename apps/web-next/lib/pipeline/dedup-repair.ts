/**
 * Post-hoc duplicate detection and repair for parallel-module courses.
 *
 * When modules are generated in parallel (no previousQuestions chain), they
 * sometimes converge on the same question — especially flow-diagram lessons,
 * which tend to all detect the same dominant process in the source. This pass:
 *   1. Detects duplicate questions across modules (Jaccard word overlap ≥ 0.5).
 *   2. Keeps the first instance of each group.
 *   3. Regenerates the rest sequentially, telling the model what to avoid.
 *   4. Re-detects: any duplicates that survived regeneration get marked as
 *      `success: false` with `validationType: "duplicate"`. Consumers filter
 *      these out at render time. Better to ship N-1 grounded lessons than N
 *      with a visible repeat.
 */
import { generateText } from "ai";
import type { CourseOutput } from "../create-course";
import type { LessonResult } from "../types";
import { createTogetherClient, DEFAULT_MODEL, getTogetherProviderOptions } from "../utils/together";
import { singleLessonSchema } from "../schemas";
import { parseJSON } from "../utils/json";
import { generateFlowLessonCombined } from "./combined-flow";
import { sanitizeGeneratedHint } from "../hint-answer-leak";

// 0.5 catches semantic dupes the 0.7 threshold misses, e.g.
// "How many parallel attention heads (h) are employed in the Transformer architecture?" vs
// "How many parallel attention heads does the Transformer use?" — Jaccard ≈ 0.5.
const DUPE_THRESHOLD = 0.5;

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function similarity(a: string, b: string): number {
  const wa = new Set(normalize(a).split(" "));
  const wb = new Set(normalize(b).split(" "));
  if (wa.size === 0 || wb.size === 0) return 0;
  const inter = new Set([...wa].filter((w) => wb.has(w)));
  const uni = new Set([...wa, ...wb]);
  return inter.size / uni.size;
}

interface HintSanitizableLesson {
  questionType?: string;
  question?: unknown;
  info?: unknown;
  answer?: unknown;
  choices?: unknown[];
  slots?: string[];
  content?: unknown;
}

function sanitizeInfo<T extends HintSanitizableLesson>(lesson: T): T {
  lesson.info = sanitizeGeneratedHint({
    questionType: lesson.questionType ?? "",
    question: lesson.question,
    hint: lesson.info,
    answer: lesson.answer,
    choices: lesson.choices,
    slots: lesson.slots,
    content: lesson.content,
  });
  return lesson;
}

interface LessonRef {
  moduleIndex: number;
  lessonIndex: number;
  question: string;
  questionType: string;
}

interface DupeGroup {
  representative: LessonRef;
  duplicates: LessonRef[]; // lessons to regenerate
}

function findDupes(course: CourseOutput): DupeGroup[] {
  const refs: LessonRef[] = [];
  course.modules.forEach((mod, mi) => {
    mod.lessons.forEach((lr, li) => {
      if (lr.success) {
        refs.push({
          moduleIndex: mi,
          lessonIndex: li,
          question: lr.data.question,
          questionType: lr.data.questionType,
        });
      }
    });
  });

  const groups: DupeGroup[] = [];
  const assigned = new Set<string>();
  for (let i = 0; i < refs.length; i++) {
    const key = `${refs[i].moduleIndex}-${refs[i].lessonIndex}`;
    if (assigned.has(key)) continue;
    const dupes: LessonRef[] = [];
    for (let j = i + 1; j < refs.length; j++) {
      const k2 = `${refs[j].moduleIndex}-${refs[j].lessonIndex}`;
      if (assigned.has(k2)) continue;
      if (similarity(refs[i].question, refs[j].question) >= DUPE_THRESHOLD) {
        dupes.push(refs[j]);
        assigned.add(k2);
      }
    }
    if (dupes.length > 0) {
      assigned.add(key);
      groups.push({ representative: refs[i], duplicates: dupes });
    }
  }
  return groups;
}

async function regenerateStandard(
  ref: LessonRef,
  moduleTitle: string,
  existingQuestions: string[],
  content: string,
  apiKey: string,
  model: string
): Promise<any | null> {
  const together = createTogetherClient(apiKey);
  const providerOptions = getTogetherProviderOptions(model);

  const targetType = ref.questionType;
  const skeleton =
    targetType === "short-answer"
      ? '{"title":"...","content":"...","info":"...","question":"...","questionType":"short-answer","answer":"..."}'
      : targetType === "true-false"
      ? '{"title":"...","content":"...","info":"...","question":"...","questionType":"true-false","answer":true,"explanation":"..."}'
      : '{"title":"...","content":"...","info":"...","question":"...","questionType":"multiple-choice","answer":0,"choices":["Correct","B","C","D"],"explanation":"..."}';

  const prompt = `Generate ONE replacement lesson for module "${moduleTitle}".
The question MUST NOT duplicate or paraphrase any of these existing questions:
${existingQuestions.map((q, i) => `${i + 1}. "${q}"`).join("\n")}

Pick a DIFFERENT fact or concept from the source — not just different wording for the same topic.
Question type: ${targetType}
All facts must come from the source content.
The "info" field is shown as a strategy hint. It must not reveal the answer, name the correct choice, give the true/false verdict, or add another answer-bearing fact.

Respond ONLY with JSON matching:
${skeleton}

Source content:
${content}`;

  try {
    const r = await generateText({ model: together(model), providerOptions, prompt });
    const parsed = parseJSON(r.text);
    const validated = singleLessonSchema.safeParse(parsed);
    if (!validated.success) return null;
    return sanitizeInfo({ ...validated.data });
  } catch {
    return null;
  }
}

async function regenerateFlow(
  moduleTitle: string,
  existingQuestions: string[],
  content: string,
  apiKey: string,
  model: string
): Promise<any | null> {
  // Combined-flow generator already accepts previousQuestions for dedup.
  const lesson = await generateFlowLessonCombined({
    moduleTitle,
    content,
    apiKey,
    model,
    previousQuestions: existingQuestions,
  });
  return lesson ? sanitizeInfo(lesson) : null;
}

/**
 * Mutates the course in place. Strategy:
 *   1. Regenerate each duplicate with `previousQuestions` context.
 *   2. Re-detect any duplicates that survived regeneration.
 *   3. Mark surviving duplicates as `success: false` with
 *      `validationType: "duplicate"` so consumers can filter them at render.
 *
 * Returns counts for telemetry / tests.
 */
export async function dedupRepair(
  course: CourseOutput,
  content: string,
  apiKey: string,
  model: string = DEFAULT_MODEL
): Promise<{ repairs: number; dropped: number; remainingDupes: number }> {
  const groups = findDupes(course);
  if (groups.length === 0) return { repairs: 0, dropped: 0, remainingDupes: 0 };

  // Build the "questions already used" set (representatives + non-duped lessons).
  const lockedQuestions: string[] = [];
  const dupeKeys = new Set<string>();
  for (const g of groups) {
    for (const d of g.duplicates) dupeKeys.add(`${d.moduleIndex}-${d.lessonIndex}`);
  }
  course.modules.forEach((mod, mi) => {
    mod.lessons.forEach((lr, li) => {
      if (lr.success && !dupeKeys.has(`${mi}-${li}`)) {
        lockedQuestions.push(lr.data.question);
      }
    });
  });

  // Regenerate duplicates SEQUENTIALLY so each new question feeds back into
  // `lockedQuestions` before the next regenerate sees it. (Earlier version ran
  // these in parallel and observed two regenerates picking the same new
  // question, re-creating the dupe.)
  const jobs = groups.flatMap((g) =>
    g.duplicates.map((d) => ({ ref: d, moduleTitle: course.modules[d.moduleIndex].title }))
  );

  let repairCount = 0;
  for (const { ref, moduleTitle } of jobs) {
    let newLesson: any | null = null;
    if (ref.questionType === "flow-diagram") {
      newLesson = await regenerateFlow(moduleTitle, lockedQuestions, content, apiKey, model);
    } else {
      newLesson = await regenerateStandard(ref, moduleTitle, lockedQuestions, content, apiKey, model);
    }
    if (!newLesson) continue;
    const mod = course.modules[ref.moduleIndex];
    mod.lessons[ref.lessonIndex] = { success: true, data: newLesson } as LessonResult;
    lockedQuestions.push(newLesson.question);
    repairCount++;
  }

  // Re-detect. Anything still in a dupe group means regeneration produced
  // a question that overlaps with another lesson (either the original
  // representative, or a newly-regenerated one). Drop those by marking them
  // as success:false. UI / consumers already filter failed lessons.
  let dropped = 0;
  const remainingGroups = findDupes(course);
  for (const g of remainingGroups) {
    for (const d of g.duplicates) {
      const mod = course.modules[d.moduleIndex];
      const existing = mod.lessons[d.lessonIndex];
      if (!existing.success) continue;
      mod.lessons[d.lessonIndex] = {
        success: false,
        data: existing.data,
        error: {
          validationType: "duplicate",
          reason: `Question is a semantic duplicate of "${g.representative.question.substring(0, 80)}" (kept at M${g.representative.moduleIndex + 1}L${g.representative.lessonIndex + 1}). Regeneration failed to produce a distinct question.`,
        },
      } as LessonResult;
      dropped++;
    }
  }

  const remainingDupes = findDupes(course).reduce(
    (s, g) => s + g.duplicates.length + 1,
    0
  );
  return { repairs: repairCount, dropped, remainingDupes };
}
