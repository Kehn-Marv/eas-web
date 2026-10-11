import { generateText } from "ai";
import type { CourseStructure, ModuleWithLessons } from "./types";
import { courseStructureSchema } from "./schemas";
import {
  createTogetherClient,
  DEFAULT_MODEL,
  getTogetherProviderOptions,
} from "./utils/together";
import { parseJSON } from "./utils/json";

export interface CourseProgressCallback {
  (type: string, message: string, data?: any): void;
}

export interface CreateModulesInput {
  content: string;
  apiKey: string;
  model?: string;
  maxRetries?: number;
  onProgress?: CourseProgressCallback;
}

export interface CreateCourseInput {
  content: string;
  apiKey: string;
  model?: string;
  /** Retained for backward compatibility — see note on createCourse below. */
  validateStructure?: boolean;
  /** Retained for backward compatibility — see note on createCourse below. */
  validateContent?: boolean;
  /** Retained for backward compatibility — see note on createCourse below. */
  retryFailures?: boolean;
  /** Retained for backward compatibility — see note on createCourse below. */
  maxRetries?: number;
  onProgress?: CourseProgressCallback;
}

export interface CourseOutput {
  title: string;
  modules: ModuleWithLessons[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * Generate only the course structure (3 module titles, no lessons).
 * Used by the CLI's `course modules` subcommand.
 */
export async function createModules({
  content,
  apiKey,
  model = DEFAULT_MODEL,
  maxRetries = 3,
  onProgress,
}: CreateModulesInput): Promise<CourseStructure> {
  onProgress?.("modules-start", "Generating course structure...");
  const together = createTogetherClient(apiKey);
  const providerOptions = getTogetherProviderOptions(model);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await generateText({
        model: together(model),
        providerOptions,
        prompt: `Analyse the following content and create a course structure with 3 modules.
Respond ONLY with JSON. No other text.

{
  "title": "Course Title",
  "modules": [
    {"title": "Module 1 Title"},
    {"title": "Module 2 Title"},
    {"title": "Module 3 Title"}
  ]
}

Content:
${content}`,
      });

      const parsed = parseJSON(result.text);
      const validated = courseStructureSchema.safeParse(parsed);
      if (!validated.success) {
        throw new Error(
          `Invalid course structure: ${validated.error.issues.map((i) => i.message).join(", ")}`
        );
      }

      const modules = validated.data.modules;
      onProgress?.("modules-complete", `Generated ${modules.length} modules`, {
        moduleCount: modules.length,
      });
      return {
        course: {
          title: validated.data.title,
          module: modules,
        },
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        onProgress?.(
          "modules-retry",
          `Course structure generation failed, retrying (${attempt}/${maxRetries})...`,
          { attempt, maxRetries, error: lastError.message }
        );
      }
    }
  }
  throw new Error(
    `Failed to generate course structure after ${maxRetries} attempts.\nLast error: ${lastError?.message}`
  );
}

/**
 * Generate a complete course with modules and lessons.
 *
 * Pipeline (benchmarks in docs/course-generation-speedup.md):
 *   1. createModules — one LLM call for the 3 module titles.
 *   2. assignFlowsToModules — one LLM call picks 3 distinct processes from the
 *      source, one per module. Eliminates flow-diagram dupes by construction.
 *   3. All 3 modules generated in PARALLEL: standard lessons + a combined-flow
 *      lesson (one call, not two) per module.
 *   4. dedupRepair — Jaccard-similarity detection + serial regeneration of any
 *      remaining duplicate questions.
 *
 * ~9× faster than the previous sequential pipeline on M2.7, with equal or
 * better lesson quality across structural / correctness / grounding /
 * sufficiency / duplicates on 6 PDFs × 5 iterations.
 *
 * The validateStructure / validateContent / retryFailures / maxRetries options
 * are retained for backward compatibility but no longer routed — validation
 * and retries are handled inside the pipeline (Zod structure validation,
 * transient-error backoff, dedup repair). The LLM-as-judge per-lesson
 * content validator was removed because it was ~25% of total latency and
 * the new model + grounding-aware prompts produce equal or better quality
 * without it.
 */
export async function createCourse({
  content,
  apiKey,
  model = DEFAULT_MODEL,
  onProgress,
}: CreateCourseInput): Promise<CourseOutput> {
  const { generateCourse } = await import("./pipeline");
  return generateCourse({
    content,
    apiKey,
    model,
    onProgress,
  });
}
