#!/usr/bin/env tsx
/**
 * Compute the deeper quality dims the eval harness doesn't measure, over a saved
 * benchmark, and (optionally) patch them into the Neon benchmark_runs row:
 *   - semantic_dup_rate — 1 - distinctFacts/totalQuestions (per-PDF LLM clustering)
 *   - giveaway_rate     — % of questions whose brief states the answer near-verbatim
 *   - recall_ratio      — % of questions that are pure recall (vs comprehension/reasoning)
 *
 * Uses Together (gpt-oss-20b grader for per-question difficulty; gpt-oss-120b for
 * the handful of clustering calls) — no Anthropic credits, no source OCR needed.
 *
 * Usage:
 *   bun scripts/audit-extra-dims.ts <benchmark.json> [--write-db] [--concurrency=10]
 */
import { generateText, embedMany } from "ai";
import { createTogetherAI } from "@ai-sdk/togetherai";
import { createTogetherClient, DEFAULT_MODEL, GRADER_MODEL, getTogetherProviderOptions } from "../lib/utils/together";
import { parseJSON } from "../lib/utils/json";
import { readFileSync, existsSync } from "fs";
import { basename } from "path";

// Semantic-dedup via embeddings (deterministic). Threshold 0.90 calibrated so
// per-PDF distinct-fact counts match the rigorous Opus audit (~77% overall).
const EMBED_MODEL = "intfloat/multilingual-e5-large-instruct";
const DUP_THRESHOLD = 0.9;

const args = process.argv.slice(2);
const benchmarkPath = args.find((a) => !a.startsWith("--"));
if (!benchmarkPath || !existsSync(benchmarkPath)) {
  console.error(`Benchmark file not found: ${benchmarkPath ?? "(none)"}`);
  process.exit(1);
}
const writeDb = args.includes("--write-db");
const concurrency = parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] ?? "8", 10);
const diffModel = args.find((a) => a.startsWith("--diff-model="))?.split("=")[1] ?? DEFAULT_MODEL;

const apiKey = process.env.TOGETHER_API_KEY;
if (!apiKey) { console.error("TOGETHER_API_KEY is required"); process.exit(1); }
const together = createTogetherClient(apiKey);
const togetherRaw = createTogetherAI({ apiKey });

// ── bounded concurrency ──
let inflight = 0;
const queue: Array<() => void> = [];
async function acquire() {
  if (inflight < concurrency) { inflight++; return; }
  await new Promise<void>((r) => queue.push(r));
  inflight++;
}
function release() { inflight--; queue.shift()?.(); }

async function gen(model: string, prompt: string, maxTokens: number): Promise<string> {
  await acquire();
  try {
    let lastErr: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await generateText({
          model: together(model),
          temperature: 0,
          maxOutputTokens: maxTokens,
          providerOptions: getTogetherProviderOptions(model),
          prompt,
        });
        if (r.text.trim()) return r.text;
        lastErr = new Error("empty response");
      } catch (e) {
        lastErr = e; // transient (429/503/timeout) — back off and retry
      }
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
    throw lastErr;
  } finally { release(); }
}

// ── helpers ──
function decode(q: any): string {
  if (q.questionType === "multiple-choice" && q.choices) return `"${q.choices[q.answer]}"`;
  if (q.questionType === "flow-diagram" && q.choices && q.slots) return q.slots.map((s: string, i: number) => `${s}→"${q.choices[q.answer[i]]}"`).join(", ");
  return String(q.answer);
}

interface Diff { giveAway: boolean; difficulty: "recall" | "comprehension" | "reasoning" | "unknown" }

async function judgeDifficulty(q: any): Promise<Diff> {
  const prompt = `You assess one quiz question against the BRIEF (the lesson text shown to the student just before the question). Output a single JSON object with two fields.

giveAway (boolean): true when the BRIEF already states the answer — verbatim or so plainly that the student just copies it; false when the BRIEF requires the student to understand, transform, or combine information to answer.

difficulty (string), exactly one of:
  - "recall": the answer is an explicitly-stated fact to copy or restate.
  - "comprehension": the student must understand/paraphrase a concept, not just copy a string.
  - "reasoning": the student must infer or combine multiple pieces of information.

QUESTION TYPE: ${q.questionType}
QUESTION: ${q.question}
ANSWER: ${decode(q)}
BRIEF:
"""${q.lessonContent ?? ""}"""

Output ONLY the JSON object with keys "giveAway" and "difficulty" — no other text.`;
  try {
    const p = parseJSON(await gen(diffModel, prompt, 300));
    const d = String(p.difficulty).toLowerCase();
    return {
      giveAway: !!p.giveAway,
      difficulty: ["recall", "comprehension", "reasoning"].includes(d) ? (d as Diff["difficulty"]) : "unknown",
    };
  } catch { return { giveAway: false, difficulty: "unknown" }; }
}

