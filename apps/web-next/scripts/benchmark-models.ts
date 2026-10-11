#!/usr/bin/env npx tsx

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { ocr } from "../lib/ocr";
import { createCourse, type CourseOutput } from "../lib/create-course";
import { MODEL_CONFIG, type ModelAlias } from "../lib/utils/together";

// ANSI colors
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

// Suppress library noise
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const log = originalConsole.log;

const suppressPatterns = [
  /^  ❌/, /^     /, /^  ⚠️/, /^\s+Reason:/, /^\s+- \[/,
  /^\s+Details:/, /Cannot polyfill.*Path2D/, /rendering may be broken/, /^Warning:/,
];

console.log = (...args: any[]) => {
  const msg = args[0];
  if (typeof msg === "string" && suppressPatterns.some((p) => p.test(msg))) return;
  originalConsole.log(...args);
};
console.warn = (...args: any[]) => {
  const msg = args[0];
  if (typeof msg === "string" && suppressPatterns.some((p) => p.test(msg))) return;
  originalConsole.warn(...args);
};
console.error = (...args: any[]) => {
  const msg = args[0];
  if (typeof msg === "string" && suppressPatterns.some((p) => p.test(msg))) return;
  originalConsole.error(...args);
};

// Models to benchmark (subset of MODEL_CONFIG)
const BENCHMARK_MODELS: { alias: string; fullName: string }[] = [
  { alias: "gpt-oss-120b", fullName: "openai/gpt-oss-120b" },
  { alias: "MiniMax-M2.7", fullName: "MiniMaxAI/MiniMax-M2.7" },
  { alias: "GLM-5", fullName: "zai-org/GLM-5" },
  { alias: "Kimi-K2.5", fullName: "moonshotai/Kimi-K2.5" },
  { alias: "Qwen3.5-397B", fullName: "Qwen/Qwen3.5-397B-A17B" },
];

const DATA_DIR = join(process.cwd(), "data");
const CACHE_DIR = join(DATA_DIR, ".cache");

interface BenchmarkRunResult {
  model: string;
  alias: string;
  pdf: string;
  totalTimeMs: number;
  lessonsTotal: number;
  lessonsSuccessful: number;
  lessonsFailed: number;
  lessonsFixed: number;
  fixAttempts: number;
  successRate: number;
  error?: string;
}

interface CliArgs {
  models: string[];
  pdfs: string[];
  skipOcr: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let models: string[] = [];
  let pdfs: string[] = [];
  let skipOcr = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--models" && args[i + 1]) {
      models = args[++i].split(",").map((s) => s.trim());
    } else if (arg === "--pdfs" && args[i + 1]) {
      pdfs = args[++i].split(",").map((s) => s.trim());
    } else if (arg === "--skip-ocr") {
      skipOcr = true;
    }
  }

  return { models, pdfs, skipOcr };
}

// ── Phase 1: OCR with caching ──

async function ensureCacheDir() {
  await mkdir(CACHE_DIR, { recursive: true });
}

function cachePathForPdf(pdfName: string): string {
  return join(CACHE_DIR, pdfName.replace(/\.pdf$/, ".txt"));
}

async function getOcrText(pdfPath: string, apiKey: string, skipOcr: boolean): Promise<string> {
  const pdfName = basename(pdfPath);
  const cachePath = cachePathForPdf(pdfName);

  // Check cache first
  if (existsSync(cachePath)) {
    const cached = await readFile(cachePath, "utf-8");
    log(`  ${green("✓")} Cache hit: ${dim(pdfName)} ${dim(`(${cached.length.toLocaleString()} chars)`)}`);
    return cached;
  }

  if (skipOcr) {
    throw new Error(`No cached OCR for ${pdfName} and --skip-ocr is set`);
  }

  // Run OCR
  log(`  ${yellow("⏳")} Running OCR on ${pdfName}...`);
  const startTime = Date.now();
  const result = await ocr(pdfPath, {
    apiKey,
    maintainFormat: false,
    concurrency: 5,
  });

  const content = result.pages.map((p) => p.content).join("\n\n");
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Cache the result
  await writeFile(cachePath, content, "utf-8");
  log(`  ${green("✓")} OCR complete: ${dim(pdfName)} ${dim(`(${result.pages.length} pages, ${elapsed}s, cached)`)}`);

  return content;
}

// ── Phase 2: Benchmark ──

