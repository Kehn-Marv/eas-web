#!/usr/bin/env tsx
/**
 * Benchmark duplicate questions across all PDFs.
 *
 * Runs all PDFs in data/pdfs/ in parallel, collects every question generated,
 * then reports duplicates within each course and across courses.
 *
 * Usage:
 *   TOGETHER_API_KEY=... tsx scripts/benchmark-duplicates.ts
 */

import { createCourse } from "../lib/create-course";
import { ocr } from "../lib/ocr";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDFS_DIR = resolve(__dirname, "../data/pdfs");
const BENCHMARKS_DIR = resolve(__dirname, "../data/benchmarks");

const args = process.argv.slice(2);
const iterations = parseInt(
  args.find((a) => a.startsWith("--iterations="))?.split("=")[1] ?? "1",
  10
);

const apiKey = process.env.TOGETHER_API_KEY;
if (!apiKey) {
  console.error("TOGETHER_API_KEY is required");
  process.exit(1);
}

interface Question {
  file: string;
  moduleTitle: string;
  moduleIndex: number;
  lessonTitle: string;
  lessonIndex: number;
  questionType: string;
  question: string;
  answer: string | boolean | number;
}

interface DuplicateGroup {
  question: string;
  occurrences: Question[];
}

interface CourseResult {
  file: string;
  questions: Question[];
  totalLessons: number;
  successfulLessons: number;
  timeMs: number;
}

async function processPdf(filePath: string): Promise<CourseResult> {
  const fileName = basename(filePath);
  console.log(`\n📄 Starting: ${fileName}`);

  const ocrStart = Date.now();
  const ocrResult = await ocr(filePath);
  const content = ocrResult.pages
    .filter((p) => p.success)
    .map((p) => p.content)
    .join("\n\n");

  console.log(`  📄 OCR done: ${ocrResult.successfulPages} pages, ${content.length} chars (${((Date.now() - ocrStart) / 1000).toFixed(1)}s)`);

  const courseStart = Date.now();
  const course = await createCourse({
    content,
    apiKey: apiKey!,
    validateStructure: true,
    validateContent: true,
    retryFailures: true,
    maxRetries: 3,
  });
  const courseTimeMs = Date.now() - courseStart;

  const questions: Question[] = [];
  let totalLessons = 0;
  let successfulLessons = 0;

  course.modules.forEach((mod, mi) => {
    mod.lessons.forEach((lr, li) => {
      totalLessons++;
      if (lr.success) {
        successfulLessons++;
        questions.push({
          file: fileName,
          moduleTitle: mod.title,
          moduleIndex: mi,
          lessonTitle: lr.data.title,
          lessonIndex: li,
          questionType: lr.data.questionType,
          question: lr.data.question,
          answer: lr.data.answer,
        });
      }
    });
  });

  const totalMs = Date.now() - ocrStart;
  console.log(`  ✅ Done: ${fileName} — ${questions.length} questions in ${(totalMs / 1000).toFixed(1)}s`);

  return { file: fileName, questions, totalLessons, successfulLessons, timeMs: totalMs };
}

function normalize(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

/** Simple word-overlap similarity (Jaccard) */
function similarity(a: string, b: string): number {
  const wordsA = new Set(normalize(a).split(" "));
  const wordsB = new Set(normalize(b).split(" "));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

function findDuplicates(questions: Question[], threshold: number = 0.7): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < questions.length; i++) {
    if (assigned.has(i)) continue;

    const group: Question[] = [questions[i]];
    assigned.add(i);

    for (let j = i + 1; j < questions.length; j++) {
      if (assigned.has(j)) continue;

      const sim = similarity(questions[i].question, questions[j].question);
      if (sim >= threshold) {
        group.push(questions[j]);
        assigned.add(j);
      }
    }

    if (group.length > 1) {
      groups.push({ question: questions[i].question, occurrences: group });
    }
  }

  return groups;
}

