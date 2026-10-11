#!/usr/bin/env tsx
/**
 * Benchmark answer correctness across PDFs.
 *
 * Generates courses, then uses a separate LLM judge to verify every
 * question/answer pair against the source content.
 *
 * Usage:
 *   TOGETHER_API_KEY=... OPENROUTER_API_KEY=... bun scripts/benchmark-answers.ts [--tag=<name>] [--model=<model>] [--judge=<model>] [--types=<types>] [file1 file2...]
 *
 * If no files given, runs all PDFs in data/pdfs/.
 * --model   sets the generation model (default: MiniMaxAI/MiniMax-M2.7)
 * --judge   sets the judge model (default: anthropic/claude-opus-4-6).
 *           Use anthropic/, openrouter/, or ollama/ prefixes to force a provider.
 * --tag     label for the output file (default: answers)
 * --types   comma-separated question types to judge (e.g. flow-diagram,true-false). If omitted, all types are judged.
 */

import { createCourse } from "../lib/create-course";
import { generateText } from "ai";
import { ocr } from "../lib/ocr";
import { DEFAULT_MODEL } from "../lib/utils/together";
import { parseJSON } from "../lib/utils/json";
import { getJudgeModel } from "../lib/utils/judge-model";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, basename, extname, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDFS_DIR = resolve(__dirname, "../data/pdfs");
const BENCHMARKS_DIR = resolve(__dirname, "../data/benchmarks");

// ── CLI args ────────────────────────────────────────────
const args = process.argv.slice(2);
const tag = args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "answers";
const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? undefined;
const judgeModel =
  args.find((a) => a.startsWith("--judge="))?.split("=")[1] ?? "anthropic/claude-sonnet-4-6";
const iterations = parseInt(
  args.find((a) => a.startsWith("--iterations="))?.split("=")[1] ?? "1",
  10
);
const typesFilter = args.find((a) => a.startsWith("--types="))?.split("=")[1]?.split(",") ?? [];
const inputFiles = args.filter((a) => !a.startsWith("--")).map((f) => resolve(f));

const apiKey = process.env.TOGETHER_API_KEY;
if (!apiKey) {
  console.error("TOGETHER_API_KEY is required");
  process.exit(1);
}

const openrouterApiKey = process.env.OPENROUTER_API_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;

async function judge(prompt: string): Promise<string> {
  const r = await generateText({
    model: getJudgeModel({
      judgeModel,
      togetherApiKey: apiKey,
      anthropicApiKey,
      openrouterApiKey,
      ollamaBaseUrl,
    }),
    temperature: 0,
    maxOutputTokens: 1024,
    prompt,
  });
  return r.text;
}

// ── Types ───────────────────────────────────────────────

interface GradedQuestion {
  file: string;
  moduleTitle: string;
  moduleIndex: number;
  lessonTitle: string;
  lessonIndex: number;
  questionType: string;
  question: string;
  givenAnswer: any;
  choices?: any[];
  slots?: string[];
  explanation?: string;
  lessonContent?: string;
  // Judge verdict
  correct: boolean;
  judgeExplanation: string;
  expectedAnswer?: string;
}

interface FileResult {
  file: string;
  totalLessons: number;
  successfulLessons: number;
  gradedQuestions: GradedQuestion[];
  correct: number;
  incorrect: number;
  accuracy: number;
  generationTimeMs: number;
  judgingTimeMs: number;
}

// ── Helpers ─────────────────────────────────────────────

async function getContent(
  filePath: string
): Promise<{ content: string; ocrTimeMs: number }> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const start = Date.now();
    const result = await ocr(filePath);
    const ocrTimeMs = Date.now() - start;
    const content = result.pages
      .filter((p) => p.success)
      .map((p) => p.content)
      .join("\n\n");
    console.log(
      `  OCR: ${result.successfulPages}/${result.pages.length} pages, ${content.length} chars (${(ocrTimeMs / 1000).toFixed(1)}s)`
    );
    return { content, ocrTimeMs };
  }
  const { readFileSync } = await import("fs");
  return { content: readFileSync(filePath, "utf-8"), ocrTimeMs: 0 };
}

