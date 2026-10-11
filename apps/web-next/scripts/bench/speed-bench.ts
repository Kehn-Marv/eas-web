#!/usr/bin/env tsx
/**
 * Fast-feedback experiment harness for course-generation models.
 *
 * Each variant swaps the generation model on the production pipeline
 * (lib/pipeline). The harness runs each variant N times against the same
 * input, scores with the same judges as eval-all.ts, and prints a
 * comparison table sorted by a quality-adjusted speedup score.
 *
 * Usage:
 *   TOGETHER_API_KEY=... ANTHROPIC_API_KEY=... \
 *     bun scripts/bench/speed-bench.ts [--variants=v1,v2,...] [--iterations=2] [--input=path]
 *
 * Variants are defined in scripts/bench/variants.ts. Pass --variants to limit
 * which ones run. Default input: data/attention-excerpt.md (text, skips OCR).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { generateText } from "ai";

import { createCourse } from "../../lib/create-course";
import { parseJSON } from "../../lib/utils/json";
import { getJudgeModel } from "../../lib/utils/judge-model";
import { DEFAULT_MODEL } from "../../lib/utils/together";
import { VARIANTS, type Variant } from "./variants";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUT_DIR = resolve(ROOT, "data/benchmarks/speed");

// ── CLI ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (k: string) =>
  args.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");

const inputPath = resolve(ROOT, arg("input") ?? "data/attention-excerpt.md");
const iterations = parseInt(arg("iterations") ?? "2", 10);
const concurrency = parseInt(arg("concurrency") ?? "2", 10);
const variantFilter = arg("variants")?.split(",").map((s) => s.trim());
const tag = arg("tag") ?? "shootout";
const judgeModel = arg("judge") ?? "anthropic/claude-sonnet-4-6";
const skipJudge = args.includes("--skip-judge");

const togetherApiKey = process.env.TOGETHER_API_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const openrouterApiKey = process.env.OPENROUTER_API_KEY;

if (!togetherApiKey) {
  console.error("TOGETHER_API_KEY required");
  process.exit(1);
}

// ── Judges (copied from eval-all.ts, kept inline so the harness is self-contained) ──
async function judgeViaClaudeCli(prompt: string): Promise<string> {
  // Strip ANTHROPIC_API_KEY so claude CLI uses subscription auth.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const proc = Bun.spawn(["claude", "-p", prompt, "--model", "sonnet"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`claude CLI exited ${code}: ${stderr.substring(0, 200)}`);
  }
  return stdout.trim();
}

async function judge(prompt: string): Promise<string> {
  if (judgeModel === "claude") {
    return judgeViaClaudeCli(prompt);
  }
  const r = await generateText({
    model: getJudgeModel({
      judgeModel,
      togetherApiKey,
      anthropicApiKey,
      openrouterApiKey,
    }),
    temperature: 0,
    maxOutputTokens: 1024,
    prompt,
  });
  return r.text;
}

interface CorrectnessVerdict {
  correct: boolean;
  explanation: string;
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

function buildAnswerContext(q: any): string {
  if (q.questionType === "multiple-choice") {
    return `Question: ${q.question}
Choices: ${q.choices.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Given answer: index ${q.answer} → "${q.choices[q.answer]}"`;
  }
  if (q.questionType === "true-false") {
    return `Statement: ${q.question}\nGiven answer: ${q.answer}`;
  }
  if (q.questionType === "flow-diagram") {
    return `Question: ${q.question}
Choices: ${q.choices.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Slots: ${q.slots.join(", ")}
Given answer: [${q.answer}]`;
  }
  return `Question: ${q.question}\nGiven answer: ${q.answer}`;
}

async function judgeCorrectness(q: any, source: string): Promise<CorrectnessVerdict> {
  const text = await judge(`Determine if the given answer is correct based on the source content.

${buildAnswerContext(q)}

Source:
${source}

Respond ONLY with JSON: {"correct": true|false, "explanation": "brief"}`);
  try {
    const p = parseJSON(text);
    return { correct: !!p.correct, explanation: p.explanation ?? "" };
  } catch {
    return { correct: false, explanation: "parse failed" };
  }
}

async function judgeGrounding(q: any, source: string): Promise<GroundingVerdict> {
  const text = await judge(`Evaluate the grounding of this Q&A pair against the source.

Question type: ${q.questionType}
Lesson content shown to student: ${q.content}

${buildAnswerContext(q)}

Source:
${source}

- selfContained: answer stands alone, no "see the text" / "as mentioned" / meta-references.
- concrete: answer is specific, not vague or circular.
- grounded: answer is supported by the source, no hallucination.

Respond ONLY with JSON: {"selfContained":bool,"concrete":bool,"grounded":bool,"issues":[],"explanation":"brief"}`);
  try {
    const p = parseJSON(text);
    return {
      selfContained: !!p.selfContained,
      concrete: !!p.concrete,
      grounded: !!p.grounded,
      issues: Array.isArray(p.issues) ? p.issues : [],
      explanation: p.explanation ?? "",
    };
  } catch {
    return { selfContained: false, concrete: false, grounded: false, issues: ["parse failed"], explanation: "" };
  }
}

async function judgeSufficiency(q: any): Promise<SufficiencyVerdict> {
  const text = await judge(`Determine if the lesson content shown to the student contains enough information to answer the question.

Question type: ${q.questionType}
Lesson content: ${q.content}
${buildAnswerContext(q)}

Respond ONLY with JSON: {"sufficient": true|false, "explanation": "brief"}`);
  try {
    const p = parseJSON(text);
    return { sufficient: !!p.sufficient, explanation: p.explanation ?? "" };
  } catch {
    return { sufficient: false, explanation: "parse failed" };
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
function similarity(a: string, b: string): number {
  const wa = new Set(normalize(a).split(" "));
  const wb = new Set(normalize(b).split(" "));
  const inter = new Set([...wa].filter((w) => wb.has(w)));
  const uni = new Set([...wa, ...wb]);
  return inter.size / uni.size;
}
function countDuplicates(questions: string[], threshold = 0.7): number {
  const assigned = new Set<number>();
  let dupes = 0;
  for (let i = 0; i < questions.length; i++) {
    if (assigned.has(i)) continue;
    let groupSize = 1;
    assigned.add(i);
    for (let j = i + 1; j < questions.length; j++) {
      if (assigned.has(j)) continue;
      if (similarity(questions[i], questions[j]) >= threshold) {
        groupSize++;
        assigned.add(j);
      }
    }
    if (groupSize > 1) dupes += groupSize;
  }
  return dupes;
}

// ── Single iteration ──────────────────────────────────────
interface IterResult {
  variantId: string;
  iter: number;
  ok: boolean;
  error?: string;
  timeMs: number;
  totalLessons: number;
  successfulLessons: number;
  firstPassLessons: number;
  correctCount: number;
  fullyGroundedCount: number;
  sufficientCount: number;
  duplicateCount: number;
  judgedCount: number;
  /** Lessons + course title, persisted so we can review quality after the run. */
  course?: {
    title: string;
    modules: Array<{
      title: string;
      lessons: Array<{ success: boolean; data?: any; error?: any }>;
    }>;
  };
}

