#!/usr/bin/env tsx
/**
 * Apples-to-apples comparison from the Neon benchmark_runs table.
 *
 * Aligns by FILESET (the exact set of PDFs covered) so you only compare runs over
 * the same documents. Quality dims show only when both sides are real-judged.
 * Speed and cost are normalized per-lesson so different iteration counts compare.
 *
 * Modes:
 *   (no args)            current model's latest run  vs  the previous comparable run
 *                        (prefers the same model = regression check; else the model it replaced)
 *   <model>              that model's latest run  vs  its previous run
 *   <modelA> <modelB>    aggregate model-A vs model-B over their shared fileset
 *
 * Examples:
 *   bun scripts/benchmark-compare.ts
 *   bun scripts/benchmark-compare.ts MiniMax-M2.5
 *   bun scripts/benchmark-compare.ts gpt-oss-120b GLM-5 --fileset=composer2
 */
import { db } from "../lib/db";
import { benchmarkRuns, type BenchmarkRun } from "../lib/db/schema";
import { isNotNull } from "drizzle-orm";
import { DEFAULT_MODEL } from "../lib/utils/together";
import { scoreCommon } from "../lib/benchmark-score";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const filesetFilter = args.find((a) => a.startsWith("--fileset="))?.split("=")[1];

const rows = await db.select().from(benchmarkRuns).where(isNotNull(benchmarkRuns.fileset));
const short = (m: string | null) => (m ?? "(unknown)").replace(/^.*\//, "");
const pick = (q: string) => rows.filter((r) => short(r.generationModel).toLowerCase().includes(q.toLowerCase()));
const ms = (r: BenchmarkRun) => (r.ranAt instanceof Date ? r.ranAt.getTime() : new Date(r.ranAt as any).getTime());
const day = (r: BenchmarkRun) => (r.ranAt instanceof Date ? r.ranAt.toISOString() : String(r.ranAt)).slice(0, 10);

function agg(runs: BenchmarkRun[]) {
  const real = runs.filter((r) => r.judgeStatus === "real");
  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  return {
    n: runs.length, realN: real.length,
    iters: [...new Set(runs.map((r) => r.iterations ?? 0))].sort((a, b) => a - b),
    structuralPct: mean(runs.map((r) => r.structuralPct)),
    correctnessPct: mean(real.map((r) => r.correctnessPct)),
    groundedPct: mean(real.map((r) => r.groundedPct)),
    sufficientPct: mean(real.map((r) => r.sufficientPct)),
    semanticDupRate: mean(runs.map((r) => r.semanticDupRate)),
    giveawayRate: mean(runs.map((r) => r.giveawayRate)),
    recallRatio: mean(runs.map((r) => r.recallRatio)),
    genMsPerLesson: mean(runs.map((r) => r.genMsPerLesson)),
    costPerLesson: mean(runs.map((r) => r.costPerLesson)),
  };
}

let runsA: BenchmarkRun[], runsB: BenchmarkRun[], nameA: string, nameB: string, fileset: string, basis: string;

if (positional.length >= 2) {
  // ── explicit model-vs-model (aggregate over shared, data-rich fileset) ──
  const [qA, qB] = positional;
  let rA = pick(qA), rB = pick(qB);
  if (!rA.length || !rB.length) {
    console.error(`No runs for ${!rA.length ? qA : qB}. Models present:\n  ` + [...new Set(rows.map((r) => short(r.generationModel)))].sort().join(", "));
    process.exit(1);
  }
  if (filesetFilter) { rA = rA.filter((r) => r.fileset!.includes(filesetFilter)); rB = rB.filter((r) => r.fileset!.includes(filesetFilter)); }
  const populated = (rs: BenchmarkRun[], f: string) => rs.filter((r) => r.fileset === f && r.structuralPct != null).length;
  const shared = [...new Set(rA.map((r) => r.fileset!))]
    .filter((f) => rB.some((r) => r.fileset === f))
    .sort((f1, f2) => Math.min(populated(rB, f2), populated(rA, f2)) - Math.min(populated(rB, f1), populated(rA, f1))
      || (rA.filter((r) => r.fileset === f2).length + rB.filter((r) => r.fileset === f2).length) - (rA.filter((r) => r.fileset === f1).length + rB.filter((r) => r.fileset === f1).length));
  if (!shared.length) {
    console.error(`\n❌ No shared fileset between "${qA}" and "${qB}".`);
    process.exit(1);
  }
  fileset = shared[0];
  runsA = rA.filter((r) => r.fileset === fileset);
  runsB = rB.filter((r) => r.fileset === fileset);
  nameA = short(runsA[0].generationModel);
  nameB = short(runsB[0].generationModel);
  basis = `Runs: ${nameA} ${agg(runsA).n} (iters ${agg(runsA).iters.join("/")}), ${nameB} ${agg(runsB).n} (iters ${agg(runsB).iters.join("/")})`;
} else {
  // ── history mode: current model's latest run vs the previous comparable run ──
  const modelQ = positional[0] ?? short(DEFAULT_MODEL);
  let cands = pick(modelQ).filter((r) => r.fileset);
  if (filesetFilter) cands = cands.filter((r) => r.fileset!.includes(filesetFilter));
  if (!cands.length) {
    console.error(`No runs for "${modelQ}". Models present:\n  ` + [...new Set(rows.map((r) => short(r.generationModel)))].sort().join(", "));
    process.exit(1);
  }
  // Current = the model's latest SUBSTANTIAL run (≥2 PDFs), so we anchor to the real
  // eval set you last cared about and skip 1-PDF smoke/debug runs.
  const substantial = cands.filter((r) => r.fileset!.split("|").length >= 2);
  const pool = filesetFilter || !substantial.length ? cands : substantial;
  const current = [...pool].sort((a, b) => ms(b) - ms(a))[0];
  fileset = current.fileset!;
  const earlier = rows.filter((r) => r.fileset === fileset && ms(r) < ms(current)).sort((a, b) => ms(b) - ms(a));
  const previous = earlier.find((r) => short(r.generationModel) === short(current.generationModel)) ?? earlier[0];
  if (!previous) {
    console.error(`\nOnly one run exists on this PDF set for "${short(current.generationModel)}" — nothing previous to compare.\nRun another eval, or pass two models: bun scripts/benchmark-compare.ts <a> <b>`);
    process.exit(1);
  }
  runsA = [previous]; runsB = [current];
  const lbl = (r: BenchmarkRun) => `${short(r.generationModel)} ${day(r)}`;
  nameA = lbl(previous); nameB = lbl(current);
  const sameModel = short(previous.generationModel) === short(current.generationModel);
  basis = `${sameModel ? "Regression check (same model, latest vs previous run)" : "Model change (current vs the model it replaced)"}\n   previous: ${short(previous.generationModel)} · ${day(previous)} · ${previous.tag}\n   current:  ${short(current.generationModel)} · ${day(current)} · ${current.tag}`;
}

const A = agg(runsA), B = agg(runsB);

console.log(`\n⚖️  ${nameA}  →  ${nameB}`);
console.log(`   Fileset: ${fileset.split("|").length} PDFs — ${fileset.slice(0, 80)}`);
console.log(`   ${basis}`);
if (A.realN < runsA.length || B.realN < runsB.length)
  console.log(`   (quality rows blank where a side isn't real-judged)`);

// ── Overall score (headline) — scored over the dims BOTH sides have ──
const { a: sA, b: sB } = scoreCommon(A, B);
const scoreStr = (s: typeof sA) => (s.score == null ? "—" : `${s.score}  (${Math.round(s.coverage * 100)}% coverage)`);
const scoreDelta = sA.score != null && sB.score != null ? `${sB.score - sA.score >= 0 ? "+" : ""}${sB.score - sA.score}` : "—";
console.log(`\n  ★ OVERALL SCORE   ${nameA.slice(0, 18).padEnd(20)} ${scoreStr(sA)}`);
console.log(`                    ${nameB.slice(0, 18).padEnd(20)} ${scoreStr(sB)}   Δ ${scoreDelta}`);

type Row = { label: string; a: number | null; b: number | null; unit: string; betterHigh: boolean; dec?: number };
const out: Row[] = [
  { label: "Structural", a: A.structuralPct, b: B.structuralPct, unit: "%", betterHigh: true },
  { label: "Correctness", a: A.correctnessPct, b: B.correctnessPct, unit: "%", betterHigh: true },
  { label: "Grounded", a: A.groundedPct, b: B.groundedPct, unit: "%", betterHigh: true },
  { label: "Sufficient", a: A.sufficientPct, b: B.sufficientPct, unit: "%", betterHigh: true },
  { label: "Semantic-dup", a: A.semanticDupRate, b: B.semanticDupRate, unit: "%", betterHigh: false },
  { label: "Give-away", a: A.giveawayRate, b: B.giveawayRate, unit: "%", betterHigh: false },
  { label: "Recall ratio", a: A.recallRatio, b: B.recallRatio, unit: "%", betterHigh: false },
  { label: "Speed (ms/lesson)", a: A.genMsPerLesson, b: B.genMsPerLesson, unit: "", betterHigh: false },
  { label: "Cost ($/lesson)", a: A.costPerLesson, b: B.costPerLesson, unit: "", betterHigh: false, dec: 5 },
];
const fmt = (n: number | null, u: string, d = 0) => (n == null ? "—" : `${n.toFixed(d)}${u}`);
const pad = (s: string, n: number) => s.padEnd(n);
console.log("\n  " + pad("Metric", 20) + pad(nameA.slice(0, 18), 19) + pad(nameB.slice(0, 18), 19) + pad("Δ", 12) + "better");
console.log("  " + "-".repeat(82));
for (const r of out) {
  let delta = "—", winner = "";
  if (r.a != null && r.b != null) {
    const d = r.b - r.a;
    delta = `${d >= 0 ? "+" : ""}${d.toFixed(r.dec ?? 0)}${r.unit}`;
    if (Math.abs(d) < (r.dec ? 1e-9 : 0.5)) winner = "tie";
    else winner = (d > 0) === r.betterHigh ? nameB.slice(0, 16) : nameA.slice(0, 16);
  }
  console.log("  " + pad(r.label, 20) + pad(fmt(r.a, r.unit, r.dec ?? 0), 19) + pad(fmt(r.b, r.unit, r.dec ?? 0), 19) + pad(delta, 12) + winner);
}
console.log(`\n  (Δ = current − previous; lower is better for semantic-dup, give-away, recall, speed, cost)`);
if (A.costPerLesson == null && B.costPerLesson == null)
  console.log(`  ⚠️  No cost data — captured only on evals run after token tracking was added.`);
process.exit(0);
