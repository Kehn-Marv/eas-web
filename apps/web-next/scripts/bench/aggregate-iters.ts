#!/usr/bin/env tsx
/**
 * Aggregate a multi-iteration eval-all.ts run.
 *
 *   bun scripts/aggregate-iters.ts <run.json>
 *
 * Prints per-PDF means and standard deviations for each eval dimension,
 * plus a single aggregate row.
 */
import { readFileSync } from "fs";

const path = process.argv[2];
if (!path) {
  console.error("usage: aggregate-iters.ts <run.json>");
  process.exit(1);
}

const d = JSON.parse(readFileSync(path, "utf-8"));

interface Q {
  questionType: string;
  correctness: { correct: boolean };
  grounding: { selfContained: boolean; concrete: boolean; grounded: boolean };
  sufficiency: { sufficient: boolean };
}
interface R {
  file: string;
  totalLessons: number;
  successfulLessons: number;
  firstPassSuccess: number;
  generationTimeMs: number;
  judgingTimeMs: number;
  questions: Q[];
  duplicateGroups: Array<{ indices: number[] }>;
}

interface PerFileSample {
  genMs: number;
  total: number;
  succ: number;
  fp: number;
  correct: number;
  grounded: number;
  sufficient: number;
  dupe: number;
}

const byFile = new Map<string, PerFileSample[]>();

for (const r of d.results as R[]) {
  const n = r.questions.length;
  const sample: PerFileSample = {
    genMs: r.generationTimeMs,
    total: r.totalLessons,
    succ: r.successfulLessons,
    fp: r.firstPassSuccess,
    correct: r.questions.filter((q) => q.correctness.correct).length,
    grounded: r.questions.filter(
      (q) => q.grounding.selfContained && q.grounding.concrete && q.grounding.grounded
    ).length,
    sufficient: r.questions.filter((q) => q.sufficiency.sufficient).length,
    dupe: r.duplicateGroups.reduce((s, g) => s + g.indices.length, 0),
  };
  // Track total questions judged for rate calc.
  (sample as any).judged = n;
  if (!byFile.has(r.file)) byFile.set(r.file, []);
  byFile.get(r.file)!.push(sample);
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}
function fmt(m: number, s: number, suffix = ""): string {
  return `${m.toFixed(1)}${suffix}±${s.toFixed(1)}`;
}
function pctMS(rates: number[]): string {
  const pcts = rates.map((r) => r * 100);
  return `${mean(pcts).toFixed(0)}±${stdev(pcts).toFixed(0)}%`;
}

console.log("\n" + "═".repeat(130));
console.log(`AVERAGES across ${d.iterations} iterations  —  ${d.pipeline ?? "createCourse"} / ${d.generationModel}`);
console.log("═".repeat(130));

const cols = "File".padEnd(46) + "iters".padStart(6) + "gen(s)".padStart(13) + "lessons".padStart(11) + "1stP".padStart(10) + "corr".padStart(10) + "grnd".padStart(10) + "suff".padStart(10) + "dupe".padStart(10);
console.log(cols);
console.log("-".repeat(130));

const allGen: number[] = [];
const allSucc: number[] = [];
const allTotal: number[] = [];
const allFp: number[] = [];
const allCorr: number[] = [];
const allGrnd: number[] = [];
const allSuff: number[] = [];
const allDupe: number[] = [];
const allJudged: number[] = [];

for (const [file, samples] of byFile.entries()) {
  const gens = samples.map((s) => s.genMs / 1000);
  const totals = samples.map((s) => s.total);
  const succs = samples.map((s) => s.succ);
  const fps = samples.map((s) => s.fp / Math.max(s.total, 1));
  const judged = samples.map((s) => (s as any).judged);
  const corrRates = samples.map((s, i) => s.correct / Math.max(judged[i], 1));
  const grndRates = samples.map((s, i) => s.grounded / Math.max(judged[i], 1));
  const suffRates = samples.map((s, i) => s.sufficient / Math.max(judged[i], 1));
  const dupes = samples.map((s) => s.dupe);

  const name = file.length > 44 ? file.substring(0, 41) + "..." : file;
  console.log(
    name.padEnd(46) +
      String(samples.length).padStart(6) +
      fmt(mean(gens), stdev(gens)).padStart(13) +
      `${mean(succs).toFixed(1)}/${mean(totals).toFixed(1)}`.padStart(11) +
      pctMS(fps).padStart(10) +
      pctMS(corrRates).padStart(10) +
      pctMS(grndRates).padStart(10) +
      pctMS(suffRates).padStart(10) +
      fmt(mean(dupes), stdev(dupes)).padStart(10)
  );

  allGen.push(...gens);
  allSucc.push(...succs);
  allTotal.push(...totals);
  allFp.push(...fps);
  allCorr.push(...corrRates);
  allGrnd.push(...grndRates);
  allSuff.push(...suffRates);
  allDupe.push(...dupes);
  allJudged.push(...judged);
}

console.log("-".repeat(130));
console.log(
  "AGGREGATE (across all PDFs × iters)".padEnd(46) +
    String(allGen.length).padStart(6) +
    fmt(mean(allGen), stdev(allGen)).padStart(13) +
    `${mean(allSucc).toFixed(1)}/${mean(allTotal).toFixed(1)}`.padStart(11) +
    pctMS(allFp).padStart(10) +
    pctMS(allCorr).padStart(10) +
    pctMS(allGrnd).padStart(10) +
    pctMS(allSuff).padStart(10) +
    fmt(mean(allDupe), stdev(allDupe)).padStart(10)
);

console.log();
console.log(`Total wall-clock: ${(d.totalTimeMs / 1000).toFixed(1)}s for ${d.iterations} iters of ${byFile.size} PDFs.`);
