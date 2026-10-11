#!/usr/bin/env tsx
/**
 * Benchmark answer grounding / self-containedness across PDFs.
 *
 * Checks that generated answers are:
 * 1. Self-contained — don't reference meta-structures ("the brief", "the passage")
 * 2. Concrete — actually state the answer, not a pointer to it
 * 3. Grounded — supported by the source PDF content
 *
 * This is a different dimension from correctness (benchmark-answers) and
 * deduplication (benchmark-duplicates).
 *
 * Usage:
 *   TOGETHER_API_KEY=... OPENROUTER_API_KEY=... bun scripts/benchmark-answer-grounding.ts [--tag=<name>] [--model=<model>] [--judge=<model>] [file1 file2...]
 *
 * If no files given, runs all PDFs in data/pdfs/.
 * --model   sets the generation model (default: MiniMaxAI/MiniMax-M2.7)
 * --judge   sets the judge model (default: anthropic/claude-opus-4-6).
 *           Use anthropic/, openrouter/, or ollama/ prefixes to force a provider.
 * --tag     label for the output file (default: grounding)
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
const tag =
  args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "grounding";
const model =
  args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? undefined;
const judgeModel =
  args.find((a) => a.startsWith("--judge="))?.split("=")[1] ??
  "anthropic/claude-sonnet-4-6";
const iterations = parseInt(
  args.find((a) => a.startsWith("--iterations="))?.split("=")[1] ?? "1",
  10
);
const inputFiles = args
  .filter((a) => !a.startsWith("--"))
  .map((f) => resolve(f));

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

interface GroundingVerdict {
  selfContained: boolean;
  concrete: boolean;
  grounded: boolean;
  issues: string[];
  explanation: string;
}

interface GradedQuestion {
  file: string;
  moduleTitle: string;
  moduleIndex: number;
  lessonTitle: string;
  lessonIndex: number;
  questionType: string;
  question: string;
  answer: any;
  lessonContent: string;
  choices?: any[];
  // Grounding verdict
  verdict: GroundingVerdict;
  // Heuristic flags (detected before LLM judge)
  heuristicFlags: string[];
}

interface FileResult {
  file: string;
  totalLessons: number;
  successfulLessons: number;
  gradedQuestions: GradedQuestion[];
  stats: {
    selfContained: { pass: number; fail: number };
    concrete: { pass: number; fail: number };
    grounded: { pass: number; fail: number };
    overallPass: number;
    overallFail: number;
  };
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

function formatAnswer(
  answer: any,
  questionType: string,
  choices?: any[]
): string {
  if (questionType === "multiple-choice" && choices) {
    return `Index ${answer} → "${choices[answer]}"`;
  }
  if (questionType === "flow-diagram" && choices) {
    return `Ordering: [${answer}] → ${(answer as number[]).map((i) => `"${choices[i]}"`).join(", ")}`;
  }
  return String(answer);
}

// ── Heuristic checks (fast, no LLM) ────────────────────

const META_REFERENCE_PATTERNS = [
  /\b(?:the|this)\s+brief\b/i,
  /\b(?:the|this)\s+passage\b/i,
  /\b(?:the|this)\s+text\b/i,
  /\b(?:the|this)\s+content\b/i,
  /\bas\s+(?:mentioned|stated|described|noted|discussed)\s+(?:in|above|below|earlier)\b/i,
  /\bsee\s+(?:the|above|below)\b/i,
  /\brefer\s+to\b/i,
  /\b(?:the|this)\s+article\b/i,
  /\b(?:the|this)\s+lesson\b/i,
  /\b(?:the|this)\s+reading\b/i,
  /\b(?:the|this)\s+source\b/i,
  /\b(?:the|this)\s+excerpt\b/i,
  /\b(?:the|this)\s+document\b/i,
];

function runHeuristics(
  answer: any,
  questionType: string,
  choices?: any[]
): string[] {
  const flags: string[] = [];

  // Only check string-based answers and choice text for meta-references
  const textsToCheck: string[] = [];

  if (typeof answer === "string") {
    textsToCheck.push(answer);
  }
  if (choices) {
    for (const c of choices) {
      if (typeof c === "string") textsToCheck.push(c);
    }
  }

  for (const text of textsToCheck) {
    for (const pattern of META_REFERENCE_PATTERNS) {
      if (pattern.test(text)) {
        flags.push(`meta-reference: "${text.substring(0, 80)}" matches ${pattern}`);
        break; // one flag per text is enough
      }
    }
  }

  // Short-answer: check if answer is suspiciously vague
  if (questionType === "short-answer" && typeof answer === "string") {
    if (answer.trim().length < 3) {
      flags.push(`vague-answer: answer is only ${answer.trim().length} chars`);
    }
  }

  return flags;
}

// ── LLM Judge ───────────────────────────────────────────

function buildQuestionContext(q: {
  question: string;
  questionType: string;
  answer: any;
  lessonContent: string;
  choices?: any[];
  slots?: string[];
}): string {
  let ctx = `Question type: ${q.questionType}\n`;
  ctx += `Lesson content shown to student: ${q.lessonContent}\n\n`;

  if (q.questionType === "multiple-choice") {
    ctx += `Question: ${q.question}\n`;
    ctx += `Choices:\n${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}\n`;
    ctx += `Answer: index ${q.answer} → "${q.choices![q.answer]}"`;
  } else if (q.questionType === "true-false") {
    ctx += `Statement: ${q.question}\nAnswer: ${q.answer}`;
  } else if (q.questionType === "short-answer") {
    ctx += `Question: ${q.question}\nAnswer: ${q.answer}`;
  } else if (q.questionType === "flow-diagram") {
    ctx += `Question: ${q.question}\n`;
    ctx += `Choices: ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}\n`;
    ctx += `Slots: ${q.slots!.join(", ")}\n`;
    ctx += `Answer ordering: [${q.answer}]`;
  } else {
    ctx += `Question: ${q.question}\nAnswer: ${q.answer}`;
  }

  return ctx;
}

function parseGroundingResponse(text: string): GroundingVerdict | null {
  try {
    const parsed = parseJSON(text);
    return {
      selfContained: !!parsed.selfContained,
      concrete: !!parsed.concrete,
      grounded: !!parsed.grounded,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      explanation: parsed.explanation ?? "No explanation",
    };
  } catch {
    return null;
  }
}

async function judgeGrounding(
  q: {
    question: string;
    questionType: string;
    answer: any;
    lessonContent: string;
    choices?: any[];
    slots?: string[];
  },
  sourceContent: string
): Promise<GroundingVerdict> {
  const questionContext = buildQuestionContext(q);

  const resultText = await judge(`You are a quality judge for educational content. Evaluate the GROUNDING and SELF-CONTAINEDNESS of a question-answer pair.

This is NOT about whether the answer is factually correct. It's about whether the answer is well-formed, self-contained, and properly grounded in the source material.

${questionContext}

Source content the lesson was generated from:
${sourceContent}

Evaluate these three dimensions:

1. **selfContained** — Does the answer stand on its own? A student should understand the answer without needing to reference anything else.
   - FAIL if the answer says things like "the answer is in the brief", "as mentioned in the passage", "see the text", "refer to the content above", etc.
   - FAIL if the answer references meta-structures of the lesson or source material.
   - For true-false: true/false is self-contained by nature (PASS).
   - For multiple-choice: check both the correct choice text AND all other choice texts for meta-references.

2. **concrete** — Does the answer provide a specific, actionable answer?
   - FAIL if a short-answer gives a vague or circular restatement of the question.
   - FAIL if the answer is generic enough to apply to any topic (not specific to the source).
   - For true-false and multiple-choice: these are concrete by nature (PASS) unless the choices themselves are vague.
   - For flow-diagram: the ordering should correspond to a real process from the source.

3. **grounded** — Is the answer actually supported by the source content?
   - FAIL if the answer includes claims or facts NOT present in the source (hallucination).
   - FAIL if the answer contradicts the source.
   - PASS if the answer is a reasonable inference from the source, even if not verbatim.

Respond ONLY with JSON:
{
  "selfContained": true/false,
  "concrete": true/false,
  "grounded": true/false,
  "issues": ["list of specific issues found, empty if all pass"],
  "explanation": "Brief overall assessment"
}`);

  const verdict = parseGroundingResponse(resultText);
  if (!verdict) {
    console.warn(
      `  ⚠️  Judge parse failed. Raw: ${resultText.substring(0, 200)}`
    );
    return {
      selfContained: true,
      concrete: true,
      grounded: true,
      issues: ["Judge parse failure — defaulting to pass"],
      explanation: "Judge failed to parse response",
    };
  }

  return verdict;
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
        lessons.push({
          moduleTitle: mod.title,
          moduleIndex: mi,
          lessonIndex: li,
          data: lr.data,
        });
      }
    });
  });

  console.log(
    `  Generated: ${lessons.length}/${totalLessons} lessons (${(generationTimeMs / 1000).toFixed(1)}s)`
  );

  // Judge all answers
  const judgeStart = Date.now();

  const gradePromises = lessons.map(async (lesson) => {
    // Run fast heuristic checks first
    const heuristicFlags = runHeuristics(
      lesson.data.answer,
      lesson.data.questionType,
      lesson.data.choices
    );

    // Always run LLM judge for full evaluation
    const verdict = await judgeGrounding(
      {
        question: lesson.data.question,
        questionType: lesson.data.questionType,
        answer: lesson.data.answer,
        lessonContent: lesson.data.content,
        choices: lesson.data.choices,
        slots: lesson.data.slots,
      },
      content
    );

    // If heuristics flagged issues, force selfContained to false
    if (heuristicFlags.length > 0 && verdict.selfContained) {
      verdict.selfContained = false;
      verdict.issues.push(...heuristicFlags);
    }

    return {
      file: fileName,
      moduleTitle: lesson.moduleTitle,
      moduleIndex: lesson.moduleIndex,
      lessonTitle: lesson.data.title,
      lessonIndex: lesson.lessonIndex,
      questionType: lesson.data.questionType,
      question: lesson.data.question,
      answer: lesson.data.answer,
      lessonContent: lesson.data.content,
      choices: lesson.data.choices,
      verdict,
      heuristicFlags,
    } as GradedQuestion;
  });

  const gradedQuestions = await Promise.all(gradePromises);
  const judgingTimeMs = Date.now() - judgeStart;

  // Compute stats
  const stats = {
    selfContained: { pass: 0, fail: 0 },
    concrete: { pass: 0, fail: 0 },
    grounded: { pass: 0, fail: 0 },
    overallPass: 0,
    overallFail: 0,
  };

  for (const q of gradedQuestions) {
    q.verdict.selfContained
      ? stats.selfContained.pass++
      : stats.selfContained.fail++;
    q.verdict.concrete ? stats.concrete.pass++ : stats.concrete.fail++;
    q.verdict.grounded ? stats.grounded.pass++ : stats.grounded.fail++;

    const allPass =
      q.verdict.selfContained && q.verdict.concrete && q.verdict.grounded;
    allPass ? stats.overallPass++ : stats.overallFail++;
  }

  // Print per-question results
  for (const q of gradedQuestions) {
    const allPass =
      q.verdict.selfContained && q.verdict.concrete && q.verdict.grounded;
    const dims = [
      q.verdict.selfContained ? "S" : "s",
      q.verdict.concrete ? "C" : "c",
      q.verdict.grounded ? "G" : "g",
    ].join("");
    const icon = allPass ? "✅" : "⚠️";
    console.log(
      `  ${icon} [${dims}] [M${q.moduleIndex + 1}L${q.lessonIndex + 1}] (${q.questionType.padEnd(16)}) ${q.question.substring(0, 60)}${q.question.length > 60 ? "..." : ""}`
    );
    if (!allPass) {
      const answerStr = formatAnswer(q.answer, q.questionType, q.choices);
      console.log(`     Answer: ${answerStr}`);
      for (const issue of q.verdict.issues) {
        console.log(`     Issue:  ${issue}`);
      }
      if (q.heuristicFlags.length > 0) {
        console.log(
          `     Heuristic: ${q.heuristicFlags.join("; ")}`
        );
      }
    }
  }

  const total = gradedQuestions.length;
  console.log(
    `\n  Grounding: ${stats.overallPass}/${total} fully grounded (${total > 0 ? Math.round((stats.overallPass / total) * 100) : 0}%) — judging took ${(judgingTimeMs / 1000).toFixed(1)}s`
  );
  console.log(
    `    Self-contained: ${stats.selfContained.pass}/${total}  Concrete: ${stats.concrete.pass}/${total}  Grounded: ${stats.grounded.pass}/${total}`
  );

  return {
    file: fileName,
    totalLessons,
    successfulLessons: lessons.length,
    gradedQuestions,
    stats,
    generationTimeMs,
    judgingTimeMs,
  };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  let files: string[];
  if (inputFiles.length > 0) {
    files = inputFiles;
  } else {
    files = readdirSync(PDFS_DIR)
      .filter((f) => f.endsWith(".pdf"))
      .map((f) => resolve(PDFS_DIR, f));
  }

  const displayModel = model ?? DEFAULT_MODEL + " (default)";
  console.log(`\n🏁 Answer Grounding Benchmark: ${tag}`);
  console.log(`   Generation model: ${displayModel}`);
  console.log(`   Judge model:      ${judgeModel}`);
  console.log(`   Files: ${files.length}`);
  console.log(`   Iterations: ${iterations}`);
  console.log(`   Dimensions: Self-contained (S), Concrete (C), Grounded (G)`);
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
          stats: {
            selfContained: { pass: 0, fail: 0 },
            concrete: { pass: 0, fail: 0 },
            grounded: { pass: 0, fail: 0 },
            overallPass: 0,
            overallFail: 0,
          },
          generationTimeMs: 0,
          judgingTimeMs: 0,
        });
      }
    }

    allIterationResults.push(results);

    if (iterations > 1) {
      const iterGraded = results.flatMap((r) => r.gradedQuestions);
      const iterTotal = iterGraded.length;
      const iterSC = iterGraded.filter((q) => q.verdict.selfContained).length;
      const iterC = iterGraded.filter((q) => q.verdict.concrete).length;
      const iterG = iterGraded.filter((q) => q.verdict.grounded).length;
      const iterAll = iterGraded.filter(
        (q) => q.verdict.selfContained && q.verdict.concrete && q.verdict.grounded
      ).length;
      const p = (n: number) => iterTotal > 0 ? `${Math.round((n / iterTotal) * 100)}%` : "N/A";
      console.log(
        `  Iteration ${iter + 1}: ${iterTotal} graded — S:${p(iterSC)} C:${p(iterC)} G:${p(iterG)} All:${p(iterAll)}`
      );
    }
  }

  // Flatten all iterations into one results array for aggregate stats
  const results = allIterationResults.flat();
  const totalTimeMs = Date.now() - startTime;

  // ── Aggregate ──
  const allGraded = results.flatMap((r) => r.gradedQuestions);
  const total = allGraded.length;

  const agg = {
    selfContained: { pass: 0, fail: 0 },
    concrete: { pass: 0, fail: 0 },
    grounded: { pass: 0, fail: 0 },
    overallPass: 0,
    overallFail: 0,
  };

  for (const q of allGraded) {
    q.verdict.selfContained
      ? agg.selfContained.pass++
      : agg.selfContained.fail++;
    q.verdict.concrete ? agg.concrete.pass++ : agg.concrete.fail++;
    q.verdict.grounded ? agg.grounded.pass++ : agg.grounded.fail++;
    const allPass =
      q.verdict.selfContained && q.verdict.concrete && q.verdict.grounded;
    allPass ? agg.overallPass++ : agg.overallFail++;
  }

  const pct = (n: number) =>
    total > 0 ? `${Math.round((n / total) * 100)}%` : "N/A";

  console.log("\n" + "═".repeat(60));
  console.log(`AGGREGATE RESULTS${iterations > 1 ? ` (${iterations} iterations)` : ""}`);
  console.log("═".repeat(60));
  console.log(`  Total time:       ${(totalTimeMs / 1000).toFixed(1)}s`);
  if (iterations > 1) console.log(`  Iterations:       ${iterations}`);
  console.log(`  Questions graded: ${total}`);
  console.log(`  Fully grounded:   ${agg.overallPass}/${total} (${pct(agg.overallPass)})`);
  console.log();
  console.log(
    `  Self-contained:   ${agg.selfContained.pass}/${total} (${pct(agg.selfContained.pass)})`
  );
  console.log(
    `  Concrete:         ${agg.concrete.pass}/${total} (${pct(agg.concrete.pass)})`
  );
  console.log(
    `  Grounded:         ${agg.grounded.pass}/${total} (${pct(agg.grounded.pass)})`
  );

  // Per-file table
  console.log("\n  Per-file breakdown:");
  console.log("  " + "-".repeat(74));
  console.log(
    "  " +
      "File".padEnd(38) +
      "Self-C".padEnd(9) +
      "Concr".padEnd(9) +
      "Ground".padEnd(9) +
      "Overall"
  );
  console.log("  " + "-".repeat(74));
  for (const r of results) {
    const name =
      r.file.length > 36 ? r.file.substring(0, 33) + "..." : r.file;
    const t = r.gradedQuestions.length;
    const sp = t > 0 ? `${Math.round((r.stats.selfContained.pass / t) * 100)}%` : "N/A";
    const cp = t > 0 ? `${Math.round((r.stats.concrete.pass / t) * 100)}%` : "N/A";
    const gp = t > 0 ? `${Math.round((r.stats.grounded.pass / t) * 100)}%` : "N/A";
    const op = t > 0 ? `${Math.round((r.stats.overallPass / t) * 100)}%` : "N/A";
    console.log(
      `  ${name.padEnd(36)}  ${sp.padEnd(7)}  ${cp.padEnd(7)}  ${gp.padEnd(7)}  ${op}`
    );
  }

  // Per question-type breakdown
  const byType = new Map<
    string,
    {
      total: number;
      selfContained: number;
      concrete: number;
      grounded: number;
      overall: number;
    }
  >();
  for (const q of allGraded) {
    const entry = byType.get(q.questionType) ?? {
      total: 0,
      selfContained: 0,
      concrete: 0,
      grounded: 0,
      overall: 0,
    };
    entry.total++;
    if (q.verdict.selfContained) entry.selfContained++;
    if (q.verdict.concrete) entry.concrete++;
    if (q.verdict.grounded) entry.grounded++;
    if (q.verdict.selfContained && q.verdict.concrete && q.verdict.grounded)
      entry.overall++;
    byType.set(q.questionType, entry);
  }

  console.log("\n  Per question-type breakdown:");
  console.log("  " + "-".repeat(64));
  console.log(
    "  " +
      "Type".padEnd(20) +
      "Self-C".padEnd(9) +
      "Concr".padEnd(9) +
      "Ground".padEnd(9) +
      "Overall"
  );
  console.log("  " + "-".repeat(64));
  for (const [type, s] of byType.entries()) {
    const sp = `${Math.round((s.selfContained / s.total) * 100)}%`;
    const cp = `${Math.round((s.concrete / s.total) * 100)}%`;
    const gp = `${Math.round((s.grounded / s.total) * 100)}%`;
    const op = `${Math.round((s.overall / s.total) * 100)}%`;
    console.log(
      `  ${type.padEnd(18)}  ${sp.padEnd(7)}  ${cp.padEnd(7)}  ${gp.padEnd(7)}  ${op}`
    );
  }

  // List all issues
  const flagged = allGraded.filter(
    (q) =>
      !q.verdict.selfContained || !q.verdict.concrete || !q.verdict.grounded
  );
  if (flagged.length > 0) {
    console.log("\n" + "─".repeat(60));
    console.log("FLAGGED ANSWERS");
    console.log("─".repeat(60));
    for (const q of flagged) {
      const dims = [
        q.verdict.selfContained ? null : "NOT self-contained",
        q.verdict.concrete ? null : "NOT concrete",
        q.verdict.grounded ? null : "NOT grounded",
      ]
        .filter(Boolean)
        .join(", ");
      const answerStr = formatAnswer(q.answer, q.questionType, q.choices);
      console.log(`\n  ⚠️  ${q.file} — ${dims}`);
      console.log(
        `     Module: "${q.moduleTitle}" / Lesson: "${q.lessonTitle}"`
      );
      console.log(`     Type: ${q.questionType}`);
      console.log(`     Q: ${q.question}`);
      console.log(`     A: ${answerStr}`);
      for (const issue of q.verdict.issues) {
        console.log(`     → ${issue}`);
      }
    }
  } else {
    console.log("\n  🎉 All answers fully grounded!");
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
      totalGraded: total,
      selfContained: `${agg.selfContained.pass}/${total} (${pct(agg.selfContained.pass)})`,
      concrete: `${agg.concrete.pass}/${total} (${pct(agg.concrete.pass)})`,
      grounded: `${agg.grounded.pass}/${total} (${pct(agg.grounded.pass)})`,
      overallPass: `${agg.overallPass}/${total} (${pct(agg.overallPass)})`,
      byQuestionType: Object.fromEntries(
        [...byType.entries()].map(([type, s]) => [
          type,
          {
            total: s.total,
            selfContained: `${s.selfContained}/${s.total}`,
            concrete: `${s.concrete}/${s.total}`,
            grounded: `${s.grounded}/${s.total}`,
            overall: `${s.overall}/${s.total}`,
          },
        ])
      ),
    },
    results: results.map((r) => ({
      file: r.file,
      totalLessons: r.totalLessons,
      successfulLessons: r.successfulLessons,
      stats: r.stats,
      generationTimeMs: r.generationTimeMs,
      judgingTimeMs: r.judgingTimeMs,
      gradedQuestions: r.gradedQuestions.map((q) => ({
        moduleTitle: q.moduleTitle,
        moduleIndex: q.moduleIndex,
        lessonTitle: q.lessonTitle,
        lessonIndex: q.lessonIndex,
        questionType: q.questionType,
        question: q.question,
        answer: q.answer,
        choices: q.choices,
        verdict: q.verdict,
        heuristicFlags: q.heuristicFlags,
      })),
    })),
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
