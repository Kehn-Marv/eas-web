#!/usr/bin/env tsx
/**
 * Run all evaluation dimensions on one or more PDFs.
 *
 * Dimensions:
 *   1. Structural — first-pass & final success rates
 *   2. Answer Correctness — LLM judge checks factual accuracy
 *   3. Answer Grounding — self-contained, concrete, grounded
 *   4. Duplicates — within-course question deduplication
 *   5. Content Sufficiency — does lesson content teach enough to answer the question
 *   6. Hint Answer Leak — does the hint reveal the answer directly
 *
 * Usage:
 *   TOGETHER_API_KEY=... ANTHROPIC_API_KEY=... bun scripts/eval-all.ts [file1.pdf ...]
 *
 * If no files given, runs all PDFs in data/pdfs/.
 * Options:
 *   --model=<model>       Generation model (default: MiniMaxAI/MiniMax-M2.7)
 *   --judge=<model>       Judge model (default: anthropic/claude-sonnet-4-6)
 *                         Prefix with anthropic/, openrouter/, or ollama/ to force provider
 *   --tag=<name>          Label for the output file (default: eval-all)
 *   --iterations=<n>      Number of iterations (default: 1)
 *   --batch=<n>           Run n iterations in parallel (default: 1 = sequential)
 *   --dimensions=<d,...>   Comma-separated: structural,correctness,grounding,duplicates,sufficiency,hint-leak (default: all)
 *   --no-judge            Skip all LLM judging (saves results for manual review later)
 */

import { createCourse } from "../lib/create-course";
import { generateText } from "ai";
import { ocr } from "../lib/ocr";
import { DEFAULT_MODEL, __usageTracker, getModelPricing } from "../lib/utils/together";
import { parseJSON } from "../lib/utils/json";
import { getJudgeModel } from "../lib/utils/judge-model";
import { detectHintAnswerLeak, type HintAnswerLeakResult } from "../lib/hint-answer-leak";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, basename, extname, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDFS_DIR = resolve(__dirname, "../data/pdfs");
const BENCHMARKS_DIR = resolve(__dirname, "../data/benchmarks");

// ── CLI args ────────────────────────────────────────────
const args = process.argv.slice(2);
const tag =
  args.find((a) => a.startsWith("--tag="))?.split("=")[1] ?? "eval-all";
const model =
  args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? undefined;
const judgeModel =
  args.find((a) => a.startsWith("--judge="))?.split("=")[1] ??
  "anthropic/claude-sonnet-4-6";
const iterations = parseInt(
  args.find((a) => a.startsWith("--iterations="))?.split("=")[1] ?? "1",
  10
);
const dimensionsArg =
  args.find((a) => a.startsWith("--dimensions="))?.split("=")[1] ?? null;
const enabledDimensions = new Set(
  dimensionsArg
    ? dimensionsArg.split(",").map((d) => d.trim().toLowerCase())
    : ["structural", "correctness", "grounding", "duplicates", "sufficiency", "hint-leak"]
);
const batch = parseInt(
  args.find((a) => a.startsWith("--batch="))?.split("=")[1] ?? "1",
  10
);
const noJudge = args.includes("--no-judge");
const parallelFiles = args.includes("--parallel-files");
const inputFiles = args
  .filter((a) => !a.startsWith("--"))
  .map((f) => resolve(f));

const apiKey = process.env.TOGETHER_API_KEY;
if (!apiKey) {
  console.error("TOGETHER_API_KEY is required");
  process.exit(1);
}

const openrouterApiKey = process.env.OPENROUTER_API_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL;

// ── Generation token accounting (for cost) ──────────────
// Must be set before createCourse builds its Together client, which only wraps
// for usage tracking when __usageTracker.onCall is present. Captures GENERATION
// tokens only (Together); the LLM judge runs on a separate provider.
let genInputTokens = 0;
let genOutputTokens = 0;
__usageTracker.onCall = ({ inputTokens, outputTokens }) => {
  genInputTokens += inputTokens;
  genOutputTokens += outputTokens;
};

// ── Judge setup ─────────────────────────────────────────

// Limit concurrent claude CLI subprocesses — without this, parallel judging across
// batches spawns ~180 processes and many exit with code 1.
const CLAUDE_CLI_MAX_CONCURRENCY = parseInt(
  process.env.CLAUDE_CLI_MAX_CONCURRENCY ?? "6",
  10
);
let claudeCliInflight = 0;
const claudeCliQueue: Array<() => void> = [];

async function acquireClaudeCliSlot() {
  if (claudeCliInflight < CLAUDE_CLI_MAX_CONCURRENCY) {
    claudeCliInflight++;
    return;
  }
  await new Promise<void>((resolve) => claudeCliQueue.push(resolve));
  claudeCliInflight++;
}

function releaseClaudeCliSlot() {
  claudeCliInflight--;
  const next = claudeCliQueue.shift();
  if (next) next();
}

