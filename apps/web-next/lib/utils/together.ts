import { createTogetherAI } from "@ai-sdk/togetherai";

/**
 * Optional global usage tracker. When set, every LanguageModel.doGenerate call
 * appends its usage stats. Used by scripts/measure-cost.ts. Production calls
 * leave this untouched.
 */
export const __usageTracker: {
  onCall: ((u: { inputTokens: number; outputTokens: number; durationMs: number }) => void) | null;
} = { onCall: null };

/**
 * Create a Together AI client with the provided API key
 */
export function createTogetherClient(apiKey: string) {
  const inner = createTogetherAI({ apiKey });
  return (modelId: string) => {
    const model = inner(modelId);
    if (!__usageTracker.onCall) return model;
    return new Proxy(model as any, {
      get(target, prop) {
        const v = target[prop];
        if (prop === "doGenerate" && typeof v === "function") {
          return async (opts: any) => {
            const start = Date.now();
            const r = await v.call(target, opts);
            __usageTracker.onCall?.({
              inputTokens: r?.usage?.inputTokens ?? 0,
              outputTokens: r?.usage?.outputTokens ?? 0,
              durationMs: Date.now() - start,
            });
            return r;
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
}

export function getTogetherProviderOptions(model: string) {
  if (
    model === "moonshotai/Kimi-K2.5" ||
    model === "moonshotai/Kimi-K2.6" ||
    model === "deepseek-ai/DeepSeek-V4-Pro" ||
    model === "Qwen/Qwen3.5-397B-A17B"
  ) {
    return {
      togetherai: {
        reasoning: { enabled: false },
      },
    };
  }

  return undefined;
}

/**
 * Default model for course and lesson generation.
 *
 * Switched from MiniMax-M2.7 to gpt-oss-120b after a model shootout across
 * 15 serverless Together AI models — gpt-oss-120b was 9× faster with equal or
 * better lesson quality on the same input. See docs/course-generation-speedup.md.
 */
export const DEFAULT_MODEL = "openai/gpt-oss-120b";

/**
 * Model used for grading short-answer responses
 */
export const GRADER_MODEL = "openai/gpt-oss-20b";

/**
 * Single source of truth for model configuration
 * Pricing is per 1M tokens (input, output in USD)
 */
export const MODEL_CONFIG = {
  "minimax-m2.7": {
    fullName: "MiniMaxAI/MiniMax-M2.7",
    pricing: { input: 0.30, output: 1.20 },
  },
  "gpt-oss-20b": {
    fullName: "openai/gpt-oss-20b",
    pricing: { input: 0.05, output: 0.20 },
  },
  "gpt-oss-120b": {
    fullName: "openai/gpt-oss-120b",
    pricing: { input: 0.15, output: 0.60 },
  },
  "deepseek-3.1": {
    fullName: "deepseek-ai/DeepSeek-V3.1",
    pricing: { input: 0.60, output: 1.70 },
  },
} as const;

export type ModelAlias = keyof typeof MODEL_CONFIG;

/**
 * Available models for course generation (derived from MODEL_CONFIG)
 */
export const AVAILABLE_MODELS = Object.fromEntries(
  Object.entries(MODEL_CONFIG).map(([alias, config]) => [alias, config.fullName])
) as Record<ModelAlias, string>;

/**
 * Get pricing for a model by alias or full name
 * @returns Pricing object or undefined if not found
 */
export function getModelPricing(model: string): { input: number; output: number } | undefined {
  // Check if it's an alias
  if (model in MODEL_CONFIG) {
    return MODEL_CONFIG[model as ModelAlias].pricing;
  }
  // Check if it's a full name
  const entry = Object.values(MODEL_CONFIG).find((c) => c.fullName === model);
  return entry?.pricing;
}