async function benchmarkModel(
  alias: string,
  modelFullName: string,
  content: string,
  pdfName: string,
  apiKey: string
): Promise<BenchmarkRunResult> {
  const startTime = Date.now();

  try {
    const course = await createCourse({
      content,
      apiKey,
      model: modelFullName,
      validateStructure: true,
      validateContent: true,
      retryFailures: true,
      maxRetries: 3,
    });

    const totalTimeMs = Date.now() - startTime;

    // Collect stats
    let lessonsTotal = 0;
    let lessonsSuccessful = 0;
    let lessonsFailed = 0;
    let lessonsFixed = 0;
    let fixAttempts = 0;

    for (const mod of course.modules) {
      for (const lesson of mod.lessons) {
        lessonsTotal++;
        if (lesson.success) {
          lessonsSuccessful++;
          if (lesson.data.fixHistory && lesson.data.fixHistory.length > 0) {
            lessonsFixed++;
            fixAttempts += lesson.data.fixHistory.length;
          }
        } else {
          lessonsFailed++;
          if (lesson.error?.fixHistory) {
            fixAttempts += lesson.error.fixHistory.length;
          }
        }
      }
    }

    const successRate = lessonsTotal > 0 ? (lessonsSuccessful / lessonsTotal) * 100 : 0;

    return {
      model: modelFullName,
      alias,
      pdf: pdfName,
      totalTimeMs,
      lessonsTotal,
      lessonsSuccessful,
      lessonsFailed,
      lessonsFixed,
      fixAttempts,
      successRate,
    };
  } catch (error) {
    const totalTimeMs = Date.now() - startTime;
    return {
      model: modelFullName,
      alias,
      pdf: pdfName,
      totalTimeMs,
      lessonsTotal: 0,
      lessonsSuccessful: 0,
      lessonsFailed: 0,
      lessonsFixed: 0,
      fixAttempts: 0,
      successRate: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Phase 3: Report ──

interface AggregatedResult {
  alias: string;
  model: string;
  runs: number;
  avgTimeS: number;
  totalLessons: number;
  totalSuccessful: number;
  totalFailed: number;
  totalFixed: number;
  totalFixAttempts: number;
  avgSuccessRate: number;
  errors: number;
}

function aggregateResults(results: BenchmarkRunResult[]): AggregatedResult[] {
  const byModel = new Map<string, BenchmarkRunResult[]>();

  for (const r of results) {
    const existing = byModel.get(r.alias) || [];
    existing.push(r);
    byModel.set(r.alias, existing);
  }

  const aggregated: AggregatedResult[] = [];

  for (const [alias, runs] of byModel) {
    const successful = runs.filter((r) => !r.error);
    const errors = runs.filter((r) => r.error).length;

    const avgTimeS = successful.length > 0
      ? successful.reduce((sum, r) => sum + r.totalTimeMs, 0) / successful.length / 1000
      : 0;

    const totalLessons = successful.reduce((sum, r) => sum + r.lessonsTotal, 0);
    const totalSuccessful = successful.reduce((sum, r) => sum + r.lessonsSuccessful, 0);
    const totalFailed = successful.reduce((sum, r) => sum + r.lessonsFailed, 0);
    const totalFixed = successful.reduce((sum, r) => sum + r.lessonsFixed, 0);
    const totalFixAttempts = successful.reduce((sum, r) => sum + r.fixAttempts, 0);
    const avgSuccessRate = successful.length > 0
      ? successful.reduce((sum, r) => sum + r.successRate, 0) / successful.length
      : 0;

    aggregated.push({
      alias,
      model: runs[0].model,
      runs: runs.length,
      avgTimeS,
      totalLessons,
      totalSuccessful,
      totalFailed,
      totalFixed,
      totalFixAttempts,
      avgSuccessRate,
      errors,
    });
  }

  return aggregated;
}

function printComparisonTable(aggregated: AggregatedResult[]) {
  log("\n" + "═".repeat(70));
  log(`\n${bold("📊 Benchmark Results")}\n`);

  // Sort by success rate descending
  const sorted = [...aggregated].sort((a, b) => b.avgSuccessRate - a.avgSuccessRate);

  // Table header
  const cols = {
    model: 18,
    time: 10,
    rate: 10,
    lessons: 10,
    failed: 8,
    fixed: 8,
    fixes: 8,
    errs: 6,
  };

  log(
    "┌" + "─".repeat(cols.model) +
    "┬" + "─".repeat(cols.time) +
    "┬" + "─".repeat(cols.rate) +
    "┬" + "─".repeat(cols.lessons) +
    "┬" + "─".repeat(cols.failed) +
    "┬" + "─".repeat(cols.fixed) +
    "┬" + "─".repeat(cols.fixes) +
    "┬" + "─".repeat(cols.errs) +
    "┐"
  );
  log(
    "│ " + bold("Model".padEnd(cols.model - 2)) + " " +
    "│ " + bold("Time".padEnd(cols.time - 2)) + " " +
    "│ " + bold("Success%".padEnd(cols.rate - 2)) + " " +
    "│ " + bold("Lessons".padEnd(cols.lessons - 2)) + " " +
    "│ " + bold("Failed".padEnd(cols.failed - 2)) + " " +
    "│ " + bold("Fixed".padEnd(cols.fixed - 2)) + " " +
    "│ " + bold("Fixes".padEnd(cols.fixes - 2)) + " " +
    "│ " + bold("Errs".padEnd(cols.errs - 2)) + " " +
    "│"
  );
  log(
    "├" + "─".repeat(cols.model) +
    "┼" + "─".repeat(cols.time) +
    "┼" + "─".repeat(cols.rate) +
    "┼" + "─".repeat(cols.lessons) +
    "┼" + "─".repeat(cols.failed) +
    "┼" + "─".repeat(cols.fixed) +
    "┼" + "─".repeat(cols.fixes) +
    "┼" + "─".repeat(cols.errs) +
    "┤"
  );

  for (const r of sorted) {
    const timeStr = r.avgTimeS > 0 ? `${r.avgTimeS.toFixed(1)}s` : "N/A";
    const rateStr = r.avgSuccessRate > 0 ? `${r.avgSuccessRate.toFixed(1)}%` : "0%";
    const rateColor = r.avgSuccessRate >= 90 ? green : r.avgSuccessRate >= 70 ? yellow : red;

    log(
      "│ " + r.alias.padEnd(cols.model - 2) + " " +
      "│ " + timeStr.padEnd(cols.time - 2) + " " +
      "│ " + rateColor(rateStr.padEnd(cols.rate - 2)) + " " +
      "│ " + String(r.totalLessons).padEnd(cols.lessons - 2) + " " +
      "│ " + String(r.totalFailed).padEnd(cols.failed - 2) + " " +
      "│ " + String(r.totalFixed).padEnd(cols.fixed - 2) + " " +
      "│ " + String(r.totalFixAttempts).padEnd(cols.fixes - 2) + " " +
      "│ " + String(r.errors).padEnd(cols.errs - 2) + " " +
      "│"
    );
  }

  log(
    "└" + "─".repeat(cols.model) +
    "┴" + "─".repeat(cols.time) +
    "┴" + "─".repeat(cols.rate) +
    "┴" + "─".repeat(cols.lessons) +
    "┴" + "─".repeat(cols.failed) +
    "┴" + "─".repeat(cols.fixed) +
    "┴" + "─".repeat(cols.fixes) +
    "┴" + "─".repeat(cols.errs) +
    "┘"
  );

  // Bar charts
  const barWidth = 30;

  // Success rate bars
  log(`\n${bold("Success Rate")} ${dim("(higher is better)")}`);
  for (const r of sorted) {
    const barLen = Math.round((r.avgSuccessRate / 100) * barWidth);
    const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen);
    const color = r.avgSuccessRate >= 90 ? green : r.avgSuccessRate >= 70 ? yellow : red;
    log(`  ${r.alias.padEnd(18)} ${color(bar)} ${r.avgSuccessRate.toFixed(1)}%`);
  }

  // Speed bars (lower is better)
  const bySpeed = [...aggregated].sort((a, b) => a.avgTimeS - b.avgTimeS);
  const maxTime = Math.max(...aggregated.map((r) => r.avgTimeS));
  log(`\n${bold("Speed")} ${dim("(lower is better)")}`);
  for (const r of bySpeed) {
    const barLen = maxTime > 0 ? Math.round((r.avgTimeS / maxTime) * barWidth) : 0;
    const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen);
    const color = r.avgTimeS <= maxTime * 0.4 ? green : r.avgTimeS <= maxTime * 0.7 ? yellow : red;
    log(`  ${r.alias.padEnd(18)} ${color(bar)} ${r.avgTimeS.toFixed(1)}s`);
  }

  // Winner summary
  log(`\n${bold("🏆 Best in Category")}`);
  const bestAccuracy = sorted[0];
  const bestSpeed = bySpeed[0];
  log(`  ${green("Accuracy:")} ${bestAccuracy.alias} (${bestAccuracy.avgSuccessRate.toFixed(1)}%)`);
  log(`  ${green("Speed:")}    ${bestSpeed.alias} (${bestSpeed.avgTimeS.toFixed(1)}s)`);
}

// ── Main ──

async function main() {
  const cliArgs = parseArgs();
  const apiKey = process.env.TOGETHER_API_KEY;

  if (!apiKey) {
    log(`\n${red("✗")} Missing ${cyan("TOGETHER_API_KEY")} environment variable\n`);
    process.exit(1);
  }

  // Resolve which models to run
  let models = BENCHMARK_MODELS;
  if (cliArgs.models.length > 0) {
    models = BENCHMARK_MODELS.filter((m) => cliArgs.models.includes(m.alias));
    if (models.length === 0) {
      log(`\n${red("✗")} No matching models found. Available: ${BENCHMARK_MODELS.map((m) => m.alias).join(", ")}\n`);
      process.exit(1);
    }
  }

  // Resolve which PDFs to use
  let pdfFiles: string[];
  if (cliArgs.pdfs.length > 0) {
    pdfFiles = cliArgs.pdfs.map((p) => join(DATA_DIR, p));
    for (const f of pdfFiles) {
      if (!existsSync(f)) {
        log(`\n${red("✗")} PDF not found: ${f}\n`);
        process.exit(1);
      }
    }
  } else {
    const allFiles = await readdir(DATA_DIR);
    pdfFiles = allFiles.filter((f) => f.endsWith(".pdf")).map((f) => join(DATA_DIR, f));
    if (pdfFiles.length === 0) {
      log(`\n${red("✗")} No PDF files found in ${DATA_DIR}\n`);
      process.exit(1);
    }
  }

  log(`\n${bold("🏁 Model Benchmark")}`);
  log(`${dim("Models:")} ${models.map((m) => m.alias).join(", ")}`);
  log(`${dim("PDFs:")}   ${pdfFiles.map((f) => basename(f)).join(", ")}`);
  log("");

  // Phase 1: OCR caching
  log(`${bold("Phase 1: OCR")} ${dim("(cached)")}`);
  await ensureCacheDir();

  const pdfContents = new Map<string, string>();

  for (const pdfPath of pdfFiles) {
    const pdfName = basename(pdfPath);
    try {
      const content = await getOcrText(pdfPath, apiKey, cliArgs.skipOcr);
      pdfContents.set(pdfName, content);
    } catch (error) {
      log(`  ${red("✗")} ${pdfName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (pdfContents.size === 0) {
    log(`\n${red("✗")} No PDFs could be processed. Exiting.\n`);
    process.exit(1);
  }

  log("");

  // Phase 2: Benchmark
  log(`${bold("Phase 2: Benchmark")}`);
  log("═".repeat(60));

  const allResults: BenchmarkRunResult[] = [];

  for (const model of models) {
    log(`\n${yellow("▶")} ${bold(model.alias)} ${dim(`(${model.fullName})`)}`);

    for (const [pdfName, content] of pdfContents) {
      log(`  ${dim("PDF:")} ${pdfName}`);
      const startTime = Date.now();

      const result = await benchmarkModel(model.alias, model.fullName, content, pdfName, apiKey);
      allResults.push(result);

      const elapsed = (result.totalTimeMs / 1000).toFixed(1);

      if (result.error) {
        log(`  ${red("✗")} Failed: ${result.error.slice(0, 80)}`);
      } else {
        log(
          `  ${green("✓")} ${result.lessonsSuccessful}/${result.lessonsTotal} lessons ` +
          `(${result.successRate.toFixed(0)}%) ` +
          dim(`${elapsed}s`) +
          (result.lessonsFixed > 0 ? ` ${yellow(`${result.lessonsFixed} fixed`)}` : "") +
          (result.lessonsFailed > 0 ? ` ${red(`${result.lessonsFailed} failed`)}` : "")
        );
      }
    }
  }

  // Phase 3: Report
  const aggregated = aggregateResults(allResults);
  printComparisonTable(aggregated);

  // Save raw results
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const resultsPath = join(CACHE_DIR, `benchmark-results-${timestamp}.json`);
  await writeFile(
    resultsPath,
    JSON.stringify({ timestamp: new Date().toISOString(), models: models.map((m) => m.alias), pdfs: Array.from(pdfContents.keys()), results: allResults, aggregated }, null, 2)
  );
  log(`\n${dim("Results saved to")} ${cyan(resultsPath)}\n`);
}

main();
