#!/usr/bin/env npx tsx

import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import ora from "ora";
import { ocr } from "../lib/ocr";
import { createModules, createCourse } from "../lib/create-course";
import { generateSlug } from "../lib/utils/slug";
import { AVAILABLE_MODELS, DEFAULT_MODEL, getModelPricing } from "../lib/utils/together";

const VERSION = "1.0.0";

function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model: string
): { cost: number; hasPricing: boolean } {
  const pricing = getModelPricing(model);
  if (!pricing) {
    return { cost: 0, hasPricing: false };
  }
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return { cost: inputCost + outputCost, hasPricing: true };
}

// Store original console methods before overriding
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// Use original for our own output
const log = originalConsole.log;

// Suppress library noise by default (re-enabled with --verbose)
let verboseMode = false;
const suppressPatterns = [
  /^  ❌/, 
  /^     /, 
  /^  ⚠️/, 
  /^\s+Reason:/, 
  /^\s+- \[/, 
  /^\s+Details:/,
  /Cannot polyfill.*Path2D/,
  /rendering may be broken/,
  /^Warning:/,
];

function shouldSuppress(args: any[]): boolean {
  if (verboseMode) return false;
  const msg = args[0];
  if (typeof msg !== "string") return false;
  return suppressPatterns.some((p) => p.test(msg));
}

console.log = (...args: any[]) => {
  if (!shouldSuppress(args)) originalConsole.log(...args);
};
console.warn = (...args: any[]) => {
  if (!shouldSuppress(args)) originalConsole.warn(...args);
};
console.error = (...args: any[]) => {
  if (!shouldSuppress(args)) originalConsole.error(...args);
};

// ANSI colors
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface CliArgs {
  command: string;
  file?: string;
  model: string;
  validateStructure: boolean;
  validateContent: boolean;
  retryFailures: boolean;
  maxRetries: number;
  runs: number;
  output?: string;
  saveText?: string;
  saveTextAuto: boolean;
  verbose: boolean;
}

function printBanner() {
  console.log(`
${cyan("╔══════════════════════════════════════════════════════════════╗")}
${cyan("║")}  ${bold("📚 Course Generator CLI")}                      ${dim(`v${VERSION}`)}    ${cyan("║")}
${cyan("║")}  ${dim("Transform PDFs into interactive lessons")}                   ${cyan("║")}
${cyan("╚══════════════════════════════════════════════════════════════╝")}
`);
}

function printHelp() {
  printBanner();
  console.log(`${bold("USAGE")}
  ${cyan("course")} ${yellow("<command>")} ${dim("[file]")} ${dim("[options]")}

${bold("COMMANDS")}
  ${yellow("generate")} ${dim("<file>")}     Generate a complete course from PDF/markdown
  ${yellow("modules")} ${dim("<file>")}      Generate only course structure (no lessons)
  ${yellow("benchmark")} ${dim("<file>")}    Compare all models on speed, accuracy, and cost
  ${yellow("help")}               Show this help message
  ${yellow("version")}            Show version number

${bold("OPTIONS")}
  ${dim("-m")}, ${dim("--model")} ${cyan("<name>")}   Model to use for generation
                       ${dim(`Models: ${Object.keys(AVAILABLE_MODELS).join(", ")}`)}
                       ${dim(`Default: deepseek`)}
  
  ${dim("--output")} ${cyan("<path>")}       Save output to specific path
                       ${dim("Default: data/{slug}-{timestamp}.json")}
  
  ${dim("--save-text")} ${cyan("<path>")}    Save extracted text to file (PDFs only)
  ${dim("--save-text-auto")}       Save text next to PDF as .md file
  
  ${dim("--no-validate")}          Skip all validation
  ${dim("--no-validate-structure")} Skip structure validation
  ${dim("--no-validate-content")}   Skip content validation
  
  ${dim("--no-retry")}             Don't auto-fix failed lessons
  ${dim("--max-retries")} ${cyan("<n>")}     Max retry attempts ${dim("(default: 3)")}
  ${dim("--runs")} ${cyan("<n>")}            Run generation n times ${dim("(for testing)")}
  ${dim("--verbose")}              Show detailed validation errors

${bold("EXAMPLES")}
  ${dim("# Generate course from PDF")}
  ${cyan("course generate")} data/document.pdf

  ${dim("# Use a different model")}
  ${cyan("course generate")} data/document.pdf ${dim("-m llama-70b")}

  ${dim("# Generate and cache OCR text")}
  ${cyan("course generate")} data/document.pdf --save-text-auto

  ${dim("# Generate from cached text (faster)")}
  ${cyan("course generate")} data/document.md

  ${dim("# Generate with custom output path")}
  ${cyan("course generate")} data/document.pdf --output my-course.json

  ${dim("# Quick generation (skip validation)")}
  ${cyan("course generate")} data/document.pdf --no-validate

  ${dim("# Only generate course structure")}
  ${cyan("course modules")} data/document.pdf

  ${dim("# Benchmark all models (5 runs each)")}
  ${cyan("course benchmark")} data/document.md --runs 5

${bold("ENVIRONMENT")}
  ${cyan("TOGETHER_API_KEY")}  Required. Your Together AI API key.
`);
}

function printVersion() {
  console.log(`course-cli v${VERSION}`);
}

// Download file from URL
async function downloadFile(url: string): Promise<string> {
  const tempPath = `./output/temp-${Date.now()}.pdf`;
  const spinner = ora("Downloading PDF from URL").start();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const { writeFileSync } = require("fs");
    writeFileSync(tempPath, buffer);

    spinner.succeed(`Downloaded to ${dim(tempPath)}`);
    return tempPath;
  } catch (error) {
    spinner.fail("Failed to download file");
    throw error;
  }
}

