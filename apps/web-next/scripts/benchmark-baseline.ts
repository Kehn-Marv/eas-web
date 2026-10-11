#!/usr/bin/env tsx
/**
 * Baseline benchmark using the XML pipeline for comparison with JSON+Zod.
 * Only supports .md files (pre-OCR'd).
 */

import { createCourse } from "../lib/create-course";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data");
const BENCHMARKS_DIR = resolve(DATA_DIR, "benchmarks");

const args = process.argv.slice(2);
const tag =
  args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "baseline";
const inputFiles = args
  .filter((a) => !a.startsWith("--"))
  .map((f) => resolve(f));

if (inputFiles.length === 0) {
  console.error("Usage: tsx scripts/benchmark-baseline.ts --tag=<name> <file1.md> [file2.md...]");
  process.exit(1);
}

const apiKey = process.env.TOGETHER_API_KEY;
if (!apiKey) {
  console.error("TOGETHER_API_KEY is required");
  process.exit(1);
}

interface LessonMetric {
  title: string;
  questionType: string;
  success: boolean;
  wasFixed: boolean;
  fixAttempts: number;
}

interface ModuleMetric {
  title: string;
  lessons: LessonMetric[];
}

interface RunResult {
  file: string;
  contentLength: number;
  courseTimeMs: number;
  modules: ModuleMetric[];
  totalLessons: number;
  firstPassSuccess: number;
  finalSuccess: number;
  finalFailed: number;
}

async function benchmarkFile(filePath: string): Promise<RunResult> {
  const fileName = basename(filePath).replace(/\.(md|ocr\.md)$/, "");
  console.log(`\n📄 ${basename(filePath)}`);
  console.log("─".repeat(60));

  const content = readFileSync(filePath, "utf-8");

  if (content.length < 100) {
    console.error(`  ⚠️  Content too short (${content.length} chars) — skipping`);
    return {
      file: fileName, contentLength: content.length, courseTimeMs: 0,
      modules: [], totalLessons: 0, firstPassSuccess: 0, finalSuccess: 0, finalFailed: 0,
    };
  }

  const maxChars = 20000;
  const truncatedContent = content.length > maxChars
    ? content.substring(0, maxChars) + "\n\n[Content truncated for benchmarking]"
    : content;

  if (content.length > maxChars) {
    console.log(`  ✂️  Truncated from ${content.length} to ${maxChars} chars`);
  }

  const courseStart = Date.now();
  const course = await createCourse({
    content: truncatedContent,
    apiKey: apiKey!,
    validateStructure: true,
    validateContent: true,
    retryFailures: true,
    maxRetries: 3,
  });
  const courseTimeMs = Date.now() - courseStart;

  const modules: ModuleMetric[] = course.modules.map((mod) => ({
    title: mod.title,
    lessons: mod.lessons.map((lr) => {
      const wasFixed =
        lr.success && lr.data?.fixHistory && lr.data.fixHistory.length > 0;
      return {
        title: lr.success ? lr.data.title : lr.data?.title ?? "unknown",
        questionType: lr.success
          ? lr.data.questionType
          : lr.data?.questionType ?? "unknown",
        success: lr.success,
        wasFixed: !!wasFixed,
        fixAttempts: lr.success
          ? lr.data?.fixHistory?.length ?? 0
          : (lr as any).error?.attempts ?? 0,
      };
    }),
  }));

  const allLessons = modules.flatMap((m) => m.lessons);
  const totalLessons = allLessons.length;
  const finalSuccess = allLessons.filter((l) => l.success).length;
  const firstPassSuccess = allLessons.filter(
    (l) => l.success && !l.wasFixed
  ).length;
  const finalFailed = totalLessons - finalSuccess;

  console.log(`  ⏱  Course gen: ${(courseTimeMs / 1000).toFixed(1)}s`);
  console.log(`  📊 Lessons: ${totalLessons} total`);
  console.log(
    `  ✅ First-pass: ${firstPassSuccess}/${totalLessons} (${Math.round((firstPassSuccess / totalLessons) * 100)}%)`
  );
  console.log(
    `  ✅ Final:      ${finalSuccess}/${totalLessons} (${Math.round((finalSuccess / totalLessons) * 100)}%)`
  );
  if (finalFailed > 0) console.log(`  ❌ Failed:     ${finalFailed}`);

  modules.forEach((mod) => {
    console.log(`\n  Module: "${mod.title}"`);
    mod.lessons.forEach((l) => {
      const status = l.success ? (l.wasFixed ? "🔧" : "✅") : "❌";
      const fixInfo =
        l.fixAttempts > 0
          ? ` (${l.fixAttempts} fix${l.fixAttempts > 1 ? "es" : ""})`
          : "";
      console.log(
        `    ${status} ${l.questionType.padEnd(16)} "${l.title}"${fixInfo}`
      );
    });
  });

  return {
    file: fileName,
    contentLength: truncatedContent.length,
    courseTimeMs,
    modules,
    totalLessons,
    firstPassSuccess,
    finalSuccess,
    finalFailed,
  };
}

