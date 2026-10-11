/**
 * Shared parser for saved benchmark JSON (data/benchmarks/*.json).
 * Normalizes schema drift across ~178 historical runs and classifies judge
 * trustworthiness. Used by both benchmark-trend.ts and load-benchmarks-to-db.ts.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

export type JudgeStatus = "real" | "fake-100%" | "no-judge" | "none";

export interface BenchmarkSummary {
  sourceFile: string;
  tag: string;
  ranAt: string; // ISO timestamp
  generationModel: string | null;
  judgeModel: string | null;
  iterations: number;
  filesCount: number;
  totalQuestions: number;
  totalLessons: number;
  totalTimeMs: number | null;
  genMsPerLesson: number | null;
  structuralPct: number | null;
  firstPassPct: number | null;
  lexicalDupRate: number | null;
  judgeStatus: JudgeStatus;
  correctnessPct: number | null;
  groundedPct: number | null;
  sufficientPct: number | null;
  semanticDupRate: number | null;
  giveawayRate: number | null;
  hintLeakRate: number | null;
  recallRatio: number | null;
  dimensions: string[] | null;
  byTypeSummary: Record<string, unknown> | null;
  perFile: Array<{ file: string; total: number; success: number; firstPass: number; rate: number | null }>;
  // cost (generation only) — present only for runs recorded after token capture was wired
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costPerLesson: number | null;
  // apples-to-apples key: sorted, normalized PDF basenames joined by "|"
  fileset: string | null;
}

/** Normalize a source filename for fileset comparison (drop ext, punctuation, case). */
function normFile(f: string): string {
  return f.replace(/\.(pdf|md|ocr)$/gi, "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

export function pctNum(s: unknown): number | null {
  if (typeof s === "number") return s;
  if (typeof s === "string") {
    const m = s.match(/(\d+(?:\.\d+)?)\s*%/);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

function dimsHas(d: any, x: string): boolean {
  return Array.isArray(d.dimensions) && d.dimensions.includes(x);
}

export function classifyJudge(d: any): JudgeStatus {
  const hasJudgeDim = ["correctness", "grounding", "sufficiency"].some((x) => dimsHas(d, x));
  if (!hasJudgeDim) return "none";
  const qs = (d.results ?? []).flatMap((r: any) => r.questions ?? []);
  if (qs.length === 0) return "none";
  let failed = 0, skipped = 0, real = 0;
  for (const q of qs) {
    const ex = (q.correctness?.explanation ?? "") + " " + (q.sufficiency?.explanation ?? "");
    if (/judge_failed|judge failed|credit balance/i.test(ex)) failed++;
    else if (/^\s*skipped\s*$/i.test(q.correctness?.explanation ?? "")) skipped++;
    else real++;
  }
  const n = qs.length;
  if (failed / n > 0.5) return "fake-100%";
  if (skipped / n > 0.5) return "no-judge";
  if (real / n > 0.3) return "real";
  return "no-judge";
}

/** Parse one benchmark file into a normalized summary, or null if it isn't a benchmark. */
export function parseBenchmark(path: string, sourceFile: string): BenchmarkSummary | null {
  let d: any;
  try { d = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  if (!d || typeof d !== "object" || !d.timestamp || !d.results) return null;

  const results: any[] = d.results ?? [];
  const qs = results.flatMap((r) => r.questions ?? []);
  const totalLessons = d.aggregate?.structural?.totalLessons
    ?? results.reduce((s, r) => s + (r.totalLessons ?? 0), 0);
  const genMs = results.reduce((s, r) => s + (r.generationTimeMs ?? 0), 0);
  const judgeStatus = classifyJudge(d);
  const real = judgeStatus === "real";
  const iterations = d.iterations ?? 1;

  // Per-file aggregation across iterations (powers the dashboard's per-PDF chart)
  const perFileMap = new Map<string, { total: number; success: number; firstPass: number }>();
  for (const r of results) {
    if (!r.file) continue;
    const e = perFileMap.get(r.file) ?? { total: 0, success: 0, firstPass: 0 };
    e.total += r.totalLessons ?? 0;
    e.success += r.successfulLessons ?? 0;
    e.firstPass += r.firstPassSuccess ?? 0;
    perFileMap.set(r.file, e);
  }
  const perFile = [...perFileMap.entries()].map(([file, e]) => ({
    file,
    total: e.total,
    success: e.success,
    firstPass: e.firstPass,
    rate: e.total > 0 ? e.success / e.total : null,
  }));

  return {
    sourceFile,
    tag: d.tag ?? "?",
    ranAt: d.timestamp,
    generationModel: d.generationModel && !/^\?/.test(d.generationModel) ? d.generationModel : null,
    judgeModel: d.judgeModel ?? null,
    iterations,
    filesCount: Math.max(1, Math.round(results.length / iterations)),
    totalQuestions: qs.length,
    totalLessons,
    totalTimeMs: d.totalTimeMs ?? null,
    genMsPerLesson: totalLessons > 0 && genMs > 0 ? Math.round(genMs / totalLessons) : null,
    structuralPct: pctNum(d.aggregate?.structural?.successRate),
    firstPassPct: pctNum(d.aggregate?.structural?.firstPassRate),
    lexicalDupRate: dimsHas(d, "duplicates") ? pctNum(d.aggregate?.duplicates?.duplicationRate) : null,
    judgeStatus,
    correctnessPct: real ? pctNum(d.aggregate?.correctness?.accuracy) : null,
    groundedPct: real ? pctNum(d.aggregate?.grounding?.fullyGrounded) : null,
    sufficientPct: real ? pctNum(d.aggregate?.sufficiency?.rate) : null,
    semanticDupRate: null, // not present in saved benchmarks; computed separately
    giveawayRate: null,
    hintLeakRate: dimsHas(d, "hint-leak") ? pctNum(d.aggregate?.hintLeak?.leakRate) : null,
    recallRatio: null,
    dimensions: Array.isArray(d.dimensions) ? d.dimensions : null,
    byTypeSummary: d.aggregate?.byQuestionType ?? null,
    perFile,
    inputTokens: d.usage?.inputTokens ?? null,
    outputTokens: d.usage?.outputTokens ?? null,
    costUsd: d.usage?.costUsd ?? null,
    costPerLesson: d.usage?.costPerLesson
      ?? (d.usage?.costUsd != null && totalLessons > 0 ? d.usage.costUsd / totalLessons : null),
    fileset: perFile.length ? [...new Set(perFile.map((p) => normFile(p.file)))].sort().join("|") : null,
  };
}

/** Load + parse every benchmark under a directory (top-level + speed/ subdir). */
export function loadAllBenchmarks(dir: string): BenchmarkSummary[] {
  const out: BenchmarkSummary[] = [];
  const walk = (d: string, prefix = "") => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) { if (f === "speed") walk(p, "speed/"); continue; }
      if (!f.endsWith(".json")) continue;
      const row = parseBenchmark(p, prefix + f);
      if (row) out.push(row);
    }
  };
  walk(dir);
  out.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
  return out;
}
