/**
 * Composite "overall score" (0–100, higher = better) for a benchmark run, so runs
 * are easy to assess and rank at a glance. Pure (no deps) and used by the eval
 * scripts.
 *
 * Each component is normalized to 0–100 with higher=better (the "lower is better"
 * dims — duplication, give-away, recall-ratio — are inverted). The score is a
 * weighted average over the components that are PRESENT, re-normalized by the
 * weight actually available, so a structural-only run still scores (with low
 * coverage). Always read `coverage` alongside `score`: a 100%-coverage score is
 * far more meaningful than a 15% one.
 */
export interface ScoreInput {
  structuralPct?: number | null;
  correctnessPct?: number | null;
  groundedPct?: number | null;
  sufficientPct?: number | null;
  semanticDupRate?: number | null;
  giveawayRate?: number | null;
  recallRatio?: number | null;
}

// Weights sum to 100. Tweak here to reweight the score everywhere.
export const SCORE_WEIGHTS = {
  correctness: 25, // is the answer right
  sufficient: 20, // does the lesson teach enough to answer
  grounded: 15, // self-contained / concrete / grounded in source
  structural: 15, // does it generate at all
  distinctness: 10, // 100 − semantic-dup (variety)
  nonGiveaway: 10, // 100 − give-away (briefs don't leak the answer)
  depth: 5, // 100 − recall-ratio (questions beyond rote recall)
} as const;

export interface ScoreResult {
  score: number | null; // 0–100, null if no components present
  coverage: number; // 0–1: share of total weight that had data
  parts: Partial<Record<keyof typeof SCORE_WEIGHTS, number>>;
}

const SCORE_KEYS: (keyof ScoreInput)[] = [
  "structuralPct", "correctnessPct", "groundedPct", "sufficientPct",
  "semanticDupRate", "giveawayRate", "recallRatio",
];

/**
 * Score two runs over the COMMON set of present dimensions, so the comparison is
 * fair: a run isn't penalized merely for having extra (lower-is-better) dims the
 * other lacks. Any dim missing on either side is dropped from both.
 */
export function scoreCommon(a: ScoreInput, b: ScoreInput): { a: ScoreResult; b: ScoreResult } {
  const mask = (x: ScoreInput, other: ScoreInput): ScoreInput => {
    const m: ScoreInput = {};
    for (const k of SCORE_KEYS) m[k] = x[k] != null && other[k] != null ? x[k] : null;
    return m;
  };
  return { a: scoreRun(mask(a, b)), b: scoreRun(mask(b, a)) };
}

export function scoreRun(x: ScoreInput): ScoreResult {
  const inv = (v: number | null | undefined) => (v == null ? null : 100 - v);
  const components: Array<[keyof typeof SCORE_WEIGHTS, number | null | undefined]> = [
    ["correctness", x.correctnessPct],
    ["sufficient", x.sufficientPct],
    ["grounded", x.groundedPct],
    ["structural", x.structuralPct],
    ["distinctness", inv(x.semanticDupRate)],
    ["nonGiveaway", inv(x.giveawayRate)],
    ["depth", inv(x.recallRatio)],
  ];
  let weighted = 0, presentWeight = 0;
  const parts: ScoreResult["parts"] = {};
  for (const [key, val] of components) {
    if (val == null) continue;
    const w = SCORE_WEIGHTS[key];
    weighted += w * val;
    presentWeight += w;
    parts[key] = Math.round(val);
  }
  const totalWeight = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  return {
    score: presentWeight > 0 ? Math.round(weighted / presentWeight) : null,
    coverage: presentWeight / totalWeight,
    parts,
  };
}
