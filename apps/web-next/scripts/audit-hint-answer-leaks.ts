#!/usr/bin/env tsx
/**
 * Audit saved course JSON or full benchmark JSON for hints that reveal answers.
 *
 * Usage:
 *   tsx scripts/audit-hint-answer-leaks.ts lib/demo/composer2-course.json
 *   tsx scripts/audit-hint-answer-leaks.ts data/benchmarks/eval-all-*.json
 */

import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { detectHintAnswerLeak } from "../lib/hint-answer-leak";

interface AuditQuestion {
  file: string;
  moduleTitle?: string;
  moduleIndex?: number;
  lessonTitle?: string;
  lessonIndex?: number;
  questionType: string;
  question: string;
  hint: string;
  answer: unknown;
  choices?: unknown[];
  slots?: string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function lessonData(lesson: unknown): JsonObject | null {
  if (!isObject(lesson)) return null;
  if (lesson.success === false) return null;
  return isObject(lesson.data) ? lesson.data : lesson;
}

function collectFromCourse(doc: unknown, source: string): AuditQuestion[] {
  if (!isObject(doc) || !Array.isArray(doc.modules)) return [];
  const questions: AuditQuestion[] = [];
  doc.modules.forEach((moduleValue, moduleIndex) => {
    if (!isObject(moduleValue)) return;
    const lessons = Array.isArray(moduleValue.lessons) ? moduleValue.lessons : [];
    lessons.forEach((lesson, lessonIndex) => {
      const data = lessonData(lesson);
      if (!data || typeof data.questionType !== "string" || typeof data.question !== "string") return;
      questions.push({
        file: source,
        moduleTitle: stringValue(moduleValue.title),
        moduleIndex,
        lessonTitle: stringValue(data.title),
        lessonIndex,
        questionType: data.questionType,
        question: data.question,
        hint: stringValue(data.info ?? data.hint),
        answer: data.answer,
        choices: arrayValue(data.choices),
        slots: stringArrayValue(data.slots),
      });
    });
  });
  return questions;
}

function collectFromBenchmark(doc: unknown, source: string): AuditQuestion[] {
  if (!isObject(doc) || !Array.isArray(doc.results)) return [];
  const questions: AuditQuestion[] = [];
  doc.results.forEach((result) => {
    if (!isObject(result)) return;
    const resultQuestions = Array.isArray(result.questions) ? result.questions : [];
    resultQuestions.forEach((q) => {
      if (!isObject(q) || typeof q.questionType !== "string" || typeof q.question !== "string") return;
      questions.push({
        file: stringValue(result.file || source),
        moduleTitle: stringValue(q.moduleTitle),
        moduleIndex: typeof q.moduleIndex === "number" ? q.moduleIndex : undefined,
        lessonTitle: stringValue(q.lessonTitle),
        lessonIndex: typeof q.lessonIndex === "number" ? q.lessonIndex : undefined,
        questionType: q.questionType,
        question: q.question,
        hint: stringValue(q.hint ?? q.info ?? q.lessonInfo),
        answer: q.answer,
        choices: arrayValue(q.choices),
        slots: stringArrayValue(q.slots),
      });
    });
  });
  return questions;
}

function collectQuestions(doc: unknown, source: string): AuditQuestion[] {
  return [...collectFromBenchmark(doc, source), ...collectFromCourse(doc, source)];
}

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "N/A";
}

const paths = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (paths.length === 0) {
  console.error("Usage: tsx scripts/audit-hint-answer-leaks.ts <course-or-benchmark.json> [...]");
  process.exit(1);
}

let totalQuestions = 0;
let totalWithHints = 0;
let totalLeaks = 0;

for (const path of paths) {
  if (!existsSync(path)) {
    console.error(`Missing file: ${path}`);
    process.exitCode = 1;
    continue;
  }

  const doc = JSON.parse(readFileSync(path, "utf-8"));
  const questions = collectQuestions(doc, basename(path));
  const withHints = questions.filter((q) => q.hint.trim().length > 0);
  const checked = withHints.map((q) => ({
    q,
    leak: detectHintAnswerLeak({
      questionType: q.questionType,
      question: q.question,
      hint: q.hint,
      answer: q.answer,
      choices: q.choices,
      slots: q.slots,
    }),
  }));
  const leaks = checked.filter((item) => item.leak.leaksAnswer);

  totalQuestions += questions.length;
  totalWithHints += withHints.length;
  totalLeaks += leaks.length;

  console.log(`\n${basename(path)}`);
  console.log(`  questions: ${questions.length}`);
  console.log(`  hints checked: ${withHints.length}`);
  console.log(`  leaks: ${leaks.length}/${withHints.length} (${pct(leaks.length, withHints.length)})`);

  if (questions.length > 0 && withHints.length === 0) {
    console.log("  no hint text found; slim benchmark JSON usually omits per-question hints");
  }

  for (const { q, leak } of leaks.slice(0, 20)) {
    const loc =
      q.moduleIndex != null && q.lessonIndex != null
        ? `M${q.moduleIndex + 1}L${q.lessonIndex + 1}`
        : q.lessonTitle ?? q.file;
    console.log(`  - ${loc} ${q.questionType}: ${q.question}`);
    console.log(`    hint: ${q.hint}`);
    console.log(`    leak: ${leak.severity}; ${leak.reasons.join("; ")}`);
    if (leak.matchedTerms.length > 0) {
      console.log(`    matched: ${leak.matchedTerms.join(", ")}`);
    }
  }

  if (leaks.length > 20) {
    console.log(`  ... ${leaks.length - 20} more leaks`);
  }
}

if (paths.length > 1) {
  console.log("\nAggregate");
  console.log(`  questions: ${totalQuestions}`);
  console.log(`  hints checked: ${totalWithHints}`);
  console.log(`  leaks: ${totalLeaks}/${totalWithHints} (${pct(totalLeaks, totalWithHints)})`);
}

process.exit(totalLeaks > 0 ? 1 : 0);