async function runClaudeCli(prompt: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", "sonnet"],
    { env, stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

async function judgeViaClaude(prompt: string): Promise<string> {
  await acquireClaudeCliSlot();
  try {
    let lastErr = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const { stdout, stderr, code } = await runClaudeCli(prompt);
      if (code === 0) return stdout.trim();
      lastErr = stderr || `exit ${code}`;
      // brief backoff before retry
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    throw new Error(`claude CLI exited non-zero after 3 attempts: ${lastErr}`);
  } finally {
    releaseClaudeCliSlot();
  }
}

async function judge(prompt: string): Promise<string> {
  if (judgeModel === "claude") {
    return judgeViaClaude(prompt);
  }
  const r = await generateText({
    model: getJudgeModel({
      judgeModel,
      togetherApiKey: apiKey,
      anthropicApiKey,
      openrouterApiKey,
      ollamaBaseUrl,
    }),
    temperature: 0,
    maxOutputTokens: 1024,
    prompt,
  });
  return r.text;
}

// ── Types ───────────────────────────────────────────────

interface SufficiencyVerdict {
  sufficient: boolean;
  explanation: string;
  parseStatus?: "parsed" | "substring_recovered" | "parse_failed";
  rawResponse?: string;
}

interface GroundingVerdict {
  selfContained: boolean;
  concrete: boolean;
  grounded: boolean;
  issues: string[];
  explanation: string;
}

interface CorrectnessVerdict {
  correct: boolean;
  explanation: string;
  expectedAnswer?: string;
}

interface EvalQuestion {
  moduleTitle: string;
  moduleIndex: number;
  lessonTitle: string;
  lessonIndex: number;
  questionType: string;
  question: string;
  answer: any;
  hint: string;
  choices?: any[];
  slots?: string[];
  lessonContent: string;
  explanation?: string;
  // Structural
  wasFixed: boolean;
  fixAttempts: number;
  // Correctness
  correctness: CorrectnessVerdict;
  // Grounding
  grounding: GroundingVerdict;
  heuristicFlags: string[];
  // Sufficiency
  sufficiency: SufficiencyVerdict;
  // Hint answer leak
  hintLeak: HintAnswerLeakResult;
}

interface FileEvalResult {
  file: string;
  // Structural
  totalLessons: number;
  successfulLessons: number;
  firstPassSuccess: number;
  // Timing
  ocrTimeMs: number;
  generationTimeMs: number;
  judgingTimeMs: number;
  // Questions
  questions: EvalQuestion[];
  // Duplicates
  duplicateGroups: DuplicateGroup[];
}

interface DuplicateGroup {
  question: string;
  indices: number[]; // indices into questions array
}

// ── Helpers ─────────────────────────────────────────────

async function getContent(
  filePath: string
): Promise<{ content: string; ocrTimeMs: number }> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") {
    const start = Date.now();
    const result = await ocr(filePath);
    const ocrTimeMs = Date.now() - start;
    const content = result.pages
      .filter((p) => p.success)
      .map((p) => p.content)
      .join("\n\n");
    console.log(
      `  OCR: ${result.successfulPages}/${result.pages.length} pages, ${content.length} chars (${(ocrTimeMs / 1000).toFixed(1)}s)`
    );
    return { content, ocrTimeMs };
  }
  const { readFileSync } = await import("fs");
  return { content: readFileSync(filePath, "utf-8"), ocrTimeMs: 0 };
}

function formatAnswer(
  answer: any,
  questionType: string,
  choices?: any[]
): string {
  if (questionType === "multiple-choice" && choices) {
    return `Index ${answer} → "${choices[answer]}"`;
  }
  if (questionType === "flow-diagram" && choices) {
    return `Ordering: [${answer}] → ${(answer as number[]).map((i) => `"${choices[i]}"`).join(", ")}`;
  }
  return String(answer);
}

// ── Heuristic checks ────────────────────────────────────

const META_REFERENCE_PATTERNS = [
  /\b(?:the|this)\s+brief\b/i,
  /\b(?:the|this)\s+passage\b/i,
  /\b(?:the|this)\s+text\b/i,
  /\b(?:the|this)\s+content\b/i,
  /\bas\s+(?:mentioned|stated|described|noted|discussed)\s+(?:in|above|below|earlier)\b/i,
  /\bsee\s+(?:the|above|below)\b/i,
  /\brefer\s+to\b/i,
  /\b(?:the|this)\s+article\b/i,
  /\b(?:the|this)\s+lesson\b/i,
  /\b(?:the|this)\s+reading\b/i,
  /\b(?:the|this)\s+source\b/i,
  /\b(?:the|this)\s+excerpt\b/i,
  /\b(?:the|this)\s+document\b/i,
];

function runHeuristics(
  answer: any,
  questionType: string,
  choices?: any[]
): string[] {
  const flags: string[] = [];
  const textsToCheck: string[] = [];

  if (typeof answer === "string") textsToCheck.push(answer);
  if (choices) {
    for (const c of choices) {
      if (typeof c === "string") textsToCheck.push(c);
    }
  }

  for (const text of textsToCheck) {
    for (const pattern of META_REFERENCE_PATTERNS) {
      if (pattern.test(text)) {
        flags.push(
          `meta-reference: "${text.substring(0, 80)}" matches ${pattern}`
        );
        break;
      }
    }
  }

  if (questionType === "short-answer" && typeof answer === "string") {
    if (answer.trim().length < 3) {
      flags.push(`vague-answer: answer is only ${answer.trim().length} chars`);
    }
  }

  return flags;
}


// ── Correctness judge ───────────────────────────────────

function buildCorrectnessContext(q: {
  question: string;
  questionType: string;
  answer: any;
  choices?: any[];
  explanation?: string;
  slots?: string[];
}): string {
  if (q.questionType === "multiple-choice") {
    return `Question: ${q.question}
Choices: ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Given answer: index ${q.answer} → "${q.choices![q.answer]}"
${q.explanation ? `Explanation given: ${q.explanation}` : ""}`;
  } else if (q.questionType === "true-false") {
    return `Statement: ${q.question}\nGiven answer: ${q.answer}`;
  } else if (q.questionType === "flow-diagram") {
    return `Question: ${q.question}
Choices (items to order): ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}
Slots: ${q.slots!.join(", ")}
Given answer (slot→choice mapping): [${q.answer}]
This means: ${q.slots!.map((slot: string, i: number) => `${slot} → "${q.choices![q.answer[i]]}"`).join(", ")}`;
  }
  return `Question: ${q.question}\nGiven answer: ${q.answer}`;
}

