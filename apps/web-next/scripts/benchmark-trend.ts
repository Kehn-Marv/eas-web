#!/usr/bin/env tsx
/**
 * Read-only inventory + trend view over all saved benchmarks in data/benchmarks/.
 *
 * Parses every *.json (top-level + speed/ subdir) via the shared benchmark
 * parser, which normalizes schema drift and classifies each run's judge data as
 * real / fake-100% / no-judge / none so polluted runs don't corrupt trends.
 *
 * This is the file-based quick view (no DB needed). For the durable store, the
 * same summaries are synced into Neon by load-benchmarks-to-db.ts.
 *
 * Usage:
 *   bun scripts/benchmark-trend.ts                 # full inventory
 *   bun scripts/benchmark-trend.ts --comparable    # only all-PDF multi-iter runs
 *   bun scripts/benchmark-trend.ts --model=gpt-oss-120b
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadAllBenchmarks, type BenchmarkSummary } from "./lib/benchmark-parse";
import { scoreRun } from "../lib/benchmark-score";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, "../data/benchmarks");

const args = process.argv.slice(2);
const onlyComparable = args.includes("--comparable");
const modelFilter = args.find((a) => a.startsWith("--model="))?.split("=")[1];

const rows = loadAllBenchmarks(DIR);
let view = rows;
if (modelFilter) view = view.filter((r) => (r.generationModel ?? "").includes(modelFilter));
if (onlyComparable) view = view.filter((r) => r.iterations >= 5 && r.totalQuestions >= 200);

const short = (m: string | null) => (m ?? "(unknown)").replace(/^.*\//, "");
const avg = (arr: (number | null)[]) => {
  const v = arr.filter((x): x is number => x != null);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};
const js = (s: string) => rows.filter((r) => r.judgeStatus === s).length;

// ── Inventory summary ──
const byModel = new Map<string, BenchmarkSummary[]>();
for (const r of rows) {
  const k = short(r.generationModel);
  (byModel.get(k) ?? byModel.set(k, []).get(k)!).push(r);
}

console.log(`\n📊 BENCHMARK INVENTORY — ${rows.length} runs`);
console.log(`   Date range:   ${rows[0]?.ranAt.slice(0, 16)} → ${rows[rows.length - 1]?.ranAt.slice(0, 16)}`);
console.log(`   Judge data:   real=${js("real")}  fake-100%=${js("fake-100%")}  no-judge=${js("no-judge")}  none=${js("none")}`);
console.log(`   Gen models (${byModel.size}):`);
for (const [m, rs] of [...byModel.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const withReal = rs.filter((r) => r.judgeStatus === "real");
  console.log(`     ${m.padEnd(34)} runs=${String(rs.length).padStart(3)}  struct=${avg(rs.map((r) => r.structuralPct)) ?? "—"}%  ms/lesson=${avg(rs.map((r) => r.genMsPerLesson)) ?? "—"}  [real-judge: ${withReal.length}, corr=${avg(withReal.map((r) => r.correctnessPct)) ?? "—"}%]`);
}

// ── Run table ──
const title = onlyComparable ? "COMPARABLE RUNS (≥5 iters, ≥200 Q)" : modelFilter ? `RUNS for ${modelFilter}` : "ALL RUNS (chronological)";
console.log(`\n${title}  — ${view.length} runs`);
console.log("date".padEnd(17) + "tag".padEnd(26) + "genModel".padEnd(20) + "it".padEnd(4) + "Q".padEnd(5) + "struct".padEnd(8) + "ms/les".padEnd(8) + "judge".padEnd(11) + "corr".padEnd(6) + "grnd".padEnd(6) + "suff".padEnd(6) + "dup".padEnd(6) + "hint".padEnd(6) + "score");
console.log("-".repeat(140));
const j = (n: number | null) => (n == null ? "—" : n + "%");
for (const r of view) {
  const sc = scoreRun(r);
  const scoreCol = sc.score == null ? "—" : `${sc.score} (${Math.round(sc.coverage * 100)}%)`;
  console.log(
    r.ranAt.slice(0, 16).replace("T", " ").padEnd(17) + r.tag.slice(0, 24).padEnd(26) + short(r.generationModel).slice(0, 18).padEnd(20) +
    String(r.iterations).padEnd(4) + String(r.totalQuestions).padEnd(5) +
    j(r.structuralPct).padEnd(8) + String(r.genMsPerLesson ?? "—").padEnd(8) +
    r.judgeStatus.padEnd(11) + j(r.correctnessPct).padEnd(6) + j(r.groundedPct).padEnd(6) + j(r.sufficientPct).padEnd(6) + j(r.lexicalDupRate).padEnd(6) + j(r.hintLeakRate).padEnd(6) + scoreCol
  );
}
console.log(`\n(ms/lesson = avg generation time per lesson — speed metric stable across iter/batch counts)`);
console.log(`(corr/grnd/suff shown only for real-judge runs; fake-100% & no-judge runs are blanked to avoid polluting trends)`);
