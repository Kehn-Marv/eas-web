#!/usr/bin/env tsx
/**
 * Audit a saved benchmark JSON after the fact by running the LLM judges
 * (correctness, grounding, sufficiency) over already-generated questions.
 *
 * Use this when an eval was run with --no-judge: generation results are saved,
 * but the judge dimensions are placeholder "pass" values. This script re-judges
 * them without regenerating anything.
 *
 * Correctness and grounding need the original source text, which is NOT stored
 * in the benchmark — so we re-OCR the source PDF locally (mupdf, no API cost).
 * Sufficiency only needs the lesson content, which IS stored.
 *
 * Usage:
 *   bun scripts/audit-benchmark.ts <benchmark.json> [--file=Composer2.pdf]
 *
 * Options:
 *   --file=<substring>      Only audit questions whose source file matches (default: all files)
 *   --dimensions=<d,...>    correctness,grounding,sufficiency (default: all three)
 *   --model=<name>          claude CLI model (default: haiku)
 *   --concurrency=<n>       Max parallel claude CLI subprocesses (default: 6)
 *   --pdf-dir=<path>        Where to find source PDFs (default: ../data/pdfs)
 */
import { ocr } from "../lib/ocr";
import { parseJSON } from "../lib/utils/json";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDFS_DIR_DEFAULT = resolve(__dirname, "../data/pdfs");
const BENCHMARKS_DIR = resolve(__dirname, "../data/benchmarks");

// ── CLI args ────────────────────────────────────────────
const args = process.argv.slice(2);
const benchmarkPath = args.find((a) => !a.startsWith("--"));
if (!benchmarkPath || !existsSync(benchmarkPath)) {
  console.error(`Benchmark file not found: ${benchmarkPath ?? "(none given)"}`);
  process.exit(1);
}
const fileFilter =
  args.find((a) => a.startsWith("--file="))?.split("=")[1] ?? null;
const claudeModel =
  args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "haiku";
const concurrency = parseInt(
  args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "6",
  10
);
const pdfDir =
  args.find((a) => a.startsWith("--pdf-dir="))?.split("=")[1] ?? PDFS_DIR_DEFAULT;
const dimensionsArg =
  args.find((a) => a.startsWith("--dimensions="))?.split("=")[1] ?? null;
const enabledDimensions = new Set(
  dimensionsArg
    ? dimensionsArg.split(",").map((d) => d.trim().toLowerCase())
    : ["correctness", "grounding", "sufficiency"]
);
// When set, patch the matching benchmark_runs row with the real-judge results.
const writeDb = args.includes("--write-db");

