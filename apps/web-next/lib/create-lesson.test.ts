import { validateLesson } from "./create-lesson";
import { QuestionType, type MultipleChoiceLesson } from "./types";

/**
 * Simple test for lesson validation
 *
 * Usage:
 *   pnpm exec tsx lib/create-lesson.test.ts
 */

async function testValidateLesson() {
  if (!process.env.TOGETHER_API_KEY) {
    console.error("❌ TOGETHER_API_KEY environment variable not set");
    process.exit(1);
  }
  const apiKey = process.env.TOGETHER_API_KEY;

  console.log("🧪 Testing Lesson Validation\n");
  console.log("=".repeat(60));

  // Hardcoded source content
  const content = `
# Transformer Architecture

The Transformer architecture, introduced in the paper "Attention Is All You Need," 
revolutionized natural language processing. Unlike traditional RNNs and LSTMs, 
the Transformer relies entirely on attention mechanisms, specifically self-attention 
and multi-head attention.

The key innovation is the ability to process all tokens in parallel, rather than 
sequentially. This is achieved through the self-attention mechanism, which computes 
attention scores between all pairs of tokens in the input sequence.

The Transformer consists of an encoder and decoder, each composed of multiple layers. 
Each layer contains two main components:
1. Multi-head self-attention mechanism
2. Position-wise feed-forward neural network

The model also uses positional encodings to inject information about the position 
of tokens in the sequence, since the attention mechanism itself has no notion of order.
`;

  const moduleTitle = "Introduction to Transformers";

  // Test Case 1: Valid Multiple Choice Lesson
  console.log("\n📝 Test Case 1: Valid Multiple Choice Lesson");
  console.log("-".repeat(60));

  const validLesson: MultipleChoiceLesson = {
    title: "Understanding Self-Attention",
    content:
      "The Transformer uses self-attention to process all tokens in parallel. This mechanism computes attention scores between all pairs of tokens, allowing the model to capture dependencies regardless of distance in the sequence.",
    info: "Self-attention computes attention scores between all pairs of tokens in the input sequence.",
    question: "What is the key advantage of self-attention in Transformers?",
    answer: 1, // Index of correct answer
    choices: [
      "It processes tokens sequentially like RNNs",
      "It can process all tokens in parallel",
      "It eliminates the need for encoders",
      "It only works with English text",
    ],
    questionType: QuestionType.MultipleChoice,
  };

  try {
    const startTime = Date.now();
    const result = await validateLesson({
      lesson: validLesson,
      moduleTitle,
      content,
      apiKey,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`⏱️  Completed in ${elapsed}s`);
    console.log(`\nResult: ${result.isValid ? "✅ VALID" : "❌ INVALID"}`);
    console.log(`Explanation: ${result.explanation}`);

    if (result.issues) {
      console.log("\n⚠️  Issues found:");
      Object.entries(result.issues).forEach(([key, value]) => {
        console.log(`  - ${key}: ${value}`);
      });
    } else {
      console.log("\n✨ No issues found!");
    }

    // Assert test passed
    if (result.isValid) {
      console.log("\n✅ TEST PASSED: Valid lesson was correctly validated");
    } else {
      console.log(
        "\n❌ TEST FAILED: Valid lesson was incorrectly marked as invalid"
      );
    }
  } catch (error) {
    console.error("\n❌ TEST ERROR:", error);
    process.exit(1);
  }

  // Test Case 2: Invalid Lesson (wrong answer)
  console.log("\n\n📝 Test Case 2: Invalid Lesson (Incorrect Answer)");
  console.log("-".repeat(60));

  const invalidLesson: MultipleChoiceLesson = {
    title: "Understanding Self-Attention",
    content:
      "The Transformer uses self-attention to process all tokens in parallel. This mechanism computes attention scores between all pairs of tokens.",
    info: "Self-attention processes tokens sequentially.", // This is wrong!
    question: "What is the key advantage of self-attention in Transformers?",
    answer: 0, // Wrong answer index
    choices: [
      "It processes tokens sequentially like RNNs", // Wrong answer
      "It can process all tokens in parallel", // This is actually correct
      "It eliminates the need for encoders",
      "It only works with English text",
    ],
    questionType: QuestionType.MultipleChoice,
  };

  try {
    const startTime = Date.now();
    const result = await validateLesson({
      lesson: invalidLesson,
      moduleTitle,
      content,
      apiKey,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`⏱️  Completed in ${elapsed}s`);
    console.log(`\nResult: ${result.isValid ? "✅ VALID" : "❌ INVALID"}`);
    console.log(`Explanation: ${result.explanation}`);

    if (result.issues) {
      console.log("\n⚠️  Issues found:");
      Object.entries(result.issues).forEach(([key, value]) => {
        console.log(`  - ${key}: ${value}`);
      });
    }

    // Assert test passed
    if (!result.isValid) {
      console.log("\n✅ TEST PASSED: Invalid lesson was correctly identified");
    } else {
      console.log(
        "\n❌ TEST FAILED: Invalid lesson was incorrectly marked as valid"
      );
    }
  } catch (error) {
    console.error("\n❌ TEST ERROR:", error);
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  console.log("🎉 All tests completed!\n");
}

testValidateLesson();
