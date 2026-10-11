/**
 * Pre-assign distinct flow-diagram subjects to each module.
 *
 * Without this, parallel modules each independently pick "the most flow-like
 * process in the source" and collide (e.g. all 3 modules of a PNG paper end
 * up asking about PNG compression order). One LLM call decides up-front which
 * process each module owns; collisions then cannot happen by construction.
 */
import { generateText } from "ai";
import { z } from "zod";
import { createTogetherClient, DEFAULT_MODEL, getTogetherProviderOptions } from "../utils/together";
import { parseJSON } from "../utils/json";

export interface FlowAssignmentInput {
  moduleTitles: string[];
  content: string;
  apiKey: string;
  model?: string;
}

/**
 * Returns one process name per module, in the same order as `moduleTitles`.
 * `null` means "no suitable distinct process — skip flow for this module".
 */
export type FlowAssignment = (string | null)[];

const assignmentSchema = z.object({
  assignments: z.array(
    z.object({
      moduleIndex: z.number().int().min(0),
      process: z.string().nullable(),
    })
  ),
});

export async function assignFlowsToModules({
  moduleTitles,
  content,
  apiKey,
  model = DEFAULT_MODEL,
}: FlowAssignmentInput): Promise<FlowAssignment> {
  const together = createTogetherClient(apiKey);
  const providerOptions = getTogetherProviderOptions(model);

  const moduleList = moduleTitles.map((t, i) => `${i}. "${t}"`).join("\n");

  const prompt = `You are planning a course with ${moduleTitles.length} modules:
${moduleList}

The source content is below. For each module, identify the SINGLE most-relevant sequential process from the source (4–8 steps with clear ordering) that fits THAT module's topic.

CRITICAL RULES:
- Each module MUST get a DIFFERENT process. No two modules may be assigned the same process.
- Use the most specific name for each process as it appears in the source (e.g., "JPEG compression pipeline", "Transformer encoder forward pass", "Augustus's rise to power").
- If a module has no suitable distinct sequential process in the source (e.g., the topic is conceptual rather than procedural, or all good processes are already assigned to other modules), set its process to null. It is better to skip than to repeat.
- Total processes across modules must be exhaustive: pick up to ${moduleTitles.length} distinct processes from the source.

Respond ONLY with JSON. No prose.

{
  "assignments": [
    {"moduleIndex": 0, "process": "Process name for module 0 — must be DIFFERENT from module 1 and 2"},
    {"moduleIndex": 1, "process": "Process name for module 1 — DIFFERENT from modules 0 and 2"},
    {"moduleIndex": 2, "process": "Process name for module 2 — DIFFERENT from modules 0 and 1"}
  ]
}

Source content:
${content}`;

  try {
    const r = await generateText({
      model: together(model),
      providerOptions,
      prompt,
    });
    const parsed = parseJSON(r.text);
    const validated = assignmentSchema.safeParse(parsed);
    if (!validated.success) return moduleTitles.map(() => null);

    const out: (string | null)[] = moduleTitles.map(() => null);
    const seen = new Set<string>();
    for (const a of validated.data.assignments) {
      if (a.moduleIndex < 0 || a.moduleIndex >= moduleTitles.length) continue;
      const p = a.process?.trim();
      if (!p) continue;
      // De-dupe in case the model returned the same name twice despite instructions.
      const key = p.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out[a.moduleIndex] = p;
    }
    return out;
  } catch {
    return moduleTitles.map(() => null);
  }
}