async function main() {
  console.log(`\n🏁 Benchmark: ${tag} (XML baseline)`);
  console.log(`   Model: openai/gpt-oss-120b`);
  console.log(`   Files: ${inputFiles.map((f) => basename(f)).join(", ")}`);

  const results: RunResult[] = [];

  for (const file of inputFiles) {
    if (!existsSync(file)) {
      console.error(`File not found: ${file}`);
      continue;
    }
    try {
      const result = await benchmarkFile(file);
      results.push(result);
    } catch (error: any) {
      console.error(`  ❌ FAILED: ${error.message}`);
      results.push({
        file: basename(file), contentLength: 0, courseTimeMs: 0,
        modules: [], totalLessons: 0, firstPassSuccess: 0, finalSuccess: 0, finalFailed: 0,
      });
    }
  }

  const withLessons = results.filter((r) => r.totalLessons > 0);
  const totalTime = withLessons.reduce((s, r) => s + r.courseTimeMs, 0);
  const totalLessons = withLessons.reduce((s, r) => s + r.totalLessons, 0);
  const totalFirstPass = withLessons.reduce((s, r) => s + r.firstPassSuccess, 0);
  const totalFinal = withLessons.reduce((s, r) => s + r.finalSuccess, 0);
  const totalFailed = withLessons.reduce((s, r) => s + r.finalFailed, 0);

  console.log("\n" + "═".repeat(60));
  console.log("AGGREGATE RESULTS");
  console.log("═".repeat(60));
  console.log(`  ⏱  Total time:       ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`  📊 Total lessons:     ${totalLessons}`);
  if (totalLessons > 0) {
    console.log(`  ✅ First-pass rate:   ${totalFirstPass}/${totalLessons} (${Math.round((totalFirstPass / totalLessons) * 100)}%)`);
    console.log(`  ✅ Final success:     ${totalFinal}/${totalLessons} (${Math.round((totalFinal / totalLessons) * 100)}%)`);
    console.log(`  ❌ Final failures:    ${totalFailed}`);
  }

  console.log("\n  Per-file breakdown:");
  console.log("  " + "-".repeat(56));
  console.log("  File".padEnd(42) + "Time".padEnd(8) + "Pass".padEnd(8) + "Fail");
  console.log("  " + "-".repeat(56));
  for (const r of results) {
    const name = r.file.length > 38 ? r.file.substring(0, 35) + "..." : r.file;
    console.log(
      `  ${name.padEnd(40)}${(r.courseTimeMs / 1000).toFixed(1).padStart(5)}s  ${r.finalSuccess}/${r.totalLessons}`.padEnd(56) +
        `  ${r.finalFailed}`
    );
  }

  if (!existsSync(BENCHMARKS_DIR)) {
    mkdirSync(BENCHMARKS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outputPath = resolve(BENCHMARKS_DIR, `${tag}-${timestamp}.json`);

  writeFileSync(outputPath, JSON.stringify({
    tag,
    model: "openai/gpt-oss-120b",
    pipeline: "xml",
    timestamp: new Date().toISOString(),
    aggregate: {
      totalTimeMs: totalTime,
      totalLessons,
      firstPassSuccess: totalFirstPass,
      firstPassRate: totalLessons > 0 ? Math.round((totalFirstPass / totalLessons) * 100) : 0,
      finalSuccess: totalFinal,
      finalRate: totalLessons > 0 ? Math.round((totalFinal / totalLessons) * 100) : 0,
      finalFailed: totalFailed,
    },
    results,
  }, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