function formatAnswer(answer: any, questionType: string, choices?: any[]): string {
  if (questionType === "multiple-choice" && choices) {
    return `Index ${answer} → "${choices[answer]}"`;
  }
  if (questionType === "flow-diagram") {
    return `Ordering: [${answer}]`;
  }
  return String(answer);
}

// ── Judge ───────────────────────────────────────────────

function buildQuestionContext(q: {
  question: string;
  questionType: string;
  answer: any;
  choices?: any[];
  explanation?: string;
  slots?: string[];
}): string {
  if (q.questionType === "multiple-choice") {
    return `Question: ${q.question}
Choices: ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Given answer: index ${q.answer} → "${q.choices![q.answer]}"
${q.explanation ? `Explanation given: ${q.explanation}` : ""}`;
  } else if (q.questionType === "true-false") {
    return `Statement: ${q.question}
Given answer: ${q.answer}`;
  } else if (q.questionType === "short-answer") {
    return `Question: ${q.question}
Given answer: ${q.answer}`;
  } else if (q.questionType === "flow-diagram") {
    return `Question: ${q.question}
Choices (items to order): ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Slots: ${q.slots!.join(", ")}
Given answer (slot→choice mapping): [${q.answer}]
This means: ${q.slots!.map((slot: string, i: number) => `${slot} → "${q.choices![q.answer[i]]}"`).join(", ")}`;
  }
  return `Question: ${q.question}\nGiven answer: ${q.answer}`;
}

function parseJudgeResponse(text: string): { correct: boolean; explanation: string; expectedAnswer?: string } | null {
  try {
    const parsed = parseJSON(text);
    return {
      correct: !!parsed.correct,
      explanation: parsed.explanation ?? "No explanation",
      expectedAnswer: parsed.expectedAnswer,
    };
  } catch {
    const lower = text.toLowerCase();
    const looksCorrect = lower.includes('"correct": true') || lower.includes('"correct":true');
    const looksIncorrect = lower.includes('"correct": false') || lower.includes('"correct":false');
    if (looksCorrect || looksIncorrect) {
      return {
        correct: looksCorrect && !looksIncorrect,
        explanation: text.substring(0, 300),
      };
    }
    return null;
  }
}

async function judgeQuestion(
  q: {
    question: string;
    questionType: string;
    answer: any;
    choices?: any[];
    explanation?: string;
    content: string; // lesson content (not source)
    slots?: string[];
  },
  sourceContent: string
): Promise<{ correct: boolean; explanation: string; expectedAnswer?: string }> {
  const questionContext = buildQuestionContext(q);

  const resultText = await judge(`You are an answer-correctness judge. Given a question, its answer, and the source content the question was derived from, determine if the answer is CORRECT.

${questionContext}

Source content (the question was generated from this):
${sourceContent}

Follow these steps:
1. First, determine what the correct answer should be based ONLY on the source content.
2. Then, compare the given answer to your determined correct answer.
3. If they match (same meaning, minor wording differences OK), the answer is correct.

Rules:
- For short-answer: the answer must be factually correct and supported by the source. Minor wording differences and paraphrasing are OK if the meaning is correct.
- For true-false: the boolean must be correct based on the source. Read the statement carefully — if it says something false and the answer is false, that IS correct.
- For multiple-choice: the selected choice must be the correct one. Check that the answer INDEX actually points to the right choice.
- For flow-diagram: the ordering must reflect the correct sequence from the source.

CRITICAL: Your "correct" field MUST be consistent with your explanation. If your reasoning concludes the answer is right, you MUST set "correct": true. Do NOT contradict yourself.

Respond ONLY with JSON:
{"correct": true, "explanation": "Brief reason"}

Or if wrong:
{"correct": false, "explanation": "What's wrong", "expectedAnswer": "What the correct answer should be"}`);

  const firstVerdict = parseJudgeResponse(resultText);
  if (!firstVerdict) {
    console.warn(`  ⚠️  Judge parse failed. Raw: ${resultText.substring(0, 200)}`);
    return { correct: false, explanation: "Judge failed to parse response" };
  }

  // If the first judge says correct, accept it immediately
  if (firstVerdict.correct) {
    return firstVerdict;
  }

  // Re-judge failures with a verification pass to catch self-contradictions
  const verifyText = await judge(`A judge evaluated a question and marked the answer as INCORRECT. Review the judge's reasoning and determine if the verdict is actually right.

Question details:
${questionContext}

Source content:
${sourceContent}

Judge's explanation for marking it INCORRECT:
${firstVerdict.explanation}

Based on the source content and the judge's own reasoning:
- Is the given answer actually correct or incorrect?
- Did the judge contradict itself (reasoning says correct but verdict says incorrect)?

Respond ONLY with JSON:
{"correct": true, "explanation": "The answer is actually correct because..."}
or
{"correct": false, "explanation": "The answer is genuinely incorrect because..."}`);

  const verifyVerdict = parseJudgeResponse(verifyText);
  if (verifyVerdict) {
    return verifyVerdict;
  }

  // Fall back to first verdict if verification fails to parse
  return firstVerdict;
}