function isUrl(input: string): boolean {
  return input.startsWith("http://") || input.startsWith("https://");
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);

  // Handle no args or help
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  // Handle version
  if (args[0] === "version" || args[0] === "--version" || args[0] === "-v") {
    printVersion();
    process.exit(0);
  }

  // Handle --test-chart for quick chart testing
  if (args.includes("--test-chart")) {
    testBenchmarkChart();
    process.exit(0);
  }

  const command = args[0];
  const validCommands = ["generate", "modules", "gen", "mod", "benchmark", "bench"];

  if (!validCommands.includes(command)) {
    console.error(`\n${red("✗")} Unknown command: ${command}\n`);
    console.log(`Run ${cyan("course help")} for usage information.\n`);
    process.exit(1);
  }

  // Normalize aliases
  const normalizedCommand = command === "gen" ? "generate" 
    : command === "mod" ? "modules" 
    : command === "bench" ? "benchmark"
    : command;

  // File is required for generate/modules/benchmark
  const file = args[1];
  if (!file || file.startsWith("--")) {
    console.error(`\n${red("✗")} Missing file argument\n`);
    console.log(`Usage: ${cyan(`course ${normalizedCommand}`)} ${yellow("<file>")} ${dim("[options]")}\n`);
    process.exit(1);
  }

  let model = DEFAULT_MODEL;
  let validateStructure = true;
  let validateContent = true;
  let retryFailures = true;
  let maxRetries = 3;
  let runs = 1;
  let output: string | undefined;
  let saveText: string | undefined;
  let saveTextAuto = false;
  let verbose = false;

  // Parse flags
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-m" || arg === "--model") {
      const modelArg = args[++i];
      if (modelArg in AVAILABLE_MODELS) {
        model = AVAILABLE_MODELS[modelArg as keyof typeof AVAILABLE_MODELS];
      } else if (modelArg?.includes("/")) {
        // Allow full model names like "meta-llama/Llama-3.3-70B-Instruct-Turbo"
        model = modelArg;
      } else {
        console.error(`\n${red("✗")} Unknown model: ${modelArg}\n`);
        console.log(`Available models: ${Object.keys(AVAILABLE_MODELS).join(", ")}\n`);
        process.exit(1);
      }
    } else if (arg === "--no-validate") {
      validateStructure = false;
      validateContent = false;
    } else if (arg === "--no-validate-structure") {
      validateStructure = false;
    } else if (arg === "--no-validate-content") {
      validateContent = false;
    } else if (arg === "--no-retry") {
      retryFailures = false;
    } else if (arg === "--max-retries" && args[i + 1]) {
      maxRetries = parseInt(args[++i], 10);
    } else if (arg === "--runs" && args[i + 1]) {
      runs = parseInt(args[++i], 10);
    } else if (arg === "--output" && args[i + 1]) {
      output = args[++i];
    } else if (arg === "--save-text" && args[i + 1]) {
      saveText = args[++i];
    } else if (arg === "--save-text-auto") {
      saveTextAuto = true;
    } else if (arg === "--verbose") {
      verbose = true;
    }
  }

  return {
    command: normalizedCommand,
    file,
    model,
    validateStructure,
    validateContent,
    retryFailures,
    maxRetries,
    runs,
    output,
    saveText,
    saveTextAuto,
    verbose,
  };
}