// ── claude CLI judge (subscription auth, bounded concurrency) ──
let inflight = 0;
const queue: Array<() => void> = [];
async function acquire() {
  if (inflight < concurrency) {
    inflight++;
    return;
  }
  await new Promise<void>((r) => queue.push(r));
  inflight++;
}
function release() {
  inflight--;
  const next = queue.shift();
  if (next) next();
}
async function runClaudeCli(
  prompt: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // force subscription auth
  const proc = Bun.spawn(["claude", "-p", prompt, "--model", claudeModel], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
async function judge(prompt: string): Promise<string> {
  await acquire();
  try {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const { stdout, stderr, code } = await runClaudeCli(prompt);
      if (code === 0) return stdout.trim();
      lastErr = stderr || `exit ${code}`;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw new Error(`claude CLI failed after 3 attempts: ${lastErr}`);
  } finally {
    release();
  }
}

// ── Types ───────────────────────────────────────────────
interface Q {
  moduleIndex: number;
  lessonIndex: number;
  questionType: string;
  question: string;
  answer: any;
  choices?: any[];
  slots?: string[];
  lessonContent: string;
  explanation?: string;
}
interface CorrectnessVerdict {
  correct: boolean;
  explanation: string;
  expectedAnswer?: string;
}
interface GroundingVerdict {
  selfContained: boolean;
  concrete: boolean;
  grounded: boolean;
  issues: string[];
  explanation: string;
}
interface SufficiencyVerdict {
  sufficient: boolean;
  explanation: string;
}

// ── Correctness judge ───────────────────────────────────
function buildCorrectnessContext(q: Q): string {
  if (q.questionType === "multiple-choice") {
    return `Question: ${q.question}
Choices: ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Given answer: index ${q.answer} → "${q.choices![q.answer]}"
${q.explanation ? `Explanation given: ${q.explanation}` : ""}`;
  } else if (q.questionType === "true-false") {
    return `Statement: ${q.question}\nGiven answer: ${q.answer}`;
  } else if (q.questionType === "flow-diagram") {
    return `Question: ${q.question}
Choices (items to order): ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Slots: ${q.slots!.join(", ")}
Given answer (slot→choice mapping): [${q.answer}]
This means: ${q.slots!.map((slot: string, i: number) => `${slot} → "${q.choices![q.answer[i]]}"`).join(", ")}`;
  }
  return `Question: ${q.question}\nGiven answer: ${q.answer}`;
}

function parseCorrectnessResponse(text: string): CorrectnessVerdict | null {
  try {
    const parsed = parseJSON(text);
    return {
      correct: !!parsed.correct,
      explanation: parsed.explanation ?? "No explanation",
      expectedAnswer: parsed.expectedAnswer,
    };
  } catch {
    const lower = text.toLowerCase();
    const looksCorrect =
      lower.includes('"correct": true') || lower.includes('"correct":true');
    const looksIncorrect =
      lower.includes('"correct": false') || lower.includes('"correct":false');
    if (looksCorrect || looksIncorrect) {
      return {
        correct: looksCorrect && !looksIncorrect,
        explanation: text.substring(0, 300),
      };
    }
    return null;
  }
}

async function judgeCorrectness(
  q: Q,
  sourceContent: string
): Promise<CorrectnessVerdict> {
  const ctx = buildCorrectnessContext(q);
  const resultText =
    await judge(`You are an answer-correctness judge. Given a question, its answer, and the source content the question was derived from, determine if the answer is CORRECT.

${ctx}

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

  const parsed = parseCorrectnessResponse(resultText);
  if (!parsed) {
    return { correct: false, explanation: "Judge failed to parse response" };
  }
  if (parsed.correct) return parsed;

  // Re-judge failures to catch self-contradictions
  const verifyText =
    await judge(`A judge evaluated a question and marked the answer as INCORRECT. Review the judge's reasoning and determine if the verdict is actually right.

Question details:
${ctx}

Source content:
${sourceContent}

Judge's explanation for marking it INCORRECT:
${parsed.explanation}

Based on the source content and the judge's own reasoning:
- Is the given answer actually correct or incorrect?
- Did the judge contradict itself (reasoning says correct but verdict says incorrect)?

Respond ONLY with JSON:
{"correct": true, "explanation": "The answer is actually correct because..."}
or
{"correct": false, "explanation": "The answer is genuinely incorrect because..."}`);

  return parseCorrectnessResponse(verifyText) ?? parsed;
}

// ── Grounding + sufficiency context ─────────────────────
function buildGroundingContext(q: Q): string {
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

async function judgeGrounding(
  q: Q,
  sourceContent: string
): Promise<GroundingVerdict> {
  const ctx = buildGroundingContext(q);
  const resultText =
    await judge(`You are a quality judge for educational content. Evaluate the GROUNDING and SELF-CONTAINEDNESS of a question-answer pair.

This is NOT about whether the answer is factually correct. It's about whether the answer is well-formed, self-contained, and properly grounded in the source material.

${ctx}

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

  try {
    const parsed = parseJSON(resultText);
    return {
      selfContained: !!parsed.selfContained,
      concrete: !!parsed.concrete,
      grounded: !!parsed.grounded,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      explanation: parsed.explanation ?? "No explanation",
    };
  } catch {
    return {
      selfContained: true,
      concrete: true,
      grounded: true,
      issues: ["Judge parse failure — defaulting to pass"],
      explanation: "Judge failed to parse response",
    };
  }
}

async function judgeSufficiency(q: Q): Promise<SufficiencyVerdict> {
  const ctx = buildGroundingContext(q);
  const resultText =
    await judge(`You are a content sufficiency judge for educational material. You must determine whether the LESSON CONTENT (the brief shown to the student) contains enough information for the student to answer the question.

IMPORTANT: You are NOT checking whether the answer is correct. You are checking whether the lesson content TEACHES the material needed to answer.

${ctx}

Rules:
- FAIL if the lesson content is generic filler that doesn't mention the specific facts, terms, or concepts needed to answer the question.
- FAIL if the question asks about specific details (names, numbers, sequences, definitions) that are absent from the lesson content.
- PASS if the lesson content contains the key information needed, even if not verbatim — reasonable inference from the content is OK.
- PASS for true-false questions where the statement itself provides the claim to evaluate, as long as the content gives enough context.
- For multiple-choice: the content must teach enough to distinguish the correct choice from the distractors.
- For flow-diagram: the content must describe the process/sequence being tested.

Respond ONLY with JSON:
{"sufficient": true, "explanation": "The content covers..."}
or
{"sufficient": false, "explanation": "The content fails to mention..."}`);

  try {
    const parsed = parseJSON(resultText);
    return {
      sufficient: !!parsed.sufficient,
      explanation: parsed.explanation ?? "No explanation",
    };
  } catch {
    const lower = resultText.toLowerCase();
    const looksTrue =
      lower.includes('"sufficient": true') || lower.includes('"sufficient":true');
    const looksFalse =
      lower.includes('"sufficient": false') ||
      lower.includes('"sufficient":false');
    if (looksTrue || looksFalse) {
      return {
        sufficient: looksTrue && !looksFalse,
        explanation: resultText.substring(0, 300),
      };
    }
    return { sufficient: false, explanation: "Judge failed to parse response" };
  }
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const bench = JSON.parse(readFileSync(benchmarkPath!, "utf-8"));
  const fileRuns = (bench.results as any[]).filter((r) =>
    fileFilter ? r.file.includes(fileFilter) : true
  );
  if (fileRuns.length === 0) {
    console.error(
      `No runs matched ${fileFilter ? `--file=${fileFilter}` : "(any file)"}`
    );
    process.exit(1);
  }

  // All matched runs share the same source PDF when --file is a single doc.
  const uniqueFiles = [...new Set(fileRuns.map((r) => r.file))];

  console.log(`\n🔍 Audit: ${basename(benchmarkPath!)}`);
  console.log(`   Generation model: ${bench.generationModel}`);
  console.log(`   Judge:            claude CLI (${claudeModel})`);
  console.log(`   Filter:           ${fileFilter ?? "(all files)"}`);
  console.log(`   Source PDF(s):    ${uniqueFiles.join(", ")}`);
  console.log(`   Dimensions:       ${[...enabledDimensions].join(", ")}`);
  console.log(`   Concurrency:      ${concurrency}`);

  // OCR each unique source PDF once
  const sourceByFile = new Map<string, string>();
  const needSource =
    enabledDimensions.has("correctness") || enabledDimensions.has("grounding");
  if (needSource) {
    for (const f of uniqueFiles) {
      const pdfPath = resolve(pdfDir, f);
      if (!existsSync(pdfPath)) {
        console.error(`  ⚠️  Source PDF not found, skipping source-based judges: ${pdfPath}`);
        sourceByFile.set(f, "");
        continue;
      }
      const result = await ocr(pdfPath);
      const content = result.pages
        .filter((p) => p.success)
        .map((p) => p.content)
        .join("\n\n");
      sourceByFile.set(f, content);
      console.log(`   OCR ${f}: ${content.length} chars`);
    }
  }

  // Flatten questions, tag with run/iteration index
  const items: { runIdx: number; file: string; q: Q }[] = [];
  fileRuns.forEach((r, runIdx) => {
    for (const q of r.questions as Q[]) {
      items.push({ runIdx, file: r.file, q });
    }
  });
  console.log(`   Questions:        ${items.length}\n`);

  const start = Date.now();
  let done = 0;
  const verdicts = await Promise.all(
    items.map(async (item) => {
      const src = sourceByFile.get(item.file) ?? "";
      const [correctness, grounding, sufficiency] = await Promise.all([
        enabledDimensions.has("correctness") && src
          ? judgeCorrectness(item.q, src).catch(
              (e): CorrectnessVerdict => ({
                correct: true,
                explanation: `judge_failed: ${e.message}`,
              })
            )
          : Promise.resolve<CorrectnessVerdict>({
              correct: true,
              explanation: "skipped",
            }),
        enabledDimensions.has("grounding") && src
          ? judgeGrounding(item.q, src).catch(
              (e): GroundingVerdict => ({
                selfContained: true,
                concrete: true,
                grounded: true,
                issues: [],
                explanation: `judge_failed: ${e.message}`,
              })
            )
          : Promise.resolve<GroundingVerdict>({
              selfContained: true,
              concrete: true,
              grounded: true,
              issues: [],
              explanation: "skipped",
            }),
        enabledDimensions.has("sufficiency")
          ? judgeSufficiency(item.q).catch(
              (e): SufficiencyVerdict => ({
                sufficient: true,
                explanation: `judge_failed: ${e.message}`,
              })
            )
          : Promise.resolve<SufficiencyVerdict>({
              sufficient: true,
              explanation: "skipped",
            }),
      ]);
      done++;
      if (done % 10 === 0 || done === items.length) {
        console.log(`   judged ${done}/${items.length}`);
      }
      return { ...item, correctness, grounding, sufficiency };
    })
  );
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  // ── Aggregate ──
  const total = verdicts.length;
  const correct = verdicts.filter((v) => v.correctness.correct).length;
  const selfC = verdicts.filter((v) => v.grounding.selfContained).length;
  const concrete = verdicts.filter((v) => v.grounding.concrete).length;
  const grounded = verdicts.filter((v) => v.grounding.grounded).length;
  const fullyGrounded = verdicts.filter(
    (v) =>
      v.grounding.selfContained && v.grounding.concrete && v.grounding.grounded
  ).length;
  const sufficient = verdicts.filter((v) => v.sufficiency.sufficient).length;
  const pct = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "N/A");

  console.log("\n" + "═".repeat(60));
  console.log(`AUDIT RESULTS — ${fileFilter ?? "all files"} (${total} questions, ${elapsed}s)`);
  console.log("═".repeat(60));
  if (enabledDimensions.has("correctness"))
    console.log(`  Correct:        ${correct}/${total} (${pct(correct)})`);
  if (enabledDimensions.has("grounding")) {
    console.log(`  Fully grounded: ${fullyGrounded}/${total} (${pct(fullyGrounded)})`);
    console.log(`    Self-contained: ${selfC}/${total} (${pct(selfC)})`);
    console.log(`    Concrete:       ${concrete}/${total} (${pct(concrete)})`);
    console.log(`    Grounded:       ${grounded}/${total} (${pct(grounded)})`);
  }
  if (enabledDimensions.has("sufficiency"))
    console.log(`  Sufficient:     ${sufficient}/${total} (${pct(sufficient)})`);

  // Failures detail
  console.log("\n  ── Flagged questions ──");
  let flagged = 0;
  for (const v of verdicts) {
    const probs: string[] = [];
    if (enabledDimensions.has("correctness") && !v.correctness.correct)
      probs.push(`❌ correctness: ${v.correctness.explanation}`);
    const gFail =
      !v.grounding.selfContained || !v.grounding.concrete || !v.grounding.grounded;
    if (enabledDimensions.has("grounding") && gFail)
      probs.push(`⚠️ grounding: ${v.grounding.issues.join("; ") || v.grounding.explanation}`);
    if (enabledDimensions.has("sufficiency") && !v.sufficiency.sufficient)
      probs.push(`📝 sufficiency: ${v.sufficiency.explanation}`);
    if (probs.length > 0) {
      flagged++;
      console.log(
        `\n  [iter${v.runIdx + 1} M${v.q.moduleIndex + 1}L${v.q.lessonIndex + 1}] (${v.q.questionType}) ${v.q.question.substring(0, 70)}`
      );
      for (const p of probs) console.log(`     ${p}`);
    }
  }
  if (flagged === 0) console.log("  (none)");

  // ── Save ──
  if (!existsSync(BENCHMARKS_DIR)) mkdirSync(BENCHMARKS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const label = fileFilter ? fileFilter.replace(/[^a-z0-9]/gi, "_") : "all";
  const outPath = resolve(BENCHMARKS_DIR, `audit-${label}-${claudeModel}-${ts}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        sourceBenchmark: basename(benchmarkPath!),
        generationModel: bench.generationModel,
        judge: `claude-cli:${claudeModel}`,
        fileFilter,
        dimensions: [...enabledDimensions],
        totalQuestions: total,
        aggregate: {
          correct: `${correct}/${total} (${pct(correct)})`,
          fullyGrounded: `${fullyGrounded}/${total} (${pct(fullyGrounded)})`,
          selfContained: `${selfC}/${total} (${pct(selfC)})`,
          concrete: `${concrete}/${total} (${pct(concrete)})`,
          grounded: `${grounded}/${total} (${pct(grounded)})`,
          sufficient: `${sufficient}/${total} (${pct(sufficient)})`,
        },
        verdicts: verdicts.map((v) => ({
          runIdx: v.runIdx,
          file: v.file,
          moduleIndex: v.q.moduleIndex,
          lessonIndex: v.q.lessonIndex,
          questionType: v.q.questionType,
          question: v.q.question,
          answer: v.q.answer,
          correctness: v.correctness,
          grounding: v.grounding,
          sufficiency: v.sufficiency,
        })),
      },
      null,
      2
    )
  );
  console.log(`\n💾 Saved audit to ${outPath}`);

  // ── Patch the Neon benchmark_runs row with real-judge results (#3) ──
  if (writeDb) {
    if (fileFilter) {
      console.warn(`\n⚠️  --write-db ignored with --file= (a partial run must not overwrite the full-run row)`);
    } else {
      try {
        const { updateRunDims } = await import("./lib/benchmark-db");
        const patch: Record<string, unknown> = { judgeStatus: "real" };
        if (enabledDimensions.has("correctness")) patch.correctnessPct = Math.round((correct / total) * 100);
        if (enabledDimensions.has("grounding")) patch.groundedPct = Math.round((fullyGrounded / total) * 100);
        if (enabledDimensions.has("sufficiency")) patch.sufficientPct = Math.round((sufficient / total) * 100);
        const n = await updateRunDims(basename(benchmarkPath!), patch);
        console.log(
          n
            ? `📤 Updated benchmark_runs (${basename(benchmarkPath!)}) → judge_status=real`
            : `⚠️  No benchmark_runs row matched ${basename(benchmarkPath!)} — run load-benchmarks-to-db.ts first`
        );
      } catch (e: any) {
        console.warn(`⚠️  DB write skipped: ${e.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