// ── Per-file processing ─────────────────────────────────

async function processFile(filePath: string): Promise<FileResult> {
  const fileName = basename(filePath);
  console.log(`\n📄 ${fileName}`);
  console.log("─".repeat(60));

  const { content, ocrTimeMs } = await getContent(filePath);

  // Generate course
  const genStart = Date.now();
  const course = await createCourse({
    content,
    apiKey: apiKey!,
    model,
    validateStructure: true,
    validateContent: true,
    retryFailures: true,
    maxRetries: 3,
  });
  const generationTimeMs = Date.now() - genStart;

  // Collect all successful lessons
  const lessons: Array<{
    moduleTitle: string;
    moduleIndex: number;
    lessonIndex: number;
    data: any;
  }> = [];
  let totalLessons = 0;

  course.modules.forEach((mod, mi) => {
    mod.lessons.forEach((lr, li) => {
      totalLessons++;
      if (lr.success) {
        lessons.push({ moduleTitle: mod.title, moduleIndex: mi, lessonIndex: li, data: lr.data });
      }
    });
  });

  console.log(
    `  Generated: ${lessons.length}/${totalLessons} lessons (${(generationTimeMs / 1000).toFixed(1)}s)`
  );

  // Filter to requested question types if --types is set
  const lessonsToJudge = typesFilter.length > 0
    ? lessons.filter((l) => typesFilter.includes(l.data.questionType))
    : lessons;

  // Judge all answers in parallel
  const judgeStart = Date.now();

  const gradePromises = lessonsToJudge.map(async (lesson) => {
    const verdict = await judgeQuestion(
      {
        question: lesson.data.question,
        questionType: lesson.data.questionType,
        answer: lesson.data.answer,
        choices: lesson.data.choices,
        explanation: lesson.data.explanation,
        content: lesson.data.content,
        slots: lesson.data.slots,
      },
      content
    );

    return {
      file: fileName,
      moduleTitle: lesson.moduleTitle,
      moduleIndex: lesson.moduleIndex,
      lessonTitle: lesson.data.title,
      lessonIndex: lesson.lessonIndex,
      questionType: lesson.data.questionType,
      question: lesson.data.question,
      givenAnswer: lesson.data.answer,
      choices: lesson.data.choices,
      slots: lesson.data.slots,
      explanation: lesson.data.explanation,
      lessonContent: lesson.data.content,
      correct: verdict.correct,
      judgeExplanation: verdict.explanation,
      expectedAnswer: verdict.expectedAnswer,
    } as GradedQuestion;
  });

  const gradedQuestions = await Promise.all(gradePromises);
  const judgingTimeMs = Date.now() - judgeStart;

  const correct = gradedQuestions.filter((q) => q.correct).length;
  const incorrect = gradedQuestions.filter((q) => !q.correct).length;
  const accuracy = gradedQuestions.length > 0 ? correct / gradedQuestions.length : 0;

  // Print per-question results
  for (const q of gradedQuestions) {
    const icon = q.correct ? "✅" : "❌";
    const answerStr = formatAnswer(q.givenAnswer, q.questionType, q.choices);
    console.log(
      `  ${icon} [M${q.moduleIndex + 1}L${q.lessonIndex + 1}] (${q.questionType.padEnd(16)}) ${q.question.substring(0, 70)}${q.question.length > 70 ? "..." : ""}`
    );
    if (!q.correct) {
      console.log(`     Answer: ${answerStr}`);
      console.log(`     Judge:  ${q.judgeExplanation}`);
      if (q.expectedAnswer) {
        console.log(`     Expected: ${q.expectedAnswer}`);
      }
    }
  }

  console.log(
    `\n  Accuracy: ${correct}/${gradedQuestions.length} (${Math.round(accuracy * 100)}%) — judging took ${(judgingTimeMs / 1000).toFixed(1)}s`
  );

  return {
    file: fileName,
    totalLessons,
    successfulLessons: lessons.length,
    gradedQuestions,
    correct,
    incorrect,
    accuracy,
    generationTimeMs,
    judgingTimeMs,
  };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  // Determine files: CLI args or all PDFs in data/pdfs/
  let files: string[];
  if (inputFiles.length > 0) {
    files = inputFiles;
  } else {
    files = readdirSync(PDFS_DIR)
      .filter((f) => f.endsWith(".pdf"))
      .map((f) => resolve(PDFS_DIR, f));
  }

  const displayModel = model ?? DEFAULT_MODEL + " (default)";
  console.log(`\n🏁 Answer Correctness Benchmark: ${tag}`);
  console.log(`   Generation model: ${displayModel}`);
  console.log(`   Judge model:      ${judgeModel}`);
  console.log(`   Files: ${files.length}`);
  console.log(`   Iterations: ${iterations}`);
  if (typesFilter.length > 0) console.log(`   Types filter:     ${typesFilter.join(", ")}`);
  console.log("═".repeat(60));

  const allIterationResults: FileResult[][] = [];
  const startTime = Date.now();

  for (let iter = 0; iter < iterations; iter++) {
    if (iterations > 1) {
      console.log(`\n${"━".repeat(60)}`);
      console.log(`ITERATION ${iter + 1}/${iterations}`);
      console.log("━".repeat(60));
    }

    const results: FileResult[] = [];

    // Process files sequentially to avoid rate limits on the judge
    for (const file of files) {
      if (!existsSync(file)) {
        console.error(`File not found: ${file}`);
        continue;
      }
      try {
        const result = await processFile(file);
        results.push(result);
      } catch (error: any) {
        console.error(`  ❌ FAILED ${basename(file)}: ${error.message}`);
        results.push({
          file: basename(file),
          totalLessons: 0,
          successfulLessons: 0,
          gradedQuestions: [],
          correct: 0,
          incorrect: 0,
          accuracy: 0,
          generationTimeMs: 0,
          judgingTimeMs: 0,
        });
      }
    }

    allIterationResults.push(results);

    if (iterations > 1) {
      const iterGraded = results.flatMap((r) => r.gradedQuestions);
      const iterCorrect = iterGraded.filter((q) => q.correct).length;
      const iterTotal = iterGraded.length;
      const p = iterTotal > 0 ? `${Math.round((iterCorrect / iterTotal) * 100)}%` : "N/A";
      console.log(`  Iteration ${iter + 1}: ${iterTotal} graded — Accuracy: ${p}`);
    }
  }

  // Flatten all iterations into one results array for aggregate stats
  const results = allIterationResults.flat();
  const totalTimeMs = Date.now() - startTime;

  // ── Aggregate ──
  const allGraded = results.flatMap((r) => r.gradedQuestions);
  const totalCorrect = allGraded.filter((q) => q.correct).length;
  const totalIncorrect = allGraded.filter((q) => !q.correct).length;
  const totalGraded = allGraded.length;
  const overallAccuracy = totalGraded > 0 ? totalCorrect / totalGraded : 0;

  console.log("\n" + "═".repeat(60));
  console.log(`AGGREGATE RESULTS${iterations > 1 ? ` (${iterations} iterations)` : ""}`);
  console.log("═".repeat(60));
  console.log(`  Total time:      ${(totalTimeMs / 1000).toFixed(1)}s`);
  if (iterations > 1) console.log(`  Iterations:       ${iterations}`);
  console.log(`  Questions graded: ${totalGraded}`);
  console.log(`  Correct:          ${totalCorrect} (${Math.round(overallAccuracy * 100)}%)`);
  console.log(`  Incorrect:        ${totalIncorrect}`);

  // Per-file table
  console.log("\n  Per-file breakdown:");
  console.log("  " + "-".repeat(64));
  console.log(
    "  " +
      "File".padEnd(42) +
      "Correct".padEnd(10) +
      "Wrong".padEnd(8) +
      "Accuracy"
  );
  console.log("  " + "-".repeat(64));
  for (const r of results) {
    const name =
      r.file.length > 40 ? r.file.substring(0, 37) + "..." : r.file;
    const total = r.correct + r.incorrect;
    const pct = total > 0 ? `${Math.round(r.accuracy * 100)}%` : "N/A";
    console.log(
      `  ${name.padEnd(40)}  ${String(r.correct).padEnd(8)}  ${String(r.incorrect).padEnd(6)}  ${pct}`
    );
  }

  // Per question-type breakdown
  const byType = new Map<string, { correct: number; total: number }>();
  for (const q of allGraded) {
    const entry = byType.get(q.questionType) ?? { correct: 0, total: 0 };
    entry.total++;
    if (q.correct) entry.correct++;
    byType.set(q.questionType, entry);
  }

  console.log("\n  Per question-type breakdown:");
  console.log("  " + "-".repeat(44));
  console.log(
    "  " + "Type".padEnd(20) + "Correct".padEnd(10) + "Total".padEnd(8) + "Accuracy"
  );
  console.log("  " + "-".repeat(44));
  for (const [type, stats] of byType.entries()) {
    const pct = `${Math.round((stats.correct / stats.total) * 100)}%`;
    console.log(
      `  ${type.padEnd(18)}  ${String(stats.correct).padEnd(8)}  ${String(stats.total).padEnd(6)}  ${pct}`
    );
  }

  // List all incorrect answers
  const incorrectAnswers = allGraded.filter((q) => !q.correct);
  if (incorrectAnswers.length > 0) {
    console.log("\n" + "─".repeat(60));
    console.log("INCORRECT ANSWERS");
    console.log("─".repeat(60));
    for (const q of incorrectAnswers) {
      const answerStr = formatAnswer(q.givenAnswer, q.questionType, q.choices);
      console.log(`\n  ❌ ${q.file}`);
      console.log(`     Module: "${q.moduleTitle}" / Lesson: "${q.lessonTitle}"`);
      console.log(`     Type: ${q.questionType}`);
      console.log(`     Q: ${q.question}`);
      console.log(`     A: ${answerStr}`);
      console.log(`     Judge: ${q.judgeExplanation}`);
      if (q.expectedAnswer) {
        console.log(`     Expected: ${q.expectedAnswer}`);
      }
    }
  } else {
    console.log("\n  🎉 All answers correct!");
  }

  // ── Save JSON ──
  if (!existsSync(BENCHMARKS_DIR)) {
    mkdirSync(BENCHMARKS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outputPath = resolve(BENCHMARKS_DIR, `${tag}-${timestamp}.json`);

  const output = {
    tag,
    timestamp: new Date().toISOString(),
    generationModel: model ?? DEFAULT_MODEL,
    judgeModel,
    iterations,
    totalTimeMs,
    aggregate: {
      totalGraded,
      correct: totalCorrect,
      incorrect: totalIncorrect,
      accuracy: `${Math.round(overallAccuracy * 100)}%`,
      byQuestionType: Object.fromEntries(
        [...byType.entries()].map(([type, stats]) => [
          type,
          {
            correct: stats.correct,
            total: stats.total,
            accuracy: `${Math.round((stats.correct / stats.total) * 100)}%`,
          },
        ])
      ),
    },
    results: results.map((r) => ({
      file: r.file,
      totalLessons: r.totalLessons,
      successfulLessons: r.successfulLessons,
      correct: r.correct,
      incorrect: r.incorrect,
      accuracy: `${Math.round(r.accuracy * 100)}%`,
      generationTimeMs: r.generationTimeMs,
      judgingTimeMs: r.judgingTimeMs,
      gradedQuestions: r.gradedQuestions,
    })),
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