async function extractContent(filePath: string, saveTextPath?: string): Promise<string> {
  if (filePath.endsWith(".pdf")) {
    const spinner = ora("Running OCR on PDF").start();
    const startTime = Date.now();

    try {
      const result = await ocr(filePath);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const content = result.pages.map((p) => p.content).join("\n\n");

      spinner.succeed(
        `OCR complete ${dim(`${result.pages.length} pages, ${elapsed}s`)}`
      );

      if (saveTextPath) {
        await writeFile(saveTextPath, content, "utf-8");
        console.log(`  ${dim("└─")} Saved to ${cyan(saveTextPath)}`);
      }

      return content;
    } catch (error) {
      spinner.fail("OCR failed");
      throw error;
    }
  } else if (filePath.endsWith(".md") || filePath.endsWith(".txt")) {
    const spinner = ora("Reading text file").start();
    const content = await readFile(filePath, "utf-8");
    spinner.succeed(`Loaded ${dim(`${content.length.toLocaleString()} chars`)}`);
    return content;
  } else {
    throw new Error("File must be .pdf, .md, or .txt");
  }
}

async function runGenerateModules(content: string, args: CliArgs) {
  const spinner = ora("Generating course modules").start();
  const startTime = Date.now();

  try {
    const courseStructure = await createModules({
      content,
      apiKey: process.env.TOGETHER_API_KEY || "",
      model: args.model,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const moduleCount = courseStructure.course.module.length;
    spinner.succeed(`Generated ${moduleCount} modules ${dim(`${elapsed}s`)}`);

    displayModules(courseStructure);

    return {
      title: courseStructure.course.title,
      modules: courseStructure.course.module,
    };
  } catch (error) {
    spinner.fail("Failed to generate modules");
    throw error;
  }
}

async function runGenerateCourse(content: string, args: CliArgs) {
  const spinner = ora("Generating course structure").start();
  const startTime = Date.now();

  try {
    // Update spinner text as we progress
    const course = await createCourse({
      content,
      apiKey: process.env.TOGETHER_API_KEY || "",
      model: args.model,
      validateStructure: args.validateStructure,
      validateContent: args.validateContent,
      retryFailures: args.retryFailures,
      maxRetries: args.maxRetries,
      onProgress: (type: string, message: string) => {
        spinner.text = message;
      },
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const lessonCount = course.modules.reduce((acc: number, m: any) => acc + m.lessons.length, 0);
    spinner.succeed(`Generated ${course.modules.length} modules, ${lessonCount} lessons ${dim(`${elapsed}s`)}`);

    displaySummary(course, args);
    displayCourse(course);

    return course;
  } catch (error) {
    spinner.fail("Course generation failed");
    throw error;
  }
}

async function runMultipleTimes(content: string, args: CliArgs) {
  console.log(`\n${yellow("🔁")} Running generation ${args.runs} times...\n`);
  console.log("═".repeat(60));

  const stats = {
    runs: args.runs,
    totalLessons: 0,
    totalFailed: 0,
    totalFixed: 0,
    totalTime: 0,
    runDetails: [] as any[],
  };

  let lastResult: any;

  for (let run = 1; run <= args.runs; run++) {
    const spinner = ora(`Run ${run}/${args.runs}`).start();
    const runStart = Date.now();

    try {
      let result: any;

      if (args.command === "modules") {
        spinner.text = `Run ${run}/${args.runs}: Generating modules`;
        result = await createModules({
          content,
          apiKey: process.env.TOGETHER_API_KEY || "",
          model: args.model,
        });
        result = { title: result.course.title, modules: result.course.module };
      } else {
        spinner.text = `Run ${run}/${args.runs}: Generating course`;
        result = await createCourse({
          content,
          apiKey: process.env.TOGETHER_API_KEY || "",
          model: args.model,
          validateStructure: args.validateStructure,
          validateContent: args.validateContent,
          retryFailures: args.retryFailures,
          maxRetries: args.maxRetries,
        });
      }

      const runTime = (Date.now() - runStart) / 1000;

      if (result.modules) {
        const lessons = result.modules.flatMap((m: any) => m.lessons || []);
        const failed = lessons.filter((l: any) => l.success === false).length;
        const fixed = lessons.filter((l: any) => l.success === true && l.data?.fixHistory).length;

        stats.totalLessons += lessons.length;
        stats.totalFailed += failed;
        stats.totalFixed += fixed;
        stats.totalTime += runTime;

        stats.runDetails.push({
          run,
          lessons: lessons.length,
          successful: lessons.length - failed,
          failed,
          fixed,
          time: runTime,
        });

        spinner.succeed(
          `Run ${run}: ${lessons.length - failed}/${lessons.length} lessons ${dim(`${runTime.toFixed(1)}s`)}`
        );
      } else {
        spinner.succeed(`Run ${run} complete ${dim(`${runTime.toFixed(1)}s`)}`);
      }

      lastResult = result;
    } catch (error) {
      spinner.fail(`Run ${run} failed`);
      stats.runDetails.push({
        run,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Display stats
  console.log("\n" + dim("─".repeat(50)));
  console.log(`${bold("Stats")} ${dim(`(${stats.runs} runs)`)}`);
  console.log(`  ${dim("Total lessons:")} ${stats.totalLessons}`);
  console.log(`  ${dim("Avg per run:")} ${(stats.totalLessons / stats.runs).toFixed(1)}`);
  if (stats.totalLessons > 0) {
    console.log(`  ${dim("Failed:")} ${stats.totalFailed} (${((stats.totalFailed / stats.totalLessons) * 100).toFixed(1)}%)`);
    console.log(`  ${dim("Fixed:")} ${stats.totalFixed} (${((stats.totalFixed / stats.totalLessons) * 100).toFixed(1)}%)`);
  }
  console.log(`  ${dim("Avg time:")} ${(stats.totalTime / stats.runs).toFixed(2)}s`);

  return { ...lastResult, testStats: stats };
}

interface BenchmarkResult {
  model: string;
  alias: string;
  runs: number;
  avgTime: number;
  avgAccuracy: number; // First-pass success rate (no fixes needed)
  avgCost: number;
  times: number[];
  accuracies: number[];
  costs: number[];
}

async function runBenchmark(content: string, args: CliArgs) {
  const runs = args.runs || 5;
  const models = Object.entries(AVAILABLE_MODELS);
  
  console.log(`\n${bold("🏁 Model Benchmark")}`);
  console.log(`${dim("Running each model")} ${cyan(runs.toString())} ${dim("times")}`);
  console.log(`${dim("Models:")} ${models.map(([alias]) => alias).join(", ")}\n`);
  console.log("═".repeat(60));

  const results: BenchmarkResult[] = [];

  for (const [alias, modelName] of models) {
    console.log(`\n${yellow("▶")} Testing ${bold(alias)} ${dim(`(${modelName})`)}`);
    
    const times: number[] = [];
    const accuracies: number[] = [];
    const costs: number[] = [];

    for (let run = 1; run <= runs; run++) {
      const spinner = ora(`  Run ${run}/${runs}`).start();
      const runStart = Date.now();

      try {
        const result = await createCourse({
          content,
          apiKey: process.env.TOGETHER_API_KEY || "",
          model: modelName,
          validateStructure: true,
          validateContent: true,
          retryFailures: true,
          maxRetries: 3,
        });

        const runTime = (Date.now() - runStart) / 1000;
        times.push(runTime);

        // Calculate first-pass accuracy (lessons without fixHistory)
        let totalLessons = 0;
        let firstPassSuccess = 0;
        for (const module of result.modules) {
          for (const lesson of module.lessons) {
            totalLessons++;
            if (lesson.success && !lesson.data?.fixHistory) {
              firstPassSuccess++;
            }
          }
        }
        const accuracy = totalLessons > 0 ? (firstPassSuccess / totalLessons) * 100 : 0;
        accuracies.push(accuracy);

        // Calculate cost
        const { cost } = calculateCost(
          result.tokenUsage?.inputTokens || 0,
          result.tokenUsage?.outputTokens || 0,
          modelName
        );
        costs.push(cost);

        spinner.succeed(`  Run ${run}: ${accuracy.toFixed(0)}% accuracy, ${runTime.toFixed(1)}s, $${cost.toFixed(4)}`);
      } catch (error) {
        const runTime = (Date.now() - runStart) / 1000;
        times.push(runTime);
        accuracies.push(0);
        costs.push(0);
        spinner.fail(`  Run ${run}: Failed - ${error instanceof Error ? error.message.slice(0, 50) : 'Unknown error'}`);
      }
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const avgAccuracy = accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
    const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;

    results.push({
      model: modelName,
      alias,
      runs,
      avgTime,
      avgAccuracy,
      avgCost,
      times,
      accuracies,
      costs,
    });

    console.log(`  ${dim("Avg:")} ${avgAccuracy.toFixed(1)}% accuracy, ${avgTime.toFixed(1)}s, $${avgCost.toFixed(4)}`);
  }

  // Display results
  displayBenchmarkResults(results);
}

function displayBenchmarkResults(results: BenchmarkResult[]) {
  console.log("\n" + "═".repeat(60));
  console.log(`\n${bold("📊 Benchmark Results")}\n`);

  // Sort by accuracy (descending) for ranking
  const sorted = [...results].sort((a, b) => b.avgAccuracy - a.avgAccuracy);

  // Summary Table
  console.log("┌" + "─".repeat(18) + "┬" + "─".repeat(10) + "┬" + "─".repeat(12) + "┬" + "─".repeat(10) + "┐");
  console.log("│ " + bold("Model".padEnd(16)) + " │ " + bold("Speed".padEnd(8)) + " │ " + bold("Accuracy".padEnd(10)) + " │ " + bold("Cost".padEnd(8)) + " │");
  console.log("├" + "─".repeat(18) + "┼" + "─".repeat(10) + "┼" + "─".repeat(12) + "┼" + "─".repeat(10) + "┤");
  
  for (const r of sorted) {
    const speedStr = `${r.avgTime.toFixed(1)}s`.padEnd(8);
    const accuracyStr = `${r.avgAccuracy.toFixed(1)}%`.padEnd(10);
    const costStr = `$${r.avgCost.toFixed(4)}`.padEnd(8);
    console.log(`│ ${r.alias.padEnd(16)} │ ${speedStr} │ ${accuracyStr} │ ${costStr} │`);
  }
  
  console.log("└" + "─".repeat(18) + "┴" + "─".repeat(10) + "┴" + "─".repeat(12) + "┴" + "─".repeat(10) + "┘");

  // Bar charts for each metric
  const maxCost = Math.max(...results.map(r => r.avgCost));
  const maxTime = Math.max(...results.map(r => r.avgTime));
  const barWidth = 30;
  
  // Accuracy bars (higher is better)
  console.log(`\n${bold("Accuracy")} ${dim("(higher is better)")}`);
  for (const r of sorted) {
    const barLen = Math.round((r.avgAccuracy / 100) * barWidth);
    const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen);
    const color = r.avgAccuracy >= 90 ? green : r.avgAccuracy >= 70 ? yellow : red;
    console.log(`  ${r.alias.padEnd(16)} ${color(bar)} ${r.avgAccuracy.toFixed(1)}%`);
  }

  // Cost bars (lower is better) - sorted by cost ascending
  const byCost = [...results].sort((a, b) => a.avgCost - b.avgCost);
  console.log(`\n${bold("Cost")} ${dim("(lower is better)")}`);
  for (const r of byCost) {
    const barLen = maxCost > 0 ? Math.round((r.avgCost / maxCost) * barWidth) : 0;
    const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen);
    const color = r.avgCost <= maxCost * 0.4 ? green : r.avgCost <= maxCost * 0.7 ? yellow : red;
    console.log(`  ${r.alias.padEnd(16)} ${color(bar)} $${r.avgCost.toFixed(4)}`);
  }

  // Speed bars (lower is better) - sorted by time ascending
  const bySpeed = [...results].sort((a, b) => a.avgTime - b.avgTime);
  console.log(`\n${bold("Speed")} ${dim("(lower is better)")}`);
  for (const r of bySpeed) {
    const barLen = maxTime > 0 ? Math.round((r.avgTime / maxTime) * barWidth) : 0;
    const bar = "█".repeat(barLen) + "░".repeat(barWidth - barLen);
    const color = r.avgTime <= maxTime * 0.4 ? green : r.avgTime <= maxTime * 0.7 ? yellow : red;
    console.log(`  ${r.alias.padEnd(16)} ${color(bar)} ${r.avgTime.toFixed(1)}s`);
  }

  // Winner summary
  console.log(`\n${bold("🏆 Best in Category")}`);
  const bestAccuracy = sorted[0];
  const bestCost = byCost[0];
  const bestSpeed = bySpeed[0];
  console.log(`  ${green("Accuracy:")} ${bestAccuracy.alias} (${bestAccuracy.avgAccuracy.toFixed(1)}%)`);
  console.log(`  ${green("Cost:")} ${bestCost.alias} ($${bestCost.avgCost.toFixed(4)})`);
  console.log(`  ${green("Speed:")} ${bestSpeed.alias} (${bestSpeed.avgTime.toFixed(1)}s)`);
}

// Test the chart rendering with mock data
function testBenchmarkChart() {
  const mockResults: BenchmarkResult[] = [
    { model: "openai/gpt-oss-120b", alias: "gpt-oss-120b", runs: 5, avgTime: 73.7, avgAccuracy: 91.7, avgCost: 0.0194, times: [], accuracies: [], costs: [] },
    { model: "deepseek-ai/DeepSeek-V3.1", alias: "deepseek-3.1", runs: 5, avgTime: 379.3, avgAccuracy: 66.7, avgCost: 0.0653, times: [], accuracies: [], costs: [] },
    { model: "zai-org/GLM-4.6", alias: "glm-4.6", runs: 5, avgTime: 58.6, avgAccuracy: 88.9, avgCost: 0.0829, times: [], accuracies: [], costs: [] },
    { model: "moonshotai/Kimi-K2-Thinking", alias: "kimi-k2-thinking", runs: 5, avgTime: 62.6, avgAccuracy: 0, avgCost: 0, times: [], accuracies: [], costs: [] },
  ];
  
  console.log(`\n${bold("🧪 Test Mode: Displaying chart with mock data")}\n`);
  displayBenchmarkResults(mockResults);
}

function displayModules(courseStructure: any) {
  console.log("\n" + dim("─".repeat(50)));
  console.log(`${bold("Course")}: ${courseStructure.course.title}\n`);

  courseStructure.course.module.forEach((module: any, i: number) => {
    console.log(`${cyan(`${i + 1}.`)} ${module.title}`);
  });
  console.log("");
}

function displaySummary(course: { modules: any[] }, args: CliArgs) {
  let total = 0,
    successful = 0,
    fixed = 0,
    failed = 0,
    fixAttempts = 0;

  for (const module of course.modules) {
    for (const lessonResult of module.lessons) {
      total++;
      if (lessonResult.success) {
        successful++;
        if (lessonResult.data.fixHistory?.length > 0) {
          fixed++;
          fixAttempts += lessonResult.data.fixHistory.length;
        }
      } else {
        failed++;
        if (lessonResult.error?.fixHistory) {
          fixAttempts += lessonResult.error.fixHistory.length;
        }
      }
    }
  }

  console.log("\n" + dim("─".repeat(50)));
  console.log(`${bold("Summary")}`);
  console.log(`  ${dim("Modules:")} ${course.modules.length}`);
  console.log(`  ${dim("Lessons:")} ${total}`);
  console.log(`  ${green("✓")} Successful: ${successful} (${Math.round((successful / total) * 100)}%)`);
  if (fixed > 0) console.log(`  ${yellow("🔧")} Fixed: ${fixed}`);
  if (failed > 0) console.log(`  ${red("✗")} Failed: ${failed}`);
  if (fixAttempts > 0) console.log(`  ${dim("Fix attempts:")} ${fixAttempts}`);
}

function displayCourse(course: { title: string; modules: any[] }) {
  console.log("\n" + dim("─".repeat(50)));
  console.log(`${bold("Course")}: ${course.title}\n`);

  for (let i = 0; i < course.modules.length; i++) {
    const mod = course.modules[i];
    console.log(`${cyan(`${i + 1}.`)} ${mod.title}`);

    for (const lesson of mod.lessons) {
      if (lesson.success) {
        const fixInfo = lesson.data.fixHistory ? ` ${yellow("🔧")}` : "";
        console.log(`   ${green("✓")} ${lesson.data.title} ${dim(`[${lesson.data.questionType}]`)}${fixInfo}`);
      } else {
        console.log(`   ${red("✗")} ${lesson.data?.title || "Unknown"} ${dim(`[${lesson.error?.validationType}]`)}`);
      }
    }
    console.log("");
  }
}

async function main() {
  const args = parseArgs();

  // Enable verbose output if requested
  if (args.verbose) {
    verboseMode = true;
  }

  // Check for API key
  if (!process.env.TOGETHER_API_KEY) {
    console.error(`\n${red("✗")} Missing ${cyan("TOGETHER_API_KEY")} environment variable\n`);
    console.log(`Set it in your ${cyan(".env.local")} file or export it:\n`);
    console.log(`  ${dim("export TOGETHER_API_KEY=your-api-key")}\n`);
    process.exit(1);
  }

  let filePath = args.file!;
  let isTemp = false;

  try {
    // Download if URL
    if (isUrl(filePath)) {
      filePath = await downloadFile(filePath);
      isTemp = true;
    } else if (!existsSync(filePath)) {
      console.error(`\n${red("✗")} File not found: ${filePath}\n`);
      process.exit(1);
    }

    // Get model alias for display
    const modelAlias = Object.entries(AVAILABLE_MODELS).find(([_, v]) => v === args.model)?.[0] || args.model;
    
    console.log(`\n${dim("File:")} ${cyan(filePath)}`);
    console.log(`${dim("Model:")} ${cyan(modelAlias)}`);
    console.log(`${dim("Mode:")} ${args.command === "modules" ? "modules only" : "full course"}`);
    if (args.command !== "modules") {
      console.log(`${dim("Validation:")} ${args.validateStructure || args.validateContent ? "enabled" : "disabled"}`);
    }
    console.log("");

    // Determine save text path
    let saveTextPath: string | undefined;
    if (filePath.endsWith(".pdf")) {
      if (args.saveText) {
        saveTextPath = args.saveText;
      } else if (args.saveTextAuto) {
        saveTextPath = filePath.replace(".pdf", ".md");
      }
    }

    // Extract content
    const content = await extractContent(filePath, saveTextPath);

    // Execute command
    let result: any;

    if (args.command === "benchmark") {
      await runBenchmark(content, args);
      // Benchmark doesn't save output
      if (isTemp) {
        await unlink(filePath);
      }
      console.log("");
      return;
    } else if (args.runs > 1) {
      result = await runMultipleTimes(content, args);
    } else if (args.command === "modules") {
      result = await runGenerateModules(content, args);
    } else {
      result = await runGenerateCourse(content, args);
    }

    // Save output
    const saveSpinner = ora("Saving output").start();
    let outputPath = args.output;
    if (!outputPath) {
      const courseTitle = result.title || "course";
      const slug = generateSlug(courseTitle, Date.now().toString());
      const isoTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      outputPath = join("data", `${slug}-${isoTimestamp}.json`);
      await mkdir("data", { recursive: true });
    }

    await writeFile(outputPath, JSON.stringify(result, null, 2));
    saveSpinner.succeed(`Saved to ${cyan(outputPath)}`);

    // Cleanup
    if (isTemp) {
      await unlink(filePath);
    }

    console.log("");
  } catch (error) {
    console.error(`\n${red("✗")} Error:`, error);
    if (isTemp && existsSync(filePath)) {
      await unlink(filePath);
    }
    process.exit(1);
  }
}

main();
