#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { detectHintAnswerLeak, sanitizeGeneratedHint } from "../lib/hint-answer-leak";
import {
  combinedFlowSchema,
  fixFlowDiagramSchema,
  flowQuestionSchema,
  standardLessonsSchema,
} from "../lib/schemas";

const leak = (input: Parameters<typeof detectHintAnswerLeak>[0]) =>
  detectHintAnswerLeak(input);

function assertLeak(input: Parameters<typeof detectHintAnswerLeak>[0], severity = "direct") {
  const result = leak(input);
  assert.equal(result.leaksAnswer, true, JSON.stringify(result, null, 2));
  assert.equal(result.severity, severity, JSON.stringify(result, null, 2));
}

function assertNoLeak(input: Parameters<typeof detectHintAnswerLeak>[0]) {
  const result = leak(input);
  assert.equal(result.leaksAnswer, false, JSON.stringify(result, null, 2));
  assert.equal(result.severity, "none", JSON.stringify(result, null, 2));
}

assertLeak({
  questionType: "short-answer",
  hint: "The base model selected for Composer 2 was Kimi K2.5.",
  answer: "Kimi K2.5",
});

assertNoLeak({
  questionType: "short-answer",
  hint: "Look for the base model chosen after comparing candidate models.",
  answer: "Kimi K2.5",
});

assertLeak({
  questionType: "multiple-choice",
  hint: "CursorBench tasks require a median of 181 lines changed.",
  answer: 3,
  choices: [390, 10, 7, 181],
});

assertLeak({
  questionType: "multiple-choice",
  hint: "The fourth choice is the one supported by the report.",
  answer: 3,
  choices: [390, 10, 7, 181],
});

assertNoLeak({
  questionType: "multiple-choice",
  question: "What median change size does CursorBench require?",
  hint: "Compare the reported median for CursorBench against the public benchmarks.",
  answer: 3,
  choices: [390, 10, 7, 181],
});

assertLeak(
  {
    questionType: "multiple-choice",
    question: "Which of the following is one of the four ways to manage Claude Code's allowed tools?",
    hint: "Identify the option that involves an interactive prompt during a session.",
    answer: 2,
    choices: [
      "Use the /init command",
      "Edit the .bashrc file",
      'Select "Always allow" when prompted during a session',
      "Delete the CLAUDE.md file",
    ],
  },
  "partial"
);

assertLeak(
  {
    questionType: "multiple-choice",
    question:
      "Which prompt principle stresses that agents must examine all available tools, match tool usage to user intent, and prefer specialized tools over generic ones?",
    hint: "Match the description of the principle that focuses on tool selection and descriptions.",
    answer: 2,
    choices: [
      "Let agents improve themselves - agents can diagnose failures and rewrite tool descriptions to avoid mistakes.",
      "Teach the orchestrator how to delegate - the lead agent breaks down queries and gives clear instructions to subagents.",
      "Tool design and selection are critical - agents should examine all tools, match usage to intent, and prefer specialized tools.",
      "Guide the thinking process - extended thinking mode acts as a controllable scratchpad for planning and evaluation.",
    ],
  },
  "partial"
);

assertNoLeak({
  questionType: "multiple-choice",
  question: "Which model provides a 32k context length?",
  hint: 'Match the model name that includes the "32k" token length indicator.',
  answer: 0,
  choices: [
    "togethercomputer/m2-bert-80M-32k-retrieval",
    "togethercomputer/m2-bert-80M-8k-retrieval",
    "BGE model",
    "UAE-Large-v1",
  ],
});

assertLeak({
  questionType: "true-false",
  hint: "The statement is false.",
  answer: false,
});

assertNoLeak({
  questionType: "true-false",
  hint: "Compare the statement against the sequence described in the lesson.",
  answer: false,
});

assertLeak({
  questionType: "flow-diagram",
  hint: "The pipeline goes from Select Base Model to Continued Pretraining to RL Training.",
  answer: [0, 1, 2],
  choices: ["Select Base Model", "Continued Pretraining", "RL Training"],
  slots: ["First", "Second", "Third"],
});

assertNoLeak({
  questionType: "flow-diagram",
  hint: "Trace how the training process builds from preparation into optimization.",
  answer: [0, 1, 2],
  choices: ["Select Base Model", "Continued Pretraining", "RL Training"],
  slots: ["First", "Second", "Third"],
});

assertLeak(
  {
    questionType: "flow-diagram",
    hint: "Think about how the image data is first re-expressed, then broken into blocks, and finally simplified.",
    answer: [1, 2, 0],
    choices: [
      "Quantize and discard high-frequency coefficients",
      "Convert RGB to YCbCr and subsample",
      "Divide image into 8x8 blocks and apply DCT",
    ],
    slots: ["First", "Second", "Third"],
  },
  "partial"
);