async function runIteration(
  variant: Variant,
  iter: number,
  content: string
): Promise<IterResult> {
  const label = `[${variant.id} #${iter}]`;
  const start = Date.now();
  try {
    const course = await createCourse({
      content,
      apiKey: togetherApiKey!,
      model: variant.model ?? DEFAULT_MODEL,
    });
    const timeMs = Date.now() - start;

    let totalLessons = 0;
    let successfulLessons = 0;
    let firstPassLessons = 0;
    const goodLessons: any[] = [];
    course.modules.forEach((mod) => {
      mod.lessons.forEach((lr) => {
        totalLessons++;
        if (lr.success) {
          successfulLessons++;
          const wasFixed = lr.data?.fixHistory && lr.data.fixHistory.length > 0;
          if (!wasFixed) firstPassLessons++;
          goodLessons.push(lr.data);
        }
      });
    });

    let correctCount = 0;
    let fullyGroundedCount = 0;
    let sufficientCount = 0;
    let judgedCount = 0;

    if (!skipJudge && goodLessons.length > 0) {
      const verdicts = await Promise.all(
        goodLessons.map(async (lesson) => {
          const [c, g, s] = await Promise.all([
            judgeCorrectness(lesson, content).catch((e: any) => {
              console.warn(`${label} correctness judge failed: ${e.message?.substring(0, 200)}`);
              return { correct: false, explanation: `error: ${e.message}` };
            }),
            judgeGrounding(lesson, content).catch((e: any) => {
              console.warn(`${label} grounding judge failed: ${e.message?.substring(0, 200)}`);
              return { selfContained: false, concrete: false, grounded: false, issues: [], explanation: `error: ${e.message}` };
            }),
            judgeSufficiency(lesson).catch((e: any) => {
              console.warn(`${label} sufficiency judge failed: ${e.message?.substring(0, 200)}`);
              return { sufficient: false, explanation: `error: ${e.message}` };
            }),
          ]);
          return { c, g, s };
        })
      );
      for (const v of verdicts) {
        judgedCount++;
        if (v.c.correct) correctCount++;
        if (v.g.selfContained && v.g.concrete && v.g.grounded) fullyGroundedCount++;
        if (v.s.sufficient) sufficientCount++;
      }
    }

    const questionStrings = goodLessons.map((l) => l.question);
    const duplicateCount = countDuplicates(questionStrings);

    console.log(
      `${label} ✓ ${(timeMs / 1000).toFixed(1)}s  lessons=${successfulLessons}/${totalLessons} ` +
        `firstPass=${firstPassLessons}` +
        (skipJudge ? "" : ` correct=${correctCount}/${judgedCount} grounded=${fullyGroundedCount}/${judgedCount} sufficient=${sufficientCount}/${judgedCount}`) +
        ` dupes=${duplicateCount}`
    );

    return {
      variantId: variant.id,
      iter,
      ok: true,
      timeMs,
      totalLessons,
      successfulLessons,
      firstPassLessons,
      correctCount,
      fullyGroundedCount,
      sufficientCount,
      duplicateCount,
      judgedCount,
      course: {
        title: course.title,
        modules: course.modules.map((m) => ({
          title: m.title,
          lessons: m.lessons.map((l: any) => ({
            success: l.success,
            data: l.success ? l.data : undefined,
            error: l.success ? undefined : l.error,
          })),
        })),
      },
    };
  } catch (err: any) {
    const timeMs = Date.now() - start;
    console.log(`${label} ✗ ${(timeMs / 1000).toFixed(1)}s  ERROR: ${err.message?.substring(0, 120)}`);
    return {
      variantId: variant.id,
      iter,
      ok: false,
      error: err.message ?? String(err),
      timeMs,
      totalLessons: 0,
      successfulLessons: 0,
      firstPassLessons: 0,
      correctCount: 0,
      fullyGroundedCount: 0,
      sufficientCount: 0,
      duplicateCount: 0,
      judgedCount: 0,
    };
  }
}

