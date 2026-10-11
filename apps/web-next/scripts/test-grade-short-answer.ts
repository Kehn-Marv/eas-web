#!/usr/bin/env node

/**
 * Test script for the /api/grade-short-answer endpoint
 * 
 * Usage:
 *   tsx scripts/test-grade-short-answer.ts [--api-key <key>] [--url <url>]
 * 
 * Examples:
 *   tsx scripts/test-grade-short-answer.ts
 *   tsx scripts/test-grade-short-answer.ts --api-key your-key-here
 *   tsx scripts/test-grade-short-answer.ts --url http://localhost:3000
 */

const DEFAULT_URL = "http://localhost:3000";
const DEFAULT_API_KEY = process.env.TOGETHER_API_KEY || "";

interface TestCase {
  name: string;
  userAnswer: string;
  correctAnswer: string;
  content: string;
  info: string;
  question: string;
  expectedCorrect?: boolean; // Optional: what we expect the result to be
}

const testCases: TestCase[] = [
  {
    name: "Correct answer - exact match",
    userAnswer: "recurrent and convolutional neural networks",
    correctAnswer: "recurrent and convolutional neural networks",
    content: "The Transformer architecture is a novel neural network design that dispenses with recurrence and convolution, relying solely on attention mechanisms.",
    info: "The Transformer was the first transduction model to rely entirely on self-attention.",
    question: "What are the two types of neural network components that the Transformer architecture completely avoids using?",
    expectedCorrect: true,
  },
  {
    name: "Correct answer - paraphrased",
    userAnswer: "The Transformer avoids using recurrent networks and convolutional networks",
    correctAnswer: "recurrent and convolutional neural networks",
    content: "The Transformer architecture is a novel neural network design that dispenses with recurrence and convolution, relying solely on attention mechanisms.",
    info: "The Transformer was the first transduction model to rely entirely on self-attention.",
    question: "What are the two types of neural network components that the Transformer architecture completely avoids using?",
    expectedCorrect: true,
  },
  {
    name: "Incorrect answer - wrong concept",
    userAnswer: "feedforward and backpropagation networks",
    correctAnswer: "recurrent and convolutional neural networks",
    content: "The Transformer architecture is a novel neural network design that dispenses with recurrence and convolution, relying solely on attention mechanisms.",
    info: "The Transformer was the first transduction model to rely entirely on self-attention.",
    question: "What are the two types of neural network components that the Transformer architecture completely avoids using?",
    expectedCorrect: false,
  },
  {
    name: "Partially correct answer",
    userAnswer: "recurrent networks",
    correctAnswer: "recurrent and convolutional neural networks",
    content: "The Transformer architecture is a novel neural network design that dispenses with recurrence and convolution, relying solely on attention mechanisms.",
    info: "The Transformer was the first transduction model to rely entirely on self-attention.",
    question: "What are the two types of neural network components that the Transformer architecture completely avoids using?",
    // This could go either way depending on how strict the LLM is
  },
];

