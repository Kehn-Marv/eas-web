#!/usr/bin/env tsx
/**
 * Side-by-side comparison of two eval-all.ts runs.
 *
 *   bun scripts/compare-evals.ts <baseline.json> <winner.json>
 *
 * Prints a per-PDF table with speedup + the five eval dimensions.
 */
import { readFileSync } from "fs";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: compare-evals.ts <baseline.json> <winner.json>");
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(a, "utf-8"));
const winner = JSON.parse(readFileSync(b, "utf-8"));

interface FileResult {
  file: string;
  totalLessons: number;
  successfulLessons: number;
  firstPassSuccess: number;
  ocrTimeMs: number;
  generationTimeMs: number;
  judgingTimeMs: number;
  questions: Array<{
    correctness: { correct: boolean };
    grounding: { selfContained: boolean; concrete: boolean; grounded: boolean };
    sufficiency: { sufficient: boolean };
  }>;
  duplicateGroups: Array<{ indices: number[] }>;
}

function summarize(r: FileResult) {
  const total = r.questions.length;
  const correct = r.questions.filter((q) => q.correctness.correct).length;
  const grounded = r.questions.filter(
    (q) => q.grounding.selfContained && q.grounding.concrete && q.grounding.grounded
  ).length;
  const sufficient = r.questions.filter((q) => q.sufficiency.sufficient).length;
  const dupeQs = r.duplicateGroups.reduce((s, g) => s + g.indices.length, 0);
  return {
    total,
    succ: r.successfulLessons,
    firstPass: r.firstPassSuccess,
    correct,
    grounded,
    sufficient,
    dupeQs,
    genMs: r.generationTimeMs,
  };
}

function pct(n: number, d: number) {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

const baseFiles = baseline.results as FileResult[];
const winFiles = winner.results as FileResult[];

const allFiles = Array.from(new Set([...baseFiles.map((r) => r.file), ...winFiles.map((r) => r.file)]));

console.log("\n" + "═".repeat(140));
console.log(`COMPARISON   baseline=${baseline.pipeline}/${baseline.generationModel}   vs   winner=${winner.pipeline}/${winner.generationModel}`);
console.log("═".repeat(140));
console.log(
  "File".padEnd(46) +
    "Variant".padEnd(10) +
    "gen(s)".padStart(8) +
    "succ".padStart(8) +
    "1stP".padStart(8) +
    "corr".padStart(7) +
    "grnd".padStart(7) +
    "suff".padStart(7) +
    "dup".padStart(6) +
    "speed".padStart(9)
);
console.log("-".repeat(140));

interface Agg {
  gen: number;
  succ: number;
  total: number;
  firstPass: number;
  correct: number;
  grounded: number;
  sufficient: number;
  dupe: number;
  count: number;
}
const baseAgg: Agg = { gen: 0, succ: 0, total: 0, firstPass: 0, correct: 0, grounded: 0, sufficient: 0, dupe: 0, count: 0 };
const winAgg: Agg = { gen: 0, succ: 0, total: 0, firstPass: 0, correct: 0, grounded: 0, sufficient: 0, dupe: 0, count: 0 };

for (const file of allFiles) {
  const baseR = baseFiles.find((r) => r.file === file);
  const winR = winFiles.find((r) => r.file === file);
  const baseS = baseR ? summarize(baseR) : null;
  const winS = winR ? summarize(winR) : null;

  const displayName = file.length > 44 ? file.substring(0, 41) + "..." : file;
  const speedup = baseS && winS ? `${(baseS.genMs / winS.genMs).toFixed(1)}x` : "—";

  if (baseS) {
    console.log(
      displayName.padEnd(46) +
        "baseline".padEnd(10) +
        (baseS.genMs / 1000).toFixed(1).padStart(8) +
        `${baseS.succ}/${baseS.total}`.padStart(8) +
        pct(baseS.firstPass, baseS.total).padStart(8) +
        pct(baseS.correct, baseS.total).padStart(7) +
        pct(baseS.grounded, baseS.total).padStart(7) +
        pct(baseS.sufficient, baseS.total).padStart(7) +
        String(baseS.dupeQs).padStart(6) +
        " ".repeat(9)
    );
    baseAgg.gen += baseS.genMs;
    baseAgg.succ += baseS.succ;
    baseAgg.total += baseS.total;
    baseAgg.firstPass += baseS.firstPass;
    baseAgg.correct += baseS.correct;
    baseAgg.grounded += baseS.grounded;
    baseAgg.sufficient += baseS.sufficient;
    baseAgg.dupe += baseS.dupeQs;
    baseAgg.count++;
  }
  if (winS) {
    console.log(
      "".padEnd(46) +
        "winner".padEnd(10) +
        (winS.genMs / 1000).toFixed(1).padStart(8) +
        `${winS.succ}/${winS.total}`.padStart(8) +
        pct(winS.firstPass, winS.total).padStart(8) +
        pct(winS.correct, winS.total).padStart(7) +
        pct(winS.grounded, winS.total).padStart(7) +
        pct(winS.sufficient, winS.total).padStart(7) +
        String(winS.dupeQs).padStart(6) +
        speedup.padStart(9)
    );
    winAgg.gen += winS.genMs;
    winAgg.succ += winS.succ;
    winAgg.total += winS.total;
    winAgg.firstPass += winS.firstPass;
    winAgg.correct += winS.correct;
    winAgg.grounded += winS.grounded;
    winAgg.sufficient += winS.sufficient;
    winAgg.dupe += winS.dupeQs;
    winAgg.count++;
  }
}

console.log("-".repeat(140));
const sumSpeed = winAgg.gen > 0 ? `${(baseAgg.gen / winAgg.gen).toFixed(1)}x` : "—";
console.log(
  "AGGREGATE".padEnd(46) +
    "baseline".padEnd(10) +
    (baseAgg.gen / 1000).toFixed(1).padStart(8) +
    `${baseAgg.succ}/${baseAgg.total}`.padStart(8) +
    pct(baseAgg.firstPass, baseAgg.total).padStart(8) +
    pct(baseAgg.correct, baseAgg.total).padStart(7) +
    pct(baseAgg.grounded, baseAgg.total).padStart(7) +
    pct(baseAgg.sufficient, baseAgg.total).padStart(7) +
    String(baseAgg.dupe).padStart(6)
);
console.log(
  "".padEnd(46) +
    "winner".padEnd(10) +
    (winAgg.gen / 1000).toFixed(1).padStart(8) +
    `${winAgg.succ}/${winAgg.total}`.padStart(8) +
    pct(winAgg.firstPass, winAgg.total).padStart(8) +
    pct(winAgg.correct, winAgg.total).padStart(7) +
    pct(winAgg.grounded, winAgg.total).padStart(7) +
    pct(winAgg.sufficient, winAgg.total).padStart(7) +
    String(winAgg.dupe).padStart(6) +
    sumSpeed.padStart(9)
);
