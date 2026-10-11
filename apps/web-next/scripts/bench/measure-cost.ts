#!/usr/bin/env tsx
/**
 * Measure end-to-end cost and time for one course generation
 * via the production createCourse pipeline.
 *
 *   TOGETHER_API_KEY=... bun scripts/bench/measure-cost.ts [path-to-pdf-or-md]
 */
import { readFileSync, existsSync } from "fs";
import { resolve, dirname, extname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

interface CallRecord {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}
const calls: CallRecord[] = [];

// Hook into the optional usage tracker exposed by lib/utils/together.ts.
const { __usageTracker } = await import("../../lib/utils/together");
__usageTracker.onCall = ({ inputTokens, outputTokens, durationMs }) => {
  calls.push({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
  });
};

const { createCourse } = await import("../../lib/create-course");
const { ocr } = await import("../../lib/ocr");

const input = process.argv[2] ?? "data/Rise-and-Fall-of-the-Roman-Empire.ocr.md";
const inputPath = resolve(ROOT, input);
if (!existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const apiKey = process.env.TOGETHER_API_KEY;
if (!apiKey) {
  console.error("TOGETHER_API_KEY required");
  process.exit(1);
}

const isPdf = extname(inputPath).toLowerCase() === ".pdf";
const ocrStart = Date.now();
let content: string;
if (isPdf) {
  const r = await ocr(inputPath);
  content = r.pages.filter((p) => p.success).map((p) => p.content).join("\n\n");
} else {
  content = readFileSync(inputPath, "utf-8");
}
const ocrMs = Date.now() - ocrStart;

console.log(`\nInput:        ${input}`);
console.log(`Length:       ${content.length.toLocaleString()} chars`);
console.log(`OCR time:     ${(ocrMs / 1000).toFixed(2)}s${isPdf ? " (MuPDF)" : " (read text)"}`);

const genStart = Date.now();
const course = await createCourse({
  content,
  apiKey,
});
const genMs = Date.now() - genStart;

const totalLessons = course.modules.reduce((s, m) => s + m.lessons.length, 0);
const successful = course.modules.reduce(
  (s, m) => s + m.lessons.filter((l: any) => l.success).length,
  0
);

const inputTokens = calls.reduce((s, c) => s + c.inputTokens, 0);
const outputTokens = calls.reduce((s, c) => s + c.outputTokens, 0);
const totalTokens = inputTokens + outputTokens;

// gpt-oss-120b pricing from Together AI serverless catalog (verified earlier)
const inputPricePerMillion = 0.15;
const outputPricePerMillion = 0.60;
const inputCost = (inputTokens / 1_000_000) * inputPricePerMillion;
const outputCost = (outputTokens / 1_000_000) * outputPricePerMillion;
const totalCost = inputCost + outputCost;

console.log(`\nGeneration:   ${(genMs / 1000).toFixed(2)}s`);
console.log(`LLM calls:    ${calls.length}`);
console.log(`Lessons:      ${successful}/${totalLessons}`);

console.log(`\nTokens (gpt-oss-120b):`);
console.log(`  Input:      ${inputTokens.toLocaleString().padStart(10)}  @  $${inputPricePerMillion.toFixed(2)}/1M  =  $${inputCost.toFixed(5)}`);
console.log(`  Output:     ${outputTokens.toLocaleString().padStart(10)}  @  $${outputPricePerMillion.toFixed(2)}/1M  =  $${outputCost.toFixed(5)}`);
console.log(`  Total:      ${totalTokens.toLocaleString().padStart(10)}                  =  $${totalCost.toFixed(5)}`);

console.log(`\nPer-call breakdown:`);
calls.forEach((c, i) => {
  console.log(
    `  [${(i + 1).toString().padStart(2)}] ${(c.durationMs / 1000).toFixed(1).padStart(5)}s   in=${c.inputTokens.toString().padStart(6)}   out=${c.outputTokens.toString().padStart(5)}`
  );
});

console.log(`\nEnd-to-end (ocr + gen): ${((ocrMs + genMs) / 1000).toFixed(2)}s,  $${totalCost.toFixed(4)}`);
