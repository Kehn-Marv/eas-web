/**
 * Converts raw benchmark files into slim versions for committing to git.
 * Strips the `results` array and pre-computes per-file summaries.
 *
 * Usage: bun scripts/slim-benchmarks.ts
 *
 * Reads from: data/benchmarks/*.json
 * Writes to:  data/benchmarks-slim/*.json
 */

import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const SRC = path.join(import.meta.dir, "../data/benchmarks");
const DEST = path.join(import.meta.dir, "../data/benchmarks-slim");

type Result = {
  file: string;
  totalLessons?: number;
  successfulLessons?: number;
  finalSuccess?: number;
  finalFailed?: number;
  firstPassSuccess?: number;
};

function summarizePerFile(results: Result[]) {
  const byFile: Record<string, { total: number; success: number; firstPass: number }> = {};

  for (const r of results) {
    const name = r.file || "unknown";
    if (!byFile[name]) byFile[name] = { total: 0, success: 0, firstPass: 0 };

    const total = r.totalLessons ?? (r.finalSuccess ?? 0) + (r.finalFailed ?? 0);
    const success = r.successfulLessons ?? r.finalSuccess ?? 0;

    byFile[name].total += total;
    byFile[name].success += success;
    byFile[name].firstPass += r.firstPassSuccess ?? 0;
  }

  return Object.entries(byFile).map(([file, stats]) => ({
    file,
    ...stats,
    rate: stats.total > 0 ? Math.round((stats.success / stats.total) * 10000) / 10000 : null,
  }));
}

async function main() {
  await mkdir(DEST, { recursive: true });

  const files = (await readdir(SRC)).filter((f) => f.endsWith(".json"));
  let totalRawBytes = 0;
  let totalSlimBytes = 0;

  for (const file of files) {
    const raw = await readFile(path.join(SRC, file), "utf-8");
    totalRawBytes += raw.length;

    const data = JSON.parse(raw);
    const perFile = data.results ? summarizePerFile(data.results) : [];

    // Keep everything except results
    const slim = {
      tag: data.tag,
      timestamp: data.timestamp,
      generationModel: data.generationModel,
      model: data.model,
      judgeModel: data.judgeModel,
      iterations: data.iterations ?? data.runs,
      batchSize: data.batchSize,
      totalTimeMs: data.totalTimeMs,
      dimensions: data.dimensions,
      aggregate: data.aggregate,
      summary: data.summary,
      perFile,
    };

    const slimJson = JSON.stringify(slim, null, 2);
    totalSlimBytes += slimJson.length;
    await writeFile(path.join(DEST, file), slimJson);
  }

  console.log(`Processed ${files.length} files`);
  console.log(`Raw:  ${(totalRawBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Slim: ${(totalSlimBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Reduction: ${(100 - (totalSlimBytes / totalRawBytes) * 100).toFixed(1)}%`);
}

main();