// ── Concurrency-limited pool ──────────────────────────────
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────
async function main() {
  const content = readFileSync(inputPath, "utf-8");
  const variants = variantFilter
    ? VARIANTS.filter((v) => variantFilter.includes(v.id))
    : VARIANTS;

  if (variants.length === 0) {
    console.error("No variants matched filter");
    process.exit(1);
  }

  console.log(`\n🧪 speed-bench  tag=${tag}`);
  console.log(`   input:       ${basename(inputPath)} (${content.length} chars)`);
  console.log(`   variants:    ${variants.length} × ${iterations} iter`);
  console.log(`   judge:       ${skipJudge ? "(skipped)" : judgeModel}`);
  console.log(`   concurrency: ${concurrency}`);
  console.log();

  // Flatten into (variant, iter) jobs so we can pool across variants.
  const jobs = variants.flatMap((v) =>
    Array.from({ length: iterations }, (_, i) => ({ variant: v, iter: i + 1 }))
  );

  const startAll = Date.now();
  const allResults = await pool(jobs, concurrency, ({ variant, iter }) =>
    runIteration(variant, iter, content)
  );
  const totalTimeMs = Date.now() - startAll;

  // Aggregate per variant
  const byVariant = new Map<string, IterResult[]>();
  for (const r of allResults) {
    if (!byVariant.has(r.variantId)) byVariant.set(r.variantId, []);
    byVariant.get(r.variantId)!.push(r);
  }

  const rows: Array<{
    id: string;
    label: string;
    model: string;
    okRuns: number;
    runs: number;
    avgTimeMs: number;
    medianTimeMs: number;
    avgLessons: number;
    avgFirstPass: number;
    correctPct: number;
    groundedPct: number;
    sufficientPct: number;
    avgDupes: number;
    score: number; // composite: quality * speedup vs baseline
  }> = [];

  for (const variant of variants) {
    const results = byVariant.get(variant.id) ?? [];
    const ok = results.filter((r) => r.ok);
    const times = ok.map((r) => r.timeMs).sort((a, b) => a - b);
    const avgTimeMs = times.length ? times.reduce((s, t) => s + t, 0) / times.length : 0;
    const medianTimeMs = times.length ? times[Math.floor(times.length / 2)] : 0;
    const totalLessons = ok.reduce((s, r) => s + r.totalLessons, 0);
    const successful = ok.reduce((s, r) => s + r.successfulLessons, 0);
    const firstPass = ok.reduce((s, r) => s + r.firstPassLessons, 0);
    const correct = ok.reduce((s, r) => s + r.correctCount, 0);
    const grounded = ok.reduce((s, r) => s + r.fullyGroundedCount, 0);
    const sufficient = ok.reduce((s, r) => s + r.sufficientCount, 0);
    const judged = ok.reduce((s, r) => s + r.judgedCount, 0);
    const dupes = ok.reduce((s, r) => s + r.duplicateCount, 0);

    rows.push({
      id: variant.id,
      label: variant.label,
      model: variant.model ?? DEFAULT_MODEL,
      okRuns: ok.length,
      runs: results.length,
      avgTimeMs,
      medianTimeMs,
      avgLessons: totalLessons ? successful / ok.length : 0,
      avgFirstPass: totalLessons ? firstPass / ok.length : 0,
      correctPct: judged ? (correct / judged) * 100 : 0,
      groundedPct: judged ? (grounded / judged) * 100 : 0,
      sufficientPct: judged ? (sufficient / judged) * 100 : 0,
      avgDupes: ok.length ? dupes / ok.length : 0,
      score: 0,
    });
  }

  // Composite score = qualityScore × speedup vs baseline.
  // qualityScore = mean of (correct%, grounded%, sufficient%) / 100 × successRate.
  // Baseline is the first variant by default (typically MiniMax-M2.7).
  const baseline = rows[0];
  for (const row of rows) {
    const lessonsPerRun = row.runs > 0 ? row.avgLessons : 0;
    const expectedLessons = 12; // 3 modules × 4 lessons (3 standard + 1 flow if present)
    const successRate = Math.min(1, lessonsPerRun / expectedLessons);
    const qualityAvg = skipJudge
      ? successRate
      : ((row.correctPct + row.groundedPct + row.sufficientPct) / 300) * successRate;
    const speedup = row.avgTimeMs > 0 ? baseline.avgTimeMs / row.avgTimeMs : 0;
    row.score = qualityAvg * speedup;
  }

  rows.sort((a, b) => b.score - a.score);

  // ── Print table ──
  console.log("\n" + "═".repeat(120));
  console.log(`RESULTS — ${tag}  (total ${(totalTimeMs / 1000).toFixed(1)}s)`);
  console.log("═".repeat(120));

  const header = [
    "variant".padEnd(28),
    "ok".padEnd(6),
    "avg(s)".padStart(7),
    "med(s)".padStart(7),
    "lessons".padStart(8),
    "1stPass".padStart(8),
    skipJudge ? "" : "correct".padStart(8),
    skipJudge ? "" : "grounded".padStart(9),
    skipJudge ? "" : "suffic".padStart(8),
    "dupes".padStart(6),
    "score".padStart(7),
  ].filter(Boolean).join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  const baselineTimeMs = baseline.avgTimeMs;
  for (const row of rows) {
    const speedup = baselineTimeMs > 0 ? baselineTimeMs / row.avgTimeMs : 0;
    const cols = [
      row.id.padEnd(28),
      `${row.okRuns}/${row.runs}`.padEnd(6),
      (row.avgTimeMs / 1000).toFixed(1).padStart(7),
      (row.medianTimeMs / 1000).toFixed(1).padStart(7),
      row.avgLessons.toFixed(1).padStart(8),
      row.avgFirstPass.toFixed(1).padStart(8),
      skipJudge ? "" : `${row.correctPct.toFixed(0)}%`.padStart(8),
      skipJudge ? "" : `${row.groundedPct.toFixed(0)}%`.padStart(9),
      skipJudge ? "" : `${row.sufficientPct.toFixed(0)}%`.padStart(8),
      row.avgDupes.toFixed(1).padStart(6),
      `${row.score.toFixed(2)} (${speedup.toFixed(1)}x)`.padStart(7),
    ].filter(Boolean).join(" ");
    console.log(cols);
  }

  // ── Save JSON ──
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outPath = resolve(OUT_DIR, `${tag}-${ts}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        tag,
        timestamp: new Date().toISOString(),
        input: basename(inputPath),
        iterations,
        concurrency,
        judgeModel: skipJudge ? null : judgeModel,
        totalTimeMs,
        rows,
        rawResults: allResults,
      },
      null,
      2
    )
  );
  console.log(`\n💾 ${outPath}`);
}

main().catch((err) => {
  console.error("speed-bench failed:", err);
  process.exit(1);
});