async function main() {
  const pdfFiles = readdirSync(PDFS_DIR)
    .filter((f) => f.endsWith(".pdf"))
    .map((f) => resolve(PDFS_DIR, f));

  console.log(`\n🏁 Duplicate Question Benchmark`);
  console.log(`   PDFs: ${pdfFiles.length}`);
  console.log(`   Iterations: ${iterations}`);
  console.log(`   Files: ${pdfFiles.map((f) => basename(f)).join(", ")}`);
  console.log("═".repeat(60));

  const allIterationResults: CourseResult[][] = [];
  const startTime = Date.now();

  for (let iter = 0; iter < iterations; iter++) {
    if (iterations > 1) {
      console.log(`\n${"━".repeat(60)}`);
      console.log(`ITERATION ${iter + 1}/${iterations}`);
      console.log("━".repeat(60));
    }

    // Run ALL PDFs in parallel, catching per-PDF errors
    const results = await Promise.all(
      pdfFiles.map(async (f) => {
        try {
          return await processPdf(f);
        } catch (error: any) {
          console.error(`  ❌ FAILED ${basename(f)}: ${error.message}`);
          return {
            file: basename(f),
            questions: [],
            totalLessons: 0,
            successfulLessons: 0,
            timeMs: 0,
          } as CourseResult;
        }
      })
    );

    allIterationResults.push(results);

    if (iterations > 1) {
      const iterQuestions = results.flatMap((r) => r.questions);
      const iterDupes = findDuplicates(iterQuestions);
      const iterDupeCount = iterDupes.reduce((s, g) => s + g.occurrences.length, 0);
      const rate = iterQuestions.length > 0
        ? `${((iterDupeCount / iterQuestions.length) * 100).toFixed(1)}%`
        : "N/A";
      console.log(
        `  Iteration ${iter + 1}: ${iterQuestions.length} questions — ${iterDupes.length} dupe groups — rate: ${rate}`
      );
    }
  }

  const totalTimeMs = Date.now() - startTime;

  // Compute per-iteration stats (duplicates only within each single run)
  interface IterationStats {
    totalQuestions: number;
    uniqueQuestions: number;
    duplicateGroups: number;
    questionsInDuplicateGroups: number;
    duplicationRate: number;
    withinCourseDupeGroups: number;
    crossCourseDupeGroups: number;
    perCourse: { file: string; totalLessons: number; successfulLessons: number; questions: Question[]; duplicates: DuplicateGroup[] }[];
    allDuplicates: DuplicateGroup[];
    crossCourseDuplicates: DuplicateGroup[];
  }

  const iterationStats: IterationStats[] = [];

  for (let iter = 0; iter < allIterationResults.length; iter++) {
    const results = allIterationResults[iter];
    const iterQuestions = results.flatMap((r) => r.questions);

    // Within-course duplicates
    let withinCourseDupeGroups = 0;
    for (const result of results) {
      withinCourseDupeGroups += findDuplicates(result.questions).length;
    }

    // Cross-course duplicates (within this iteration only)
    const allDupes = findDuplicates(iterQuestions);
    const crossFileDupes = allDupes.filter((g) => {
      const files = new Set(g.occurrences.map((o) => o.file));
      return files.size > 1;
    });

    const questionsInDupeGroups = allDupes.reduce((s, g) => s + g.occurrences.length, 0);
    const uniqueQuestions = iterQuestions.length - questionsInDupeGroups + allDupes.length;

    iterationStats.push({
      totalQuestions: iterQuestions.length,
      uniqueQuestions,
      duplicateGroups: allDupes.length,
      questionsInDuplicateGroups: questionsInDupeGroups,
      duplicationRate: iterQuestions.length > 0 ? (questionsInDupeGroups / iterQuestions.length) * 100 : 0,
      withinCourseDupeGroups,
      crossCourseDupeGroups: crossFileDupes.length,
      perCourse: results.map((r) => ({
        file: r.file,
        totalLessons: r.totalLessons,
        successfulLessons: r.successfulLessons,
        questions: r.questions,
        duplicates: findDuplicates(r.questions),
      })),
      allDuplicates: allDupes,
      crossCourseDuplicates: crossFileDupes,
    });
  }

  // Aggregate across iterations
  const allResults = allIterationResults.flat();
  const totalLessons = allResults.reduce((s, r) => s + r.totalLessons, 0);
  const totalSuccessful = allResults.reduce((s, r) => s + r.successfulLessons, 0);
  const totalQuestions = iterationStats.reduce((s, it) => s + it.totalQuestions, 0);
  const avgDuplicationRate = iterationStats.length > 0
    ? iterationStats.reduce((s, it) => s + it.duplicationRate, 0) / iterationStats.length
    : 0;
  const totalDupeGroups = iterationStats.reduce((s, it) => s + it.duplicateGroups, 0);
  const totalWithinCourseDupes = iterationStats.reduce((s, it) => s + it.withinCourseDupeGroups, 0);
  const totalCrossCourseDupes = iterationStats.reduce((s, it) => s + it.crossCourseDupeGroups, 0);

  console.log("\n" + "═".repeat(60));
  console.log(`RESULTS SUMMARY${iterations > 1 ? ` (${iterations} iterations)` : ""}`);
  console.log("═".repeat(60));
  console.log(`  Total time:       ${(totalTimeMs / 1000).toFixed(1)}s`);
  if (iterations > 1) console.log(`  Iterations:       ${iterations}`);
  console.log(`  Total lessons:    ${totalLessons}`);
  console.log(`  Successful:       ${totalSuccessful}`);
  console.log(`  Total questions:  ${totalQuestions}`);

  // --- Per-iteration duplicate analysis ---
  if (iterations > 1) {
    console.log("\n" + "─".repeat(60));
    console.log("PER-ITERATION DUPLICATE RATES");
    console.log("─".repeat(60));
    for (let i = 0; i < iterationStats.length; i++) {
      const it = iterationStats[i];
      console.log(`  Iteration ${i + 1}: ${it.totalQuestions} questions — ${it.duplicateGroups} dupe groups — rate: ${it.duplicationRate.toFixed(1)}%`);
    }
  }

  // --- Per-course duplicate analysis (show details from each iteration) ---
  console.log("\n" + "─".repeat(60));
  console.log("PER-COURSE DUPLICATE ANALYSIS");
  console.log("─".repeat(60));

  for (let iter = 0; iter < allIterationResults.length; iter++) {
    if (iterations > 1) {
      console.log(`\n  --- Iteration ${iter + 1} ---`);
    }
    for (const result of allIterationResults[iter]) {
      const dupes = findDuplicates(result.questions);
      const dupeCount = dupes.reduce((s, g) => s + g.occurrences.length, 0);

      if (dupes.length > 0) {
        console.log(`\n  📕 ${result.file} — ${dupes.length} duplicate group(s) (${dupeCount} questions involved)`);
        for (const group of dupes) {
          console.log(`    🔁 "${group.question.substring(0, 80)}${group.question.length > 80 ? "..." : ""}"`);
          for (const occ of group.occurrences) {
            console.log(`       └─ Module ${occ.moduleIndex + 1} "${occ.moduleTitle}" / Lesson ${occ.lessonIndex + 1} (${occ.questionType})`);
          }
        }
      } else {
        console.log(`\n  ✅ ${result.file} — no duplicates within course`);
      }
    }
  }

  // --- Cross-course duplicate analysis (within each iteration) ---
  console.log("\n" + "─".repeat(60));
  console.log("CROSS-COURSE DUPLICATE ANALYSIS");
  console.log("─".repeat(60));

  const anyCrossDupes = iterationStats.some((it) => it.crossCourseDupeGroups > 0);
  if (anyCrossDupes) {
    for (let i = 0; i < iterationStats.length; i++) {
      const it = iterationStats[i];
      if (it.crossCourseDuplicates.length > 0) {
        console.log(`\n  Iteration ${i + 1}: ${it.crossCourseDuplicates.length} cross-course group(s):`);
        for (const group of it.crossCourseDuplicates) {
          console.log(`    🔁 "${group.question.substring(0, 80)}${group.question.length > 80 ? "..." : ""}"`);
          for (const occ of group.occurrences) {
            console.log(`       └─ ${occ.file} / Module "${occ.moduleTitle}" (${occ.questionType})`);
          }
        }
      }
    }
  } else {
    console.log("  ✅ No duplicates found across different courses");
  }

  // --- Overall stats ---
  console.log("\n" + "═".repeat(60));
  console.log("DUPLICATE STATS");
  console.log("═".repeat(60));

  console.log(`  Total questions generated:    ${totalQuestions}`);
  console.log(`  Avg duplication rate:         ${avgDuplicationRate.toFixed(1)}%`);
  console.log(`  Total duplicate groups:       ${totalDupeGroups}`);
  console.log(`  Within-course dupe groups:    ${totalWithinCourseDupes}`);
  console.log(`  Cross-course dupe groups:     ${totalCrossCourseDupes}`);
  if (iterations > 1) {
    console.log(`  Per-iteration rates:          ${iterationStats.map((it) => `${it.duplicationRate.toFixed(1)}%`).join(", ")}`);
  }

  // --- List ALL questions for review ---
  console.log("\n" + "─".repeat(60));
  console.log("ALL QUESTIONS GENERATED");
  console.log("─".repeat(60));
  for (let iter = 0; iter < allIterationResults.length; iter++) {
    if (iterations > 1) console.log(`\n  --- Iteration ${iter + 1} ---`);
    for (const result of allIterationResults[iter]) {
      console.log(`\n  📕 ${result.file}`);
      for (const q of result.questions) {
        console.log(`    [M${q.moduleIndex + 1}L${q.lessonIndex + 1}] (${q.questionType.padEnd(16)}) ${q.question}`);
      }
    }
  }

  // Save results to JSON
  if (!existsSync(BENCHMARKS_DIR)) {
    mkdirSync(BENCHMARKS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outputPath = resolve(BENCHMARKS_DIR, `duplicates-${timestamp}.json`);

  const output = {
    timestamp: new Date().toISOString(),
    iterations,
    totalTimeMs,
    summary: {
      totalPdfs: pdfFiles.length,
      totalLessons,
      totalSuccessful,
      totalQuestions,
      avgDuplicationRate: `${avgDuplicationRate.toFixed(1)}%`,
      totalDuplicateGroups: totalDupeGroups,
      withinCourseDupeGroups: totalWithinCourseDupes,
      crossCourseDupeGroups: totalCrossCourseDupes,
    },
    perIteration: iterationStats.map((it, i) => ({
      iteration: i + 1,
      totalQuestions: it.totalQuestions,
      uniqueQuestions: it.uniqueQuestions,
      duplicateGroups: it.duplicateGroups,
      duplicationRate: `${it.duplicationRate.toFixed(1)}%`,
      withinCourseDupeGroups: it.withinCourseDupeGroups,
      crossCourseDupeGroups: it.crossCourseDupeGroups,
      perCourse: it.perCourse,
      allDuplicates: it.allDuplicates,
      crossCourseDuplicates: it.crossCourseDuplicates,
    })),
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