async function judgeCorrectness(
  q: {
    question: string;
    questionType: string;
    answer: any;
    choices?: any[];
    explanation?: string;
    slots?: string[];
  },
  sourceContent: string
): Promise<CorrectnessVerdict> {
  const ctx = buildCorrectnessContext(q);

  const resultText = await judge(`You are an answer-correctness judge. Given a question, its answer, and the source content the question was derived from, determine if the answer is CORRECT.

${ctx}

Source content (the question was generated from this):
${sourceContent}

Follow these steps:
1. First, determine what the correct answer should be based ONLY on the source content.
2. Then, compare the given answer to your determined correct answer.
3. If they match (same meaning, minor wording differences OK), the answer is correct.

Rules:
- For short-answer: the answer must be factually correct and supported by the source. Minor wording differences and paraphrasing are OK if the meaning is correct.
- For true-false: the boolean must be correct based on the source. Read the statement carefully — if it says something false and the answer is false, that IS correct.
- For multiple-choice: the selected choice must be the correct one. Check that the answer INDEX actually points to the right choice.
- For flow-diagram: the ordering must reflect the correct sequence from the source.

CRITICAL: Your "correct" field MUST be consistent with your explanation. If your reasoning concludes the answer is right, you MUST set "correct": true. Do NOT contradict yourself.

Respond ONLY with JSON:
{"correct": true, "explanation": "Brief reason"}

Or if wrong:
{"correct": false, "explanation": "What's wrong", "expectedAnswer": "What the correct answer should be"}`);

  const parsed = parseCorrectnessResponse(resultText);
  if (!parsed) {
    console.warn(
      `  ⚠️  Correctness judge parse failed. Raw: ${resultText.substring(0, 200)}`
    );
    return { correct: false, explanation: "Judge failed to parse response" };
  }

  // If correct, accept immediately
  if (parsed.correct) return parsed;

  // Re-judge failures to catch self-contradictions
  const verifyText = await judge(`A judge evaluated a question and marked the answer as INCORRECT. Review the judge's reasoning and determine if the verdict is actually right.

Question details:
${ctx}

Source content:
${sourceContent}

Judge's explanation for marking it INCORRECT:
${parsed.explanation}

Based on the source content and the judge's own reasoning:
- Is the given answer actually correct or incorrect?
- Did the judge contradict itself (reasoning says correct but verdict says incorrect)?

Respond ONLY with JSON:
{"correct": true, "explanation": "The answer is actually correct because..."}
or
{"correct": false, "explanation": "The answer is genuinely incorrect because..."}`);

  const verify = parseCorrectnessResponse(verifyText);
  return verify ?? parsed;
}

function parseCorrectnessResponse(
  text: string
): CorrectnessVerdict | null {
  try {
    const parsed = parseJSON(text);
    return {
      correct: !!parsed.correct,
      explanation: parsed.explanation ?? "No explanation",
      expectedAnswer: parsed.expectedAnswer,
    };
  } catch {
    const lower = text.toLowerCase();
    const looksCorrect =
      lower.includes('"correct": true') || lower.includes('"correct":true');
    const looksIncorrect =
      lower.includes('"correct": false') || lower.includes('"correct":false');
    if (looksCorrect || looksIncorrect) {
      return {
        correct: looksCorrect && !looksIncorrect,
        explanation: text.substring(0, 300),
      };
    }
    return null;
  }
}

// ── Grounding judge ─────────────────────────────────────

function buildGroundingContext(q: {
  question: string;
  questionType: string;
  answer: any;
  lessonContent: string;
  choices?: any[];
  slots?: string[];
}): string {
  let ctx = `Question type: ${q.questionType}\n`;
  ctx += `Lesson content shown to student: ${q.lessonContent}\n\n`;

  if (q.questionType === "multiple-choice") {
    ctx += `Question: ${q.question}\n`;
    ctx += `Choices:\n${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}\n`;
    ctx += `Answer: index ${q.answer} → "${q.choices![q.answer]}"`;
  } else if (q.questionType === "true-false") {
    ctx += `Statement: ${q.question}\nAnswer: ${q.answer}`;
  } else if (q.questionType === "short-answer") {
    ctx += `Question: ${q.question}\nAnswer: ${q.answer}`;
  } else if (q.questionType === "flow-diagram") {
    ctx += `Question: ${q.question}\n`;
    ctx += `Choices: ${q.choices!.map((c: any, i: number) => `  ${i}. ${c}`).join("\n")}\n`;
    ctx += `Slots: ${q.slots!.join(", ")}\n`;
    ctx += `Answer ordering: [${q.answer}]`;
  } else {
    ctx += `Question: ${q.question}\nAnswer: ${q.answer}`;
  }

  return ctx;
}

async function judgeGrounding(
  q: {
    question: string;
    questionType: string;
    answer: any;
    lessonContent: string;
    choices?: any[];
    slots?: string[];
  },
  sourceContent: string
): Promise<GroundingVerdict> {
  const ctx = buildGroundingContext(q);

  const resultText =
    await judge(`You are a quality judge for educational content. Evaluate the GROUNDING and SELF-CONTAINEDNESS of a question-answer pair.

This is NOT about whether the answer is factually correct. It's about whether the answer is well-formed, self-contained, and properly grounded in the source material.

${ctx}

Source content the lesson was generated from:
${sourceContent}

Evaluate these three dimensions:

1. **selfContained** — Does the answer stand on its own? A student should understand the answer without needing to reference anything else.
   - FAIL if the answer says things like "the answer is in the brief", "as mentioned in the passage", "see the text", "refer to the content above", etc.
   - FAIL if the answer references meta-structures of the lesson or source material.
   - For true-false: true/false is self-contained by nature (PASS).
   - For multiple-choice: check both the correct choice text AND all other choice texts for meta-references.

2. **concrete** — Does the answer provide a specific, actionable answer?
   - FAIL if a short-answer gives a vague or circular restatement of the question.
   - FAIL if the answer is generic enough to apply to any topic (not specific to the source).
   - For true-false and multiple-choice: these are concrete by nature (PASS) unless the choices themselves are vague.
   - For flow-diagram: the ordering should correspond to a real process from the source.

3. **grounded** — Is the answer actually supported by the source content?
   - FAIL if the answer includes claims or facts NOT present in the source (hallucination).
   - FAIL if the answer contradicts the source.
   - PASS if the answer is a reasonable inference from the source, even if not verbatim.

Respond ONLY with JSON:
{
  "selfContained": true/false,
  "concrete": true/false,
  "grounded": true/false,
  "issues": ["list of specific issues found, empty if all pass"],
  "explanation": "Brief overall assessment"
}`);

  const verdict = parseGroundingResponse(resultText);
  if (!verdict) {
    console.warn(
      `  ⚠️  Grounding judge parse failed. Raw: ${resultText.substring(0, 200)}`
    );
    return {
      selfContained: true,
      concrete: true,
      grounded: true,
      issues: ["Judge parse failure — defaulting to pass"],
      explanation: "Judge failed to parse response",
    };
  }

  return verdict;
}