async function testEndpoint(
  url: string,
  apiKey: string,
  testCase: TestCase
): Promise<{ success: boolean; result?: any; error?: string }> {
  try {
    const response = await fetch(`${url}/api/grade-short-answer`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Together-API-Key": apiKey,
      },
      body: JSON.stringify({
        userAnswer: testCase.userAnswer,
        correctAnswer: testCase.correctAnswer,
        content: testCase.content,
        info: testCase.info,
        question: testCase.question,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const isCreditsError = response.status === 402;
      const creditsRemaining = response.headers.get("X-Credits-Remaining");
      
      return {
        success: false,
        error: isCreditsError
          ? `Insufficient credits: ${errorData.message || `You have ${creditsRemaining || 0} credit(s) remaining`}`
          : `HTTP ${response.status}: ${errorData.error || response.statusText}`,
      };
    }

    const result = await response.json();
    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function printTestCase(testCase: TestCase, index: number) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`Test ${index + 1}: ${testCase.name}`);
  console.log(`${"=".repeat(80)}`);
  console.log(`Question: ${testCase.question}`);
  console.log(`\nCorrect Answer: ${testCase.correctAnswer}`);
  console.log(`User Answer: ${testCase.userAnswer}`);
  if (testCase.expectedCorrect !== undefined) {
    console.log(`Expected: ${testCase.expectedCorrect ? "✅ Correct" : "❌ Incorrect"}`);
  }
}

function printResult(result: any, expectedCorrect?: boolean) {
  console.log(`\n📊 Result:`);
  console.log(`   isCorrect: ${result.isCorrect ? "✅ Yes" : "❌ No"}`);
  if (result.explanation) {
    console.log(`   Explanation: ${result.explanation}`);
  }

  if (expectedCorrect !== undefined) {
    const matches = result.isCorrect === expectedCorrect;
    console.log(
      `\n${matches ? "✅" : "❌"} ${matches ? "PASS" : "FAIL"}: Expected ${
        expectedCorrect ? "correct" : "incorrect"
      }, got ${result.isCorrect ? "correct" : "incorrect"}`
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  let apiKey = DEFAULT_API_KEY;
  let url = DEFAULT_URL;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--api-key" && args[i + 1]) {
      apiKey = args[i + 1];
      i++;
    } else if (args[i] === "--url" && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
Usage: tsx scripts/test-grade-short-answer.ts [options]

Options:
  --api-key <key>    Together AI API key (default: TOGETHER_API_KEY env var)
  --url <url>        Base URL for the API (default: http://localhost:3000)
  --help, -h         Show this help message

Examples:
  tsx scripts/test-grade-short-answer.ts
  tsx scripts/test-grade-short-answer.ts --api-key your-key-here
  tsx scripts/test-grade-short-answer.ts --url http://localhost:3000
      `);
      process.exit(0);
    }
  }

  if (!apiKey) {
    console.error("❌ Error: API key is required");
    console.error("   Set TOGETHER_API_KEY environment variable or use --api-key flag");
    process.exit(1);
  }

  console.log(`🚀 Testing /api/grade-short-answer endpoint`);
  console.log(`   URL: ${url}`);
  console.log(`   API Key: ${apiKey.substring(0, 10)}...`);

  // Test connection first
  console.log(`\n🔍 Testing connection...`);
  const connectionTest = await fetch(`${url}/api/grade-short-answer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Together-API-Key": apiKey,
    },
    body: JSON.stringify({
      userAnswer: "test",
      correctAnswer: "test",
      content: "test",
      info: "test",
      question: "test",
    }),
  }).catch(() => null);

  if (!connectionTest) {
    console.error(`\n❌ Error: Could not connect to ${url}`);
    console.error(`   Make sure the Next.js dev server is running (pnpm dev)`);
    process.exit(1);
  }

  console.log(`✅ Connection successful\n`);

  // Run test cases
  let passed = 0;
  let failed = 0;
  let errors = 0;

  for (let i = 0; i < testCases.length; i++) {
    const testCase = testCases[i];
    printTestCase(testCase, i);

    const { success, result, error } = await testEndpoint(url, apiKey, testCase);

    if (!success) {
      console.error(`\n❌ Error: ${error}`);
      errors++;
      continue;
    }

    if (!result) {
      console.error(`\n❌ Error: No result returned`);
      errors++;
      continue;
    }

    printResult(result, testCase.expectedCorrect);

    if (testCase.expectedCorrect !== undefined) {
      if (result.isCorrect === testCase.expectedCorrect) {
        passed++;
      } else {
        failed++;
      }
    }
  }

  // Summary
  console.log(`\n${"=".repeat(80)}`);
  console.log(`📊 Test Summary`);
  console.log(`${"=".repeat(80)}`);
  console.log(`   Total tests: ${testCases.length}`);
  const hasExpectedResults = testCases.some(tc => tc.expectedCorrect !== undefined);
  if (hasExpectedResults) {
    console.log(`   ✅ Passed: ${passed}`);
    console.log(`   ❌ Failed: ${failed}`);
  }
  console.log(`   ⚠️  Errors: ${errors}`);
  console.log(`${"=".repeat(80)}\n`);

  process.exit(errors > 0 || failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("❌ Unexpected error:", error);
  process.exit(1);
});

