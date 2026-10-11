#!/usr/bin/env tsx
/**
 * Backfill / sync saved benchmarks (data/benchmarks/*.json) into the Neon
 * benchmark_runs table. Idempotent: upserts on sourceFile, so re-running only
 * updates changed rows and adds new ones.
 *
 * Usage:
 *   bun scripts/load-benchmarks-to-db.ts           # sync all
 *   bun scripts/load-benchmarks-to-db.ts --dry-run # parse + report, no writes
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadAllBenchmarks } from "./lib/benchmark-parse";
import { upsertSummaries } from "./lib/benchmark-db";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(__dirname, "../data/benchmarks");
const dryRun = process.argv.includes("--dry-run");

const summaries = loadAllBenchmarks(DIR);
console.log(`Parsed ${summaries.length} benchmark runs from ${DIR}`);

if (dryRun) {
  const byStatus = summaries.reduce<Record<string, number>>((m, s) => ((m[s.judgeStatus] = (m[s.judgeStatus] ?? 0) + 1), m), {});
  console.log("[dry-run] judge status:", byStatus);
  console.log("[dry-run] sample:", JSON.stringify(summaries[summaries.length - 1], null, 2));
  process.exit(0);
}

const written = await upsertSummaries(summaries);
console.log(`✅ Synced ${written} runs into benchmark_runs`);
process.exit(0);