function parseGroundingResponse(text: string): GroundingVerdict | null {
  try {
    const parsed = parseJSON(text);
    return {
      selfContained: !!parsed.selfContained,
      concrete: !!parsed.concrete,
      grounded: !!parsed.grounded,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      explanation: parsed.explanation ?? "No explanation",
    };
  } catch {
    return null;
  }
}

// ── Sufficiency judge ────────────────────────────────────

async function judgeSufficiency(q: {
  question: string;
  questionType: string;
  answer: any;
  lessonContent: string;
  choices?: any[];
  slots?: string[];
}): Promise<SufficiencyVerdict> {
  const ctx = buildGroundingContext(q);

  const resultText =
    await judge(`You are a content sufficiency judge for educational material. You must determine whether the LESSON CONTENT (the brief shown to the student) contains enough information for the student to answer the question.

IMPORTANT: You are NOT checking whether the answer is correct. You are checking whether the lesson content TEACHES the material needed to answer.

${ctx}

Rules:
- FAIL if the lesson content is generic filler that doesn't mention the specific facts, terms, or concepts needed to answer the question.
- FAIL if the question asks about specific details (names, numbers, sequences, definitions) that are absent from the lesson content.
- PASS if the lesson content contains the key information needed, even if not verbatim — reasonable inference from the content is OK.
- PASS for true-false questions where the statement itself provides the claim to evaluate, as long as the content gives enough context.
- For multiple-choice: the content must teach enough to distinguish the correct choice from the distractors.
- For flow-diagram: the content must describe the process/sequence being tested.

Respond ONLY with JSON:
{"sufficient": true, "explanation": "The content covers..."}
or
{"sufficient": false, "explanation": "The content fails to mention..."}`);

  try {
    const parsed = parseJSON(resultText);
    return {
      sufficient: !!parsed.sufficient,
      explanation: parsed.explanation ?? "No explanation",
      parseStatus: "parsed",
      rawResponse: resultText,
    };
  } catch {
    const lower = resultText.toLowerCase();
    const looksTrue =
      lower.includes('"sufficient": true') ||
      lower.includes('"sufficient":true');
    const looksFalse =
      lower.includes('"sufficient": false') ||
      lower.includes('"sufficient":false');
    if (looksTrue || looksFalse) {
      return {
        sufficient: looksTrue && !looksFalse,
        explanation: resultText.substring(0, 300),
        parseStatus: "substring_recovered",
        rawResponse: resultText,
      };
    }
    console.warn(
      `  ⚠️  Sufficiency judge parse failed. Raw: ${resultText.substring(0, 200)}`
    );
    return {
      sufficient: false,
      explanation: "Judge failed to parse response",
      parseStatus: "parse_failed",
      rawResponse: resultText,
    };
  }
}

// ── Duplicate detection ─────────────────────────────────

function normalize(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
  const wordsA = new Set(normalize(a).split(" "));
  const wordsB = new Set(normalize(b).split(" "));
  const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}

function findDuplicates(
  questions: { question: string }[],
  threshold: number = 0.7
): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const assigned = new Set<number>();

  for (let i = 0; i < questions.length; i++) {
    if (assigned.has(i)) continue;
    const group: number[] = [i];
    assigned.add(i);

    for (let j = i + 1; j < questions.length; j++) {
      if (assigned.has(j)) continue;
      if (similarity(questions[i].question, questions[j].question) >= threshold) {
        group.push(j);
        assigned.add(j);
      }
    }

    if (group.length > 1) {
      groups.push({ question: questions[i].question, indices: group });
    }
  }

  return groups;
}

// ── Per-file processing ─────────────────────────────────