assertLeak(
  {
    questionType: "flow-diagram",
    hint: "Consider how the function moves from file handling to text preparation before calling the embedding model.",
    answer: [1, 0, 2],
    choices: [
      "Filter and split text based on max context length",
      "Read data file and iterate lines",
      "Generate embeddings for selected texts",
    ],
    slots: ["First", "Second", "Third"],
  },
  "partial"
);

assertLeak(
  {
    questionType: "flow-diagram",
    hint: "Think about how sampling, rollout generation, and weight updating are linked.",
    answer: [2, 1, 0],
    choices: ["Update model weights", "Generate rollouts", "Sample problem"],
    slots: ["First", "Second", "Third"],
  },
  "partial"
);

assertNoLeak({
  questionType: "flow-diagram",
  hint: "Think about how the training loop connects attempts to improvement.",
  answer: [2, 1, 0],
  choices: ["Update model weights", "Generate rollouts", "Sample problem"],
  slots: ["First", "Second", "Third"],
});

assertNoLeak({
  questionType: "flow-diagram",
  hint: "Trace the sequence described in the lesson content before placing the steps.",
  answer: [0, 1, 2],
  choices: [
    "Bulk compute at 32k token sequence length",
    "Long-context extension to 256k token sequence length",
    "Short SFT on targeted coding tasks",
  ],
  slots: ["First", "Second", "Third"],
});

assert.equal(
  sanitizeGeneratedHint({
    questionType: "flow-diagram",
    hint: "Think about how the setup, preprocessing, request, and response steps follow each other.",
    answer: [1, 2, 0],
    choices: [
      "Create embedding request via client.embeddings.create",
      "Initialize OpenAI client with Together endpoint",
      "Prepare text by replacing newlines",
    ],
    slots: ["First", "Second", "Third"],
  }),
  "Trace the sequence described in the lesson content before placing the steps."
);

assert.equal(
  sanitizeGeneratedHint({
    questionType: "short-answer",
    hint: "The base model selected for Composer 2 was Kimi K2.5.",
    answer: "Kimi K2.5",
  }),
  "Focus on the specific term, number, or relationship described in the lesson content."
);

assert.equal(
  sanitizeGeneratedHint({
    questionType: "true-false",
    question: "Using --dangerously-skip-permissions is recommended for production environments.",
    hint: "Compare the recommended environment for using the bypass flag with typical production use.",
    answer: false,
  }),
  "Compare the statement against the specific facts described in the lesson content."
);

assert.equal(
  standardLessonsSchema.safeParse({
    lessons: [
      {
        title: "Base model selection",
        content: "Composer 2 selected Kimi K2.5 after internal evaluations.",
        question: "Which base model was selected for Composer 2?",
        questionType: "short-answer",
        answer: "Kimi K2.5",
      },
      {
        title: "Training phases",
        content: "Composer 2 used continued pretraining followed by reinforcement learning.",
        question: "Composer 2 used reinforcement learning after continued pretraining.",
        questionType: "true-false",
        answer: true,
        explanation:
          "The lesson states that continued pretraining was followed by reinforcement learning.",
      },
      {
        title: "CursorBench changes",
        content: "CursorBench tasks require a median of 181 lines changed.",
        question: "What median change size does CursorBench require?",
        questionType: "multiple-choice",
        answer: 0,
        choices: [181, 390, 10, 7],
        explanation: "The report states that CursorBench has a median of 181 lines changed.",
      },
    ],
  }).success,
  true
);

assert.equal(
  flowQuestionSchema.safeParse({
    title: "Training sequence",
    content: "The process starts with base model selection, then continued pretraining, then reinforcement learning.",
    question: "What is the correct order of the Composer 2 training sequence?",
    stepsInOrder: ["Select Base Model", "Continued Pretraining", "RL Training"],
  }).success,
  true
);

assert.equal(
  combinedFlowSchema.safeParse({
    hasFlow: true,
    flowConfig: {
      nodes: [
        { id: "step-1", label: "Select Base Model", type: "start" },
        { id: "step-2", label: "Continued Pretraining", type: "process" },
        { id: "step-3", label: "RL Training", type: "output" },
      ],
      edges: [
        ["step-1", "step-2"],
        ["step-2", "step-3"],
      ],
    },
    title: "Training sequence",
    content: "The process starts with base model selection, then continued pretraining, then reinforcement learning.",
    question: "What is the correct order of the Composer 2 training sequence?",
    stepsInOrder: ["Select Base Model", "Continued Pretraining", "RL Training"],
  }).success,
  true
);

assert.equal(
  fixFlowDiagramSchema.safeParse({
    title: "Training sequence",
    content: "The process starts with base model selection, then continued pretraining, then reinforcement learning.",
    question: "What is the correct order of the Composer 2 training sequence?",
    choices: ["Select Base Model", "Continued Pretraining", "RL Training"],
    slots: ["First", "Second", "Third"],
    answer: [0, 1, 2],
  }).success,
  true
);

console.log("hint-answer-leak and schema resilience tests passed");
