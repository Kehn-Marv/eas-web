/**
 * DB write helpers for benchmark_runs. Shared by the loader, the auto-sync hook
 * in eval-all.ts, and the audit scripts that backfill judge / extra dims.
 */
import { eq, sql } from "drizzle-orm";
import { db } from "../../lib/db";
import { benchmarkRuns, type NewBenchmarkRun } from "../../lib/db/schema";
import { parseBenchmark, type BenchmarkSummary } from "./benchmark-parse";
import { basename } from "path";

export function summaryToRow(s: BenchmarkSummary): NewBenchmarkRun {
  return {
    sourceFile: s.sourceFile,
    tag: s.tag,
    ranAt: new Date(s.ranAt),
    generationModel: s.generationModel,
    judgeModel: s.judgeModel,
    iterations: s.iterations,
    filesCount: s.filesCount,
    totalQuestions: s.totalQuestions,
    totalLessons: s.totalLessons,
    totalTimeMs: s.totalTimeMs,
    genMsPerLesson: s.genMsPerLesson,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    costUsd: s.costUsd,
    costPerLesson: s.costPerLesson,
    fileset: s.fileset,
    structuralPct: s.structuralPct,
    firstPassPct: s.firstPassPct,
    lexicalDupRate: s.lexicalDupRate,
    judgeStatus: s.judgeStatus,
    correctnessPct: s.correctnessPct,
    groundedPct: s.groundedPct,
    sufficientPct: s.sufficientPct,
    semanticDupRate: s.semanticDupRate,
    giveawayRate: s.giveawayRate,
    recallRatio: s.recallRatio,
    dimensions: s.dimensions,
    byTypeSummary: s.byTypeSummary,
    perFile: s.perFile,
  };
}

/** Columns that the standard JSON->row sync owns; excludes deeper audit dims so a
 * later --write-db enrichment isn't clobbered by a re-sync of the same file. */
const SYNC_UPDATE_SET = {
  tag: sql`excluded.tag`,
  ranAt: sql`excluded.ran_at`,
  generationModel: sql`excluded.generation_model`,
  judgeModel: sql`excluded.judge_model`,
  iterations: sql`excluded.iterations`,
  filesCount: sql`excluded.files_count`,
  totalQuestions: sql`excluded.total_questions`,
  totalLessons: sql`excluded.total_lessons`,
  totalTimeMs: sql`excluded.total_time_ms`,
  genMsPerLesson: sql`excluded.gen_ms_per_lesson`,
  // cost: COALESCE so a re-sync from an older JSON (no usage block) won't null a recorded cost
  inputTokens: sql`coalesce(excluded.input_tokens, benchmark_runs.input_tokens)`,
  outputTokens: sql`coalesce(excluded.output_tokens, benchmark_runs.output_tokens)`,
  costUsd: sql`coalesce(excluded.cost_usd, benchmark_runs.cost_usd)`,
  costPerLesson: sql`coalesce(excluded.cost_per_lesson, benchmark_runs.cost_per_lesson)`,
  fileset: sql`excluded.fileset`,
  structuralPct: sql`excluded.structural_pct`,
  firstPassPct: sql`excluded.first_pass_pct`,
  lexicalDupRate: sql`excluded.lexical_dup_rate`,
  // Don't let a re-sync from the (still no-judge) JSON revert a --write-db backfill:
  // keep 'real' if already real, and never null an existing judged value.
  judgeStatus: sql`case when benchmark_runs.judge_status = 'real' and excluded.judge_status <> 'real' then 'real' else excluded.judge_status end`,
  correctnessPct: sql`coalesce(excluded.correctness_pct, benchmark_runs.correctness_pct)`,
  groundedPct: sql`coalesce(excluded.grounded_pct, benchmark_runs.grounded_pct)`,
  sufficientPct: sql`coalesce(excluded.sufficient_pct, benchmark_runs.sufficient_pct)`,
  dimensions: sql`excluded.dimensions`,
  byTypeSummary: sql`excluded.by_type_summary`,
  perFile: sql`excluded.per_file`,
  importedAt: sql`now()`,
} as const;

/** Upsert many summaries (chunked for neon-http statement limits). */
export async function upsertSummaries(summaries: BenchmarkSummary[], chunk = 50): Promise<number> {
  const rows = summaries.map(summaryToRow);
  let written = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    await db
      .insert(benchmarkRuns)
      .values(rows.slice(i, i + chunk))
      .onConflictDoUpdate({ target: benchmarkRuns.sourceFile, set: SYNC_UPDATE_SET });
    written += Math.min(chunk, rows.length - i);
  }
  return written;
}

/** Parse + upsert a single benchmark file. Returns the sourceFile, or null if not a benchmark. */
export async function syncBenchmarkFile(path: string): Promise<string | null> {
  const summary = parseBenchmark(path, basename(path));
  if (!summary) return null;
  await db
    .insert(benchmarkRuns)
    .values(summaryToRow(summary))
    .onConflictDoUpdate({ target: benchmarkRuns.sourceFile, set: SYNC_UPDATE_SET });
  return summary.sourceFile;
}

/** Patch specific dim columns on an existing run row (by source filename). */
export async function updateRunDims(
  sourceFile: string,
  patch: Partial<Pick<NewBenchmarkRun,
    "judgeStatus" | "correctnessPct" | "groundedPct" | "sufficientPct" |
    "semanticDupRate" | "giveawayRate" | "recallRatio">>,
): Promise<number> {
  const res = await db
    .update(benchmarkRuns)
    .set({ ...patch, importedAt: new Date() })
    .where(eq(benchmarkRuns.sourceFile, sourceFile))
    .returning({ id: benchmarkRuns.id });
  return res.length;
}