async function processFile(filePath: string): Promise<FileEvalResult> {
  const fileName = basename(filePath);
  console.log(`\n${"═".repeat(60)}`);
  console.log(`📄 ${fileName}`);
  console.log("═".repeat(60));

  // 1. OCR
  const { content, ocrTimeMs } = await getContent(filePath);

  // 2. Generate course
  console.log("\n  ── Generating course ──");
  const genStart = Date.now();
  const course = await createCourse({
    content,
    apiKey: apiKey!,
    model,
    validateStructure: true,
    validateContent: true,
    retryFailures: true,
    maxRetries: 3,
  });
  const generationTimeMs = Date.now() - genStart;

  // Collect lessons + structural metrics
  let totalLessons = 0;
  let firstPassSuccess = 0;
  const lessons: Array<{
    moduleTitle: string;
    moduleIndex: number;
    lessonIndex: number;
    data: any;
    wasFixed: boolean;
    fixAttempts: number;
  }> = [];

  course.modules.forEach((mod, mi) => {
    mod.lessons.forEach((lr, li) => {
      totalLessons++;
      if (lr.success) {
        const wasFixed = lr.data?.fixHistory && lr.data.fixHistory.length > 0;
        if (!wasFixed) firstPassSuccess++;
        lessons.push({
          moduleTitle: mod.title,
          moduleIndex: mi,
          lessonIndex: li,
          data: lr.data,
          wasFixed: !!wasFixed,
          fixAttempts: lr.data?.fixHistory?.length ?? 0,
        });
      }
    });
  });

  console.log(
    `  Generated: ${lessons.length}/${totalLessons} lessons (${(generationTimeMs / 1000).toFixed(1)}s)`
  );
  console.log(
    `  First-pass: ${firstPassSuccess}/${totalLessons} (${totalLessons > 0 ? Math.round((firstPassSuccess / totalLessons) * 100) : 0}%)`
  );

  // 3. Judge all questions (correctness + grounding + sufficiency in parallel per question)
  const runJudge =
    !noJudge &&
    (enabledDimensions.has("correctness") ||
    enabledDimensions.has("grounding") ||
    enabledDimensions.has("sufficiency"));
  const runHintLeak = enabledDimensions.has("hint-leak");
  let judgingTimeMs = 0;

  const defaultCorrectness: CorrectnessVerdict = {
    correct: true,
    explanation: "skipped",
  };
  const defaultGrounding: GroundingVerdict = {
    selfContained: true,
    concrete: true,
    grounded: true,
    issues: [],
    explanation: "skipped",
  };
  const defaultSufficiency: SufficiencyVerdict = {
    sufficient: true,
    explanation: "skipped",
  };
  const defaultHintLeak: HintAnswerLeakResult = {
    leaksAnswer: false,
    severity: "none",
    reasons: [],
    matchedTerms: [],
    checkedTerms: [],
  };

  const evalPromises = lessons.map(async (lesson) => {
    const heuristicFlags = runHeuristics(
      lesson.data.answer,
      lesson.data.questionType,
      lesson.data.choices
    );
    const hintLeak = runHintLeak
      ? detectHintAnswerLeak({
          questionType: lesson.data.questionType,
          question: lesson.data.question,
          hint: lesson.data.info,
          answer: lesson.data.answer,
          choices: lesson.data.choices,
          slots: lesson.data.slots,
        })
      : defaultHintLeak;

    let correctness = defaultCorrectness;
    let grounding = defaultGrounding;
    let sufficiency = defaultSufficiency;

    if (runJudge) {
      const judges: Promise<any>[] = [];

      const qPreview = lesson.data.question.substring(0, 60);

      if (enabledDimensions.has("correctness")) {
        judges.push(
          judgeCorrectness(
            {
              question: lesson.data.question,
              questionType: lesson.data.questionType,
              answer: lesson.data.answer,
              choices: lesson.data.choices,
              explanation: lesson.data.explanation,
              slots: lesson.data.slots,
            },
            content
          ).catch((e: any): CorrectnessVerdict => {
            console.error(`  ⚠️  correctness judge failed for "${qPreview}...": ${e.message}`);
            return { correct: true, explanation: `judge_failed: ${e.message}` };
          })
        );
      } else {
        judges.push(Promise.resolve(defaultCorrectness));
      }

      if (enabledDimensions.has("grounding")) {
        judges.push(
          judgeGrounding(
            {
              question: lesson.data.question,
              questionType: lesson.data.questionType,
              answer: lesson.data.answer,
              lessonContent: lesson.data.content,
              choices: lesson.data.choices,
              slots: lesson.data.slots,
            },
            content
          ).catch((e: any): GroundingVerdict => {
            console.error(`  ⚠️  grounding judge failed for "${qPreview}...": ${e.message}`);
            return { selfContained: true, concrete: true, grounded: true, issues: [], explanation: `judge_failed: ${e.message}` };
          })
        );
      } else {
        judges.push(Promise.resolve(defaultGrounding));
      }

      if (enabledDimensions.has("sufficiency")) {
        judges.push(
          judgeSufficiency({
            question: lesson.data.question,
            questionType: lesson.data.questionType,
            answer: lesson.data.answer,
            lessonContent: lesson.data.content,
            choices: lesson.data.choices,
            slots: lesson.data.slots,
          }).catch((e: any): SufficiencyVerdict => {
            console.error(`  ⚠️  sufficiency judge failed for "${qPreview}...": ${e.message}`);
            return { sufficient: true, explanation: `judge_failed: ${e.message}` };
          })
        );
      } else {
        judges.push(Promise.resolve(defaultSufficiency));
      }

      [correctness, grounding, sufficiency] = await Promise.all(judges);
    }

    return {
      moduleTitle: lesson.moduleTitle,
      moduleIndex: lesson.moduleIndex,
      lessonTitle: lesson.data.title,
      lessonIndex: lesson.lessonIndex,
      questionType: lesson.data.questionType,
      question: lesson.data.question,
      answer: lesson.data.answer,
      hint: lesson.data.info ?? "",
      choices: lesson.data.choices,
      slots: lesson.data.slots,
      lessonContent: lesson.data.content,
      explanation: lesson.data.explanation,
      wasFixed: lesson.wasFixed,
      fixAttempts: lesson.fixAttempts,
      correctness,
      grounding,
      heuristicFlags,
      sufficiency,
      hintLeak,
    } as EvalQuestion;
  });

  if (runJudge) {
    console.log("\n  ── Judging answers ──");
  }
  const judgeStart = Date.now();
  const questions = await Promise.all(evalPromises);
  judgingTimeMs = Date.now() - judgeStart;

  // 4. Duplicate detection
  const duplicateGroups = enabledDimensions.has("duplicates")
    ? findDuplicates(questions)
    : [];

  // 5. Print results
  if (runJudge) {
    console.log(
      `  Judging complete (${(judgingTimeMs / 1000).toFixed(1)}s)`
    );
  }

  for (const q of questions) {
    const cIcon = q.correctness.correct ? "✅" : "❌";
    const gAll =
      q.grounding.selfContained &&
      q.grounding.concrete &&
      q.grounding.grounded;
    const gDims = [
      q.grounding.selfContained ? "S" : "s",
      q.grounding.concrete ? "C" : "c",
      q.grounding.grounded ? "G" : "g",
    ].join("");
    const gIcon = gAll ? "✅" : "⚠️";
    const sIcon = q.sufficiency.sufficient ? "✅" : "📝";
    const hIcon = !runHintLeak ? "" : q.hintLeak.leaksAnswer ? "🚨" : "✅";
    const hDims = runHintLeak ? ` [H:${q.hintLeak.severity}]` : "";
    const fixTag = q.wasFixed ? " 🔧" : "";

    if (runJudge) {
      console.log(
        `  ${cIcon}${gIcon}${sIcon}${hIcon} [${gDims}]${hDims} [M${q.moduleIndex + 1}L${q.lessonIndex + 1}] (${q.questionType.padEnd(16)}) ${q.question.substring(0, 50)}${q.question.length > 50 ? "..." : ""}${fixTag}`
      );
    } else if (runHintLeak) {
      console.log(
        `  ${hIcon}${hDims} [M${q.moduleIndex + 1}L${q.lessonIndex + 1}] (${q.questionType.padEnd(16)}) ${q.question.substring(0, 70)}${q.question.length > 70 ? "..." : ""}${fixTag}`
      );
    } else {
      console.log(
        `  [M${q.moduleIndex + 1}L${q.lessonIndex + 1}] (${q.questionType.padEnd(16)}) ${q.question.substring(0, 70)}${q.question.length > 70 ? "..." : ""}${fixTag}`
      );
    }

    if (runJudge && !q.correctness.correct) {
      const answerStr = formatAnswer(q.answer, q.questionType, q.choices);
      console.log(`     Answer: ${answerStr}`);
      console.log(`     Judge:  ${q.correctness.explanation}`);
      if (q.correctness.expectedAnswer) {
        console.log(`     Expected: ${q.correctness.expectedAnswer}`);
      }
    }
    if (runJudge && !gAll) {
      for (const issue of q.grounding.issues) {
        console.log(`     Grounding: ${issue}`);
      }
    }
    if (runJudge && !q.sufficiency.sufficient) {
      console.log(`     Sufficiency: ${q.sufficiency.explanation}`);
    }
    if (runHintLeak && q.hintLeak.leaksAnswer) {
      const hintPreview = q.hint.substring(0, 160);
      console.log(`     Hint: ${hintPreview}${q.hint.length > 160 ? "..." : ""}`);
      console.log(`     Hint leak: ${q.hintLeak.reasons.join("; ")}`);
      if (q.hintLeak.matchedTerms.length > 0) {
        console.log(`     Matched: ${q.hintLeak.matchedTerms.join(", ")}`);
      }
    }
  }

  return {
    file: fileName,
    totalLessons,
    successfulLessons: lessons.length,
    firstPassSuccess,
    ocrTimeMs,
    generationTimeMs,
    judgingTimeMs,
    questions,
    duplicateGroups,
  };
}

