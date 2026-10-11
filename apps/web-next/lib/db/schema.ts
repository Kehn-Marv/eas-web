import { pgTable, uuid, text, jsonb, timestamp, boolean, integer, real } from "drizzle-orm/pg-core";

export const courses = pgTable("courses", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  courseData: jsonb("course_data").notNull(),
  createdBy: text("created_by"), // userId (or sessionId for anonymous users)
  isPublic: boolean("is_public").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;

/**
 * One row per saved eval/benchmark run (data/benchmarks/*.json), for tracking
 * model quality & speed over time. Idempotent on sourceFile so backfill upserts.
 *
 * Quality dims (correctness/grounded/sufficient) are NULLABLE and gated by
 * judgeStatus — most historical runs have no real judge data, and a silently
 * failed judge fabricates 100%. Never trust a quality column without checking
 * judgeStatus = 'real'.
 */
export const benchmarkRuns = pgTable("benchmark_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceFile: text("source_file").notNull().unique(), // json filename — idempotent re-import key
  tag: text("tag").notNull(),
  ranAt: timestamp("ran_at").notNull(),
  generationModel: text("generation_model"), // nullable: 37 early runs didn't record it
  judgeModel: text("judge_model"),
  iterations: integer("iterations"),
  // scale
  filesCount: integer("files_count"),
  totalQuestions: integer("total_questions"),
  totalLessons: integer("total_lessons"),
  // speed
  totalTimeMs: integer("total_time_ms"),
  genMsPerLesson: integer("gen_ms_per_lesson"), // normalized across iter/batch counts
  // cost — generation tokens only (Together), captured forward via __usageTracker.
  // Null for historical runs (no tokens were saved).
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUsd: real("cost_usd"),
  costPerLesson: real("cost_per_lesson"), // costUsd / totalLessons — normalized for comparison
  // apples-to-apples key: sorted, normalized PDF set this run covered
  fileset: text("fileset"),
  // always-valid dims (no judge needed)
  structuralPct: real("structural_pct"),
  firstPassPct: real("first_pass_pct"),
  lexicalDupRate: real("lexical_dup_rate"),
  // judge-gated quality dims — nullable, only meaningful when judgeStatus = 'real'
  judgeStatus: text("judge_status").notNull(), // 'real' | 'fake-100%' | 'no-judge' | 'none'
  correctnessPct: real("correctness_pct"),
  groundedPct: real("grounded_pct"),
  sufficientPct: real("sufficient_pct"),
  // deeper audit dims — nullable, populated only when separately computed
  semanticDupRate: real("semantic_dup_rate"),
  giveawayRate: real("giveaway_rate"),
  recallRatio: real("recall_ratio"),
  // provenance / drill-down (no full per-question blob — kept on disk)
  dimensions: jsonb("dimensions"),
  byTypeSummary: jsonb("by_type_summary"),
  perFile: jsonb("per_file"), // [{file,total,success,firstPass,rate}] — powers the per-PDF chart
  importedAt: timestamp("imported_at").notNull().defaultNow(),
});

export type BenchmarkRun = typeof benchmarkRuns.$inferSelect;
export type NewBenchmarkRun = typeof benchmarkRuns.$inferInsert;