function cosine(a: number[], b: number[]): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Distinct underlying facts via embedding similarity (greedy single-link clustering). */
async function clusterFile(file: string, qs: any[]): Promise<{ distinctFacts: number; total: number }> {
  const { embeddings } = await embedMany({
    model: togetherRaw.textEmbeddingModel(EMBED_MODEL),
    values: qs.map((q) => q.question),
  });
  const assigned = new Array(embeddings.length).fill(-1);
  let clusters = 0;
  for (let i = 0; i < embeddings.length; i++) {
    if (assigned[i] >= 0) continue;
    assigned[i] = clusters;
    for (let j = i + 1; j < embeddings.length; j++) {
      if (assigned[j] < 0 && cosine(embeddings[i], embeddings[j]) >= DUP_THRESHOLD) assigned[j] = clusters;
    }
    clusters++;
  }
  return { distinctFacts: clusters, total: qs.length };
}

async function main() {
  const bench = JSON.parse(readFileSync(benchmarkPath!, "utf-8"));
  const results: any[] = bench.results ?? [];
  // flatten with iter + file
  const byFile = new Map<string, any[]>();
  const all: any[] = [];
  results.forEach((r, runIdx) => {
    for (const q of r.questions ?? []) {
      const item = { ...q, iter: runIdx + 1, file: r.file };
      all.push(item);
      (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)!).push(item);
    }
  });
  const total = all.length;
  console.log(`\n🔬 Extra-dims audit: ${basename(benchmarkPath!)}`);
  console.log(`   Questions: ${total} across ${byFile.size} PDFs`);
  console.log(`   Models: difficulty=${diffModel}  semantic-dup=${EMBED_MODEL}@${DUP_THRESHOLD}  concurrency=${concurrency}\n`);

  // difficulty / giveaway (per question)
  let done = 0;
  const diffs = await Promise.all(all.map(async (q) => {
    const d = await judgeDifficulty(q);
    if (++done % 50 === 0 || done === total) process.stdout.write(`\r   difficulty: ${done}/${total}`);
    return d;
  }));
  process.stdout.write("\n");

  // semantic clustering (per file)
  const clusters = await Promise.all([...byFile.entries()].map(([file, qs]) => clusterFile(file, qs)));

  // ── aggregate (giveaway/recall over successfully-parsed only; failures = missing, not negative) ──
  const parsed = diffs.filter((d) => d.difficulty !== "unknown");
  const nParsed = parsed.length;
  const coverage = Math.round((nParsed / total) * 100);
  const giveAway = parsed.filter((d) => d.giveAway).length;
  const recall = parsed.filter((d) => d.difficulty === "recall").length;
  const comprehension = parsed.filter((d) => d.difficulty === "comprehension").length;
  const reasoning = parsed.filter((d) => d.difficulty === "reasoning").length;
  const distinctTotal = clusters.reduce((s, c) => s + c.distinctFacts, 0);

  const semanticDupRate = Math.round((1 - distinctTotal / total) * 100);
  const giveawayRate = nParsed ? Math.round((giveAway / nParsed) * 100) : null;
  const recallRatio = nParsed ? Math.round((recall / nParsed) * 100) : null;

  console.log("\n" + "═".repeat(56));
  console.log(`EXTRA DIMS — ${total} questions (difficulty coverage ${coverage}%, ${nParsed}/${total} parsed)`);
  console.log("═".repeat(56));
  console.log(`  Semantic dup rate:  ${semanticDupRate}%   (${distinctTotal} distinct facts / ${total} questions)`);
  console.log(`  Give-away rate:     ${giveawayRate}%   (${giveAway}/${nParsed} briefs leak the answer)`);
  console.log(`  Difficulty:         recall ${recall} · comprehension ${comprehension} · reasoning ${reasoning}  → recall ratio ${recallRatio}%`);
  console.log(`  Per-PDF distinct facts: ${clusters.map((c, i) => `${[...byFile.keys()][i].slice(0, 16)}=${c.distinctFacts}/${c.total}`).join("  ")}`);

  if (writeDb) {
    try {
      const { updateRunDims } = await import("./lib/benchmark-db");
      const n = await updateRunDims(basename(benchmarkPath!), { semanticDupRate, giveawayRate, recallRatio });
      console.log(
        n
          ? `\n📤 Updated benchmark_runs (${basename(benchmarkPath!)}) → semantic/giveaway/recall`
          : `\n⚠️  No benchmark_runs row matched ${basename(benchmarkPath!)} — run load-benchmarks-to-db.ts first`
      );
    } catch (e: any) {
      console.warn(`\n⚠️  DB write skipped: ${e.message}`);
    }
  }
  process.exit(0);
}

main().catch((err) => { console.error("Extra-dims audit failed:", err); process.exit(1); });