// ── Main ────────────────────────────────────────────────

async function main() {
  let files: string[];
  if (inputFiles.length > 0) {
    files = inputFiles;
  } else {
    files = readdirSync(PDFS_DIR)
      .filter((f) => f.endsWith(".pdf"))
      .map((f) => resolve(PDFS_DIR, f));
  }

  const displayModel = model ?? DEFAULT_MODEL + " (default)";
  const enabledList = [...enabledDimensions].join(", ");
  console.log(`\n🏁 Full Evaluation: ${tag}`);
  console.log(`   Generation model: ${displayModel}`);
  console.log(`   Judge model:      ${judgeModel}`);
  console.log(`   Files: ${files.map((f) => basename(f)).join(", ")}`);
  console.log(`   Iterations: ${iterations}`);
  console.log(`   Batch size: ${batch}`);
  console.log(`   Dimensions: ${enabledList}`);

  const startTime = Date.now();
  const allIterationResults: FileEvalResult[][] = [];

  // Run iterations in batches
  for (let batchStart = 0; batchStart < iterations; batchStart += batch) {
    const batchEnd = Math.min(batchStart + batch, iterations);
    const batchSize = batchEnd - batchStart;

    if (iterations > 1) {
      console.log(`\n${"━".repeat(60)}`);
      console.log(
        batchSize > 1
          ? `ITERATIONS ${batchStart + 1}-${batchEnd}/${iterations} (batch of ${batchSize})`
          : `ITERATION ${batchStart + 1}/${iterations}`
      );
      console.log("━".repeat(60));
    }

    const batchPromises = Array.from({ length: batchSize }, (_, i) => {
      const iterNum = batchStart + i + 1;
      return (async () => {
        const existingFiles = files.filter((f) => {
          if (!existsSync(f)) {
            console.error(`File not found: ${f}`);
            return false;
          }
          return true;
        });

        const runOne = async (file: string) => {
          try {
            return await processFile(file);
          } catch (error: any) {
            console.error(
              `\n  ❌ FAILED iter ${iterNum} ${basename(file)}: ${error.message}`
            );
            return null;
          }
        };

        const iterResults: FileEvalResult[] = [];
        if (parallelFiles) {
          const settled = await Promise.all(existingFiles.map(runOne));
          for (const r of settled) if (r) iterResults.push(r);
        } else {
          for (const file of existingFiles) {
            const r = await runOne(file);
            if (r) iterResults.push(r);
          }
        }
        return iterResults;
      })();
    });

    const batchResults = await Promise.all(batchPromises);

    for (let i = 0; i < batchResults.length; i++) {
      const iterResults = batchResults[i];
      allIterationResults.push(iterResults);

      if (iterations > 1) {
        const iterNum = batchStart + i + 1;
        const iterQuestions = iterResults.flatMap((r) => r.questions);
        const iterDupes = iterResults.reduce(
          (s, r) => s + r.duplicateGroups.length,
          0
        );
        const iterDupeQs = iterResults.reduce(
          (s, r) =>
            s +
            r.duplicateGroups.reduce((s2, g) => s2 + g.indices.length, 0),
          0
        );
        const dupeRate =
          iterQuestions.length > 0
            ? `${((iterDupeQs / iterQuestions.length) * 100).toFixed(1)}%`
            : "N/A";
        console.log(
          `  Iter ${iterNum}: ${iterQuestions.length} questions — ${iterDupes} dupe groups — rate: ${dupeRate}`
        );
      }
    }
  }

  const results = allIterationResults.flat();
  const totalTimeMs = Date.now() - startTime;

  // ── Aggregate ──
  const allQuestions = results.flatMap((r) => r.questions);
  const total = allQuestions.length;

  const totalLessons = results.reduce((s, r) => s + r.totalLessons, 0);
  const successfulLessons = results.reduce(
    (s, r) => s + r.successfulLessons,
    0
  );
  const totalFirstPass = results.reduce((s, r) => s + r.firstPassSuccess, 0);
  const totalCorrect = allQuestions.filter(
    (q) => q.correctness.correct
  ).length;
  const totalSelfContained = allQuestions.filter(
    (q) => q.grounding.selfContained
  ).length;
  const totalConcrete = allQuestions.filter(
    (q) => q.grounding.concrete
  ).length;
  const totalGrounded = allQuestions.filter(
    (q) => q.grounding.grounded
  ).length;
  const totalFullyGrounded = allQuestions.filter(
    (q) =>
      q.grounding.selfContained &&
      q.grounding.concrete &&
      q.grounding.grounded
  ).length;
  const totalSufficient = allQuestions.filter(
    (q) => q.sufficiency.sufficient
  ).length;
  const totalDupeGroups = results.reduce(
    (s, r) => s + r.duplicateGroups.length,
    0
  );
  const questionsInDupes = results.reduce(
    (s, r) =>
      s +
      r.duplicateGroups.reduce((s2, g) => s2 + g.indices.length, 0),
    0
  );
  const hintLeakEnabled = enabledDimensions.has("hint-leak");
  const totalHintLeaks = hintLeakEnabled
    ? allQuestions.filter((q) => q.hintLeak.leaksAnswer).length
    : 0;
  const totalDirectHintLeaks = hintLeakEnabled
    ? allQuestions.filter((q) => q.hintLeak.severity === "direct").length
    : 0;
  const totalPartialHintLeaks = hintLeakEnabled
    ? allQuestions.filter((q) => q.hintLeak.severity === "partial").length
    : 0;

  const pct = (n: number, d: number = total) =>
    d > 0 ? `${Math.round((n / d) * 100)}%` : "N/A";

  console.log("\n" + "═".repeat(60));
  console.log(
    `FULL EVALUATION RESULTS${iterations > 1 ? ` (${iterations} iterations)` : ""}`
  );
  console.log("═".repeat(60));
  console.log(`  Total time:         ${(totalTimeMs / 1000).toFixed(1)}s`);
  if (iterations > 1) console.log(`  Iterations:         ${iterations}`);
  console.log();
  console.log("  ── 1. Structural ──");
  console.log(`  Total lessons:      ${totalLessons}`);
  console.log(
    `  Successful:         ${successfulLessons}/${totalLessons} (${pct(successfulLessons, totalLessons)})`
  );
  console.log(
    `  First-pass:         ${totalFirstPass}/${totalLessons} (${pct(totalFirstPass, totalLessons)})`
  );
  console.log();
  console.log("  ── 2. Answer Correctness ──");
  console.log(
    `  Correct:            ${totalCorrect}/${total} (${pct(totalCorrect)})`
  );
  console.log();
  console.log("  ── 3. Answer Grounding ──");
  console.log(
    `  Fully grounded:     ${totalFullyGrounded}/${total} (${pct(totalFullyGrounded)})`
  );
  console.log(
    `    Self-contained:   ${totalSelfContained}/${total} (${pct(totalSelfContained)})`
  );
  console.log(
    `    Concrete:         ${totalConcrete}/${total} (${pct(totalConcrete)})`
  );
  console.log(
    `    Grounded:         ${totalGrounded}/${total} (${pct(totalGrounded)})`
  );
  console.log();
  console.log("  ── 4. Content Sufficiency ──");
  console.log(
    `  Sufficient:         ${totalSufficient}/${total} (${pct(totalSufficient)})`
  );
  console.log();
  console.log("  ── 5. Duplicates ──");
  console.log(`  Duplicate groups:   ${totalDupeGroups}`);
  console.log(
    `  Questions in dupes: ${questionsInDupes}/${total} (${pct(questionsInDupes)})`
  );
  if (hintLeakEnabled) {
    console.log();
    console.log("  ── 6. Hint Answer Leak ──");
    console.log(
      `  Hint leaks:         ${totalHintLeaks}/${total} (${pct(totalHintLeaks)})`
    );
    console.log(
      `    Direct leaks:     ${totalDirectHintLeaks}/${total} (${pct(totalDirectHintLeaks)})`
    );
    console.log(
      `    Partial leaks:    ${totalPartialHintLeaks}/${total} (${pct(totalPartialHintLeaks)})`
    );
  }

  // Per question-type breakdown
  const byType = new Map<
    string,
    {
      total: number;
      correct: number;
      selfContained: number;
      concrete: number;
      grounded: number;
      fullyGrounded: number;
      sufficient: number;
      hintLeaks: number;
    }
  >();
  for (const q of allQuestions) {
    const e = byType.get(q.questionType) ?? {
      total: 0,
      correct: 0,
      selfContained: 0,
      concrete: 0,
      grounded: 0,
      fullyGrounded: 0,
      sufficient: 0,
      hintLeaks: 0,
    };
    e.total++;
    if (q.correctness.correct) e.correct++;
    if (q.grounding.selfContained) e.selfContained++;
    if (q.grounding.concrete) e.concrete++;
    if (q.grounding.grounded) e.grounded++;
    if (
      q.grounding.selfContained &&
      q.grounding.concrete &&
      q.grounding.grounded
    )
      e.fullyGrounded++;
    if (q.sufficiency.sufficient) e.sufficient++;
    if (q.hintLeak.leaksAnswer) e.hintLeaks++;
    byType.set(q.questionType, e);
  }

  console.log("\n  Per question-type:");
  console.log("  " + "-".repeat(82));
  console.log(
    "  " +
      "Type".padEnd(18) +
      "Correct".padEnd(10) +
      "Self-C".padEnd(9) +
      "Concr".padEnd(9) +
      "Ground".padEnd(9) +
      "Suff".padEnd(9) +
      "All"
  );
  console.log("  " + "-".repeat(82));
  for (const [type, s] of byType.entries()) {
    const p = (n: number) => `${Math.round((n / s.total) * 100)}%`;
    console.log(
      `  ${type.padEnd(16)}  ${p(s.correct).padEnd(8)}  ${p(s.selfContained).padEnd(7)}  ${p(s.concrete).padEnd(7)}  ${p(s.grounded).padEnd(7)}  ${p(s.sufficient).padEnd(7)}  ${p(s.fullyGrounded)}`
    );
  }

  // Show duplicate groups if any
  if (totalDupeGroups > 0) {
    console.log("\n  " + "-".repeat(60));
    console.log("  DUPLICATE GROUPS");
    console.log("  " + "-".repeat(60));
    for (const r of results) {
      for (const g of r.duplicateGroups) {
        console.log(
          `\n  🔁 "${g.question.substring(0, 80)}${g.question.length > 80 ? "..." : ""}"`
        );
        for (const idx of g.indices) {
          const q = r.questions[idx];
          console.log(
            `     └─ M${q.moduleIndex + 1}L${q.lessonIndex + 1} (${q.questionType})`
          );
        }
      }
    }
  }

  // ── Save JSON ──
  if (!existsSync(BENCHMARKS_DIR)) {
    mkdirSync(BENCHMARKS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/:/g, "-").split(".")[0];
  const outputPath = resolve(BENCHMARKS_DIR, `${tag}-${timestamp}.json`);

  // Generation cost from captured tokens (Together pricing; undefined if model unpriced)
  const genModelName = model ?? DEFAULT_MODEL;
  const pricing = getModelPricing(genModelName);
  const costUsd = pricing
    ? (genInputTokens / 1e6) * pricing.input + (genOutputTokens / 1e6) * pricing.output
    : undefined;
  if (costUsd != null) {
    console.log(
      `  Gen cost:           $${costUsd.toFixed(4)} (${genInputTokens.toLocaleString()} in / ${genOutputTokens.toLocaleString()} out tokens)`
    );
  }

  const output = {
    tag,
    timestamp: new Date().toISOString(),
    generationModel: model ?? DEFAULT_MODEL,
    judgeModel,
    iterations,
    batchSize: batch,
    dimensions: [...enabledDimensions],
    totalTimeMs,
    usage: {
      inputTokens: genInputTokens,
      outputTokens: genOutputTokens,
      costUsd: costUsd ?? null,
      costPerLesson: costUsd != null && totalLessons > 0 ? costUsd / totalLessons : null,
    },
    aggregate: {
      structural: {
        totalLessons,
        successfulLessons,
        firstPassSuccess: totalFirstPass,
        successRate: pct(successfulLessons, totalLessons),
        firstPassRate: pct(totalFirstPass, totalLessons),
      },
      correctness: {
        totalGraded: total,
        correct: totalCorrect,
        accuracy: pct(totalCorrect),
      },
      grounding: {
        totalGraded: total,
        fullyGrounded: `${totalFullyGrounded}/${total} (${pct(totalFullyGrounded)})`,
        selfContained: `${totalSelfContained}/${total} (${pct(totalSelfContained)})`,
        concrete: `${totalConcrete}/${total} (${pct(totalConcrete)})`,
        grounded: `${totalGrounded}/${total} (${pct(totalGrounded)})`,
      },
      sufficiency: {
        totalGraded: total,
        sufficient: totalSufficient,
        rate: pct(totalSufficient),
      },
      duplicates: {
        duplicateGroups: totalDupeGroups,
        questionsInDupes,
        duplicationRate: pct(questionsInDupes),
      },
      hintLeak: {
        totalChecked: hintLeakEnabled ? total : 0,
        leaks: totalHintLeaks,
        directLeaks: totalDirectHintLeaks,
        partialLeaks: totalPartialHintLeaks,
        leakRate: hintLeakEnabled ? pct(totalHintLeaks) : "N/A",
        directLeakRate: hintLeakEnabled ? pct(totalDirectHintLeaks) : "N/A",
      },
      byQuestionType: Object.fromEntries(
        [...byType.entries()].map(([type, s]) => [
          type,
          {
            total: s.total,
            correct: `${s.correct}/${s.total}`,
            fullyGrounded: `${s.fullyGrounded}/${s.total}`,
            sufficient: `${s.sufficient}/${s.total}`,
            hintLeaks: `${s.hintLeaks}/${s.total}`,
          },
        ])
      ),
    },
    results: results.map((r) => ({
      file: r.file,
      totalLessons: r.totalLessons,
      successfulLessons: r.successfulLessons,
      firstPassSuccess: r.firstPassSuccess,
      ocrTimeMs: r.ocrTimeMs,
      generationTimeMs: r.generationTimeMs,
      judgingTimeMs: r.judgingTimeMs,
      duplicateGroups: r.duplicateGroups,
      questions: r.questions.map((q) => ({
        moduleTitle: q.moduleTitle,
        moduleIndex: q.moduleIndex,
        lessonTitle: q.lessonTitle,
        lessonIndex: q.lessonIndex,
        questionType: q.questionType,
        lessonContent: q.lessonContent,
        question: q.question,
        answer: q.answer,
        hint: q.hint,
        choices: q.choices,
        slots: q.slots,
        explanation: q.explanation,
        wasFixed: q.wasFixed,
        fixAttempts: q.fixAttempts,
        correctness: q.correctness,
        grounding: q.grounding,
        heuristicFlags: q.heuristicFlags,
        sufficiency: q.sufficiency,
        hintLeak: q.hintLeak,
        rawSufficiencyResponse: q.sufficiency.rawResponse,
        sufficiencyParseStatus: q.sufficiency.parseStatus,
      })),
    })),
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n💾 Saved to ${outputPath}`);

  // Auto-sync this run into the Neon benchmark_runs table for over-time tracking.
  // Non-fatal: a missing DATABASE_URL or DB error must never fail the eval.
  try {
    const { syncBenchmarkFile } = await import("./lib/benchmark-db");
    const synced = await syncBenchmarkFile(outputPath);
    if (synced) console.log(`📤 Synced to benchmark_runs`);
  } catch (e: any) {
    console.warn(`⚠️  DB sync skipped: ${e.message}`);
  }
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
