/**
 * Combined flow generation: detect a flow AND emit the ordering question
 * in a single LLM call, instead of the production two-call pattern
 * (generateFlowDiagram → generateFlowQuestion).
 *
 * Used by pipelineParallelCombinedFlow in pipeline.ts.
 */
import { generateText } from "ai";
import { QuestionType, type FlowDiagramLesson, type SimpleEdge } from "../types";
import { combinedFlowSchema } from "../schemas";
import { createTogetherClient, DEFAULT_MODEL, getTogetherProviderOptions } from "../utils/together";
import { parseJSON } from "../utils/json";
import { sanitizeGeneratedHint } from "../hint-answer-leak";

export interface CombinedFlowInput {
  moduleTitle: string;
  content: string;
  apiKey: string;
  model?: string;
  previousQuestions?: string[];
  /**
   * If set, the flow generator is told to focus on this specific process from
   * the source. Used by pipelineParallelDistinctFlow to prevent cross-module
   * flow-diagram collisions.
   */
  flowFocus?: string;
}

function topologicalSort(nodes: { id: string }[], edges: [string, string][]): string[] {
  const ids = nodes.map((n) => n.id);
  const inDegree = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, [] as string[]]));
  for (const [from, to] of edges) {
    adj.get(from)?.push(to);
    inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of adj.get(cur) ?? []) {
      inDegree.set(next, (inDegree.get(next) ?? 0) - 1);
      if (inDegree.get(next) === 0) queue.push(next);
    }
  }
  return order;
}

function safeFlowInfo({
  info,
  question,
  answer,
  choices,
  slots,
}: {
  info: unknown;
  question: unknown;
  answer: number[];
  choices: string[];
  slots: string[];
}): string {
  return sanitizeGeneratedHint({
    questionType: QuestionType.FlowDiagram,
    question,
    hint: info,
    answer,
    choices,
    slots,
  });
}

export async function generateFlowLessonCombined({
  moduleTitle,
  content,
  apiKey,
  model = DEFAULT_MODEL,
  previousQuestions = [],
  flowFocus,
}: CombinedFlowInput): Promise<FlowDiagramLesson | null> {
  const together = createTogetherClient(apiKey);
  const providerOptions = getTogetherProviderOptions(model);

  const dedup = previousQuestions.length
    ? `\nAVOID DUPLICATES — these questions already exist in other modules. Pick a DIFFERENT process unique to "${moduleTitle}":\n${previousQuestions.map((q, i) => `${i + 1}. "${q}"`).join("\n")}\n`
    : "";

  const focus = flowFocus
    ? `\nYOUR ASSIGNED PROCESS for this module is: **${flowFocus}**.
Model THIS specific process — not any other process from the source. The lesson MUST be about "${flowFocus}".\n`
    : "";

  const prompt = `Analyse the following content for the module "${moduleTitle}".
Decide whether the content describes a PROCESS, SYSTEM, or SEQUENTIAL FLOW (4-8 steps) suitable for a drag-and-drop ordering question.
If yes, emit BOTH the flow structure AND the ordering question in a SINGLE JSON response.
Only include steps EXPLICITLY described in the source. Do NOT invent or infer.
The flow MUST be specific to this module's topic ("${moduleTitle}").
${focus}${dedup}

GROUNDING REQUIREMENTS — these prevent the lesson from failing quality checks:
- The "content" field MUST teach each of the 3 stepsInOrder with at least one full sentence per step explaining WHAT happens at that step. Don't just name-drop the step.
- The 3 stepsInOrder MUST be a clear sequential progression with causal or temporal ordering — not bullet points of unrelated facts.
- The "question" MUST mention the process by its full name (e.g., "the JPEG compression pipeline", not "the pipeline").
- Do not create a task-specific hint for this ordering question. Set "info" exactly to: "Trace the sequence described in the lesson content before placing the steps."
- If you cannot find a clear sequential process with explicit ordering in the source, return {"hasFlow": false}. It is BETTER to skip the flow lesson than to fabricate one.

Respond ONLY with JSON. No other text. No markdown fences.

If NOT suitable:
{"hasFlow": false}

If suitable:
{
  "hasFlow": true,
  "flowConfig": {
    "nodes": [
      {"id":"step-1","label":"Concise label","type":"start"},
      {"id":"step-2","label":"Process step","type":"process"},
      {"id":"step-3","label":"Final output","type":"output"}
    ],
    "edges": [["step-1","step-2"],["step-2","step-3"]]
  },
  "title": "Lesson title",
  "content": "A 4-6 sentence explanation that explicitly names the steps used in the ordering question.",
  "info": "Trace the sequence described in the lesson content before placing the steps.",
  "question": "What is the correct order of steps in [specific process name]?",
  "stepsInOrder": ["First step label", "Second step label", "Third step label"]
}

Rules:
- 4-8 nodes total; exactly one "start", one "output", others "process". Each id unique.
- "stepsInOrder" picks 3 sequential node labels in chronological order — they MUST be a subset of node labels.
- "question" must mention the actual process by name, not generic phrasing.
- "content" must explicitly include the 3 step names so a student can solve from content alone.

Source content:
${content}`;

  try {
    const result = await generateText({
      model: together(model),
      providerOptions,
      prompt,
    });

    const parsed = parseJSON(result.text);
    const validated = combinedFlowSchema.safeParse(parsed);
    if (!validated.success) return null;

    const data = validated.data;
    if (data.hasFlow === false) return null;

    // Use topological order from the flow as source of truth for the ordering.
    const topoOrder = topologicalSort(data.flowConfig.nodes, data.flowConfig.edges);
    const labelToPos = new Map<string, number>();
    for (let i = 0; i < topoOrder.length; i++) {
      const node = data.flowConfig.nodes.find((n) => n.id === topoOrder[i]);
      if (node) labelToPos.set(node.label, i);
    }

    const correctOrder = [...data.stepsInOrder].sort((a, b) => {
      const pa = labelToPos.get(a) ?? Infinity;
      const pb = labelToPos.get(b) ?? Infinity;
      return pa - pb;
    });

    const choices = [...correctOrder];
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    const slots = ["First", "Second", "Third"];
    const answer = correctOrder.map((step) => choices.indexOf(step));
    const info = safeFlowInfo({ info: data.info, question: data.question, answer, choices, slots });

    return {
      title: data.title,
      content: data.content,
      info,
      question: data.question,
      questionType: QuestionType.FlowDiagram,
      flowConfig: {
        nodes: data.flowConfig.nodes.map((n) => ({ id: n.id, label: n.label, type: n.type })),
        edges: data.flowConfig.edges as SimpleEdge[],
      },
      choices,
      slots,
      answer,
    };
  } catch {
    return null;
  }
}
