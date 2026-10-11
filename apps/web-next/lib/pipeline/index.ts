/**
 * The production course-generation pipeline.
 *
 * Pipeline (parallel-distinct-flow):
 *   1. generateModuleStructure — one LLM call for the 3 module titles.
 *   2. assignFlowsToModules    — one LLM call picks 3 distinct processes from
 *                                the source, one per module. Eliminates
 *                                cross-module flow-diagram dupes by construction.
 *   3. createLessons × 3       — three modules generated in PARALLEL: standard
 *                                lessons + a combined-flow lesson per module.
 *   4. dedupRepair             — Jaccard-similarity detection + serial
 *                                regeneration of any remaining duplicates.
 *
 * Benchmarks in docs/course-generation-speedup.md.
 */
import { generateText } from "ai";
import type { CourseOutput, CourseProgressCallback } from "../create-course";
import { createLessons } from "../create-lesson";
import {
  createTogetherClient,
  DEFAULT_MODEL,
  getTogetherProviderOptions,
} from "../utils/together";
import { courseStructureSchema } from "../schemas";
import { parseJSON } from "../utils/json";
import type { CourseStructure } from "../types";

export interface PipelineInput {
  content: string;
  apiKey: string;
  model?: string;
  onProgress?: CourseProgressCallback;
}

async function generateModuleStructure(input: PipelineInput): Promise<CourseStructure> {
  const together = createTogetherClient(input.apiKey);
  const model = input.model ?? DEFAULT_MODEL;
  const providerOptions = getTogetherProviderOptions(model);

  const maxAttempts = 3;
  let lastErr = "";
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await generateText({
        model: together(model),
        providerOptions,
        prompt: `Analyse the following content and create a course structure with 3 modules.
Respond ONLY with JSON. No other text.

{"title":"Course Title","modules":[{"title":"M1"},{"title":"M2"},{"title":"M3"}]}

Content:
${input.content}`,
      });
      const parsed = parseJSON(r.text);
      const validated = courseStructureSchema.safeParse(parsed);
      if (!validated.success) {
        lastErr = validated.error.issues.map((i) => i.message).join(", ");
        continue;
      }
      return {
        course: {
          title: validated.data.title,
          module: validated.data.modules,
        },
      };
    } catch (e: any) {
      lastErr = e.message ?? String(e);
    }
  }
  throw new Error(`Module structure failed: ${lastErr}`);
}

export async function generateCourse(input: PipelineInput): Promise<CourseOutput> {
  const { onProgress } = input;
  onProgress?.("modules-start", "Generating course structure...");
  const structure = await generateModuleStructure(input);
  const allModuleTitles = structure.course.module.map((m) => m.title);
  onProgress?.("modules-complete", `Generated ${allModuleTitles.length} modules`, {
    moduleCount: allModuleTitles.length,
  });

  const { assignFlowsToModules } = await import("./assign-flows");
  const assignments = await assignFlowsToModules({
    moduleTitles: allModuleTitles,
    content: input.content,
    apiKey: input.apiKey,
    model: input.model,
  });

  onProgress?.("lessons-start", `Generating lessons for ${allModuleTitles.length} modules...`, {
    totalModules: allModuleTitles.length,
  });

  let completedModules = 0;
  const totalModules = structure.course.module.length;
  const moduleResults = await Promise.all(
    structure.course.module.map((mod, i) =>
      createLessons({
        module: mod,
        content: input.content,
        apiKey: input.apiKey,
        model: input.model,
        validateStructure: true,
        validateContent: false,
        retryFailures: true,
        maxRetries: 3,
        previousQuestions: [],
        allModuleTitles,
        flowStrategy: "combined",
        flowFocus: assignments[i],
        onProgress: (type) => {
          if (type === "lesson-complete") {
            completedModules++;
            onProgress?.(
              "lessons-progress",
              `Generating lessons (${completedModules}/${totalModules} modules)`,
              {
                completed: completedModules,
                total: totalModules,
                currentModule: i + 1,
                moduleTitle: mod.title,
              }
            );
          }
        },
      })
    )
  );

  const course: CourseOutput = {
    title: structure.course.title,
    modules: moduleResults,
  };

  // Dedup pass catches any standard-lesson collisions. Flow-diagram collisions
  // should be zero by construction (distinct assignments above).
  const { dedupRepair } = await import("./dedup-repair");
  await dedupRepair(course, input.content, input.apiKey, input.model);

  let totalLessons = 0;
  let successfulLessons = 0;
  for (const m of course.modules) {
    for (const l of m.lessons) {
      totalLessons++;
      if (l.success) successfulLessons++;
    }
  }
  onProgress?.(
    "course-complete",
    `Course generation complete: ${successfulLessons}/${totalLessons} lessons successful`,
    {
      totalModules,
      totalLessons,
      successfulLessons,
      failedLessons: totalLessons - successfulLessons,
      successRate: totalLessons > 0 ? Math.round((successfulLessons / totalLessons) * 100) : 0,
    }
  );

  return course;
}
