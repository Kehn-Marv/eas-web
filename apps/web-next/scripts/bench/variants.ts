/**
 * Model variants for the speed-bench harness.
 *
 * The harness swaps the generation model on the production pipeline
 * (lib/pipeline). Add new candidates here, then run
 * `bun scripts/bench/speed-bench.ts --variants=<id1>,<id2>`.
 *
 * Model IDs come from the Together AI serverless catalog:
 *   curl https://api.together.xyz/v1/models?serverless=true
 */

export interface Variant {
  id: string;
  label: string;
  /** Together AI model id. Undefined = use DEFAULT_MODEL. */
  model?: string;
}

/**
 * Model shootout — same production pipeline, swap only the model. Exposes the
 * Pareto curve of model speed vs lesson quality.
 *
 * Production currently uses `openai/gpt-oss-120b` after winning the original
 * shootout (9.2× faster than the prior MiniMax-M2.7 baseline; equal or better
 * quality across all five eval dimensions). Re-run the shootout when new
 * serverless models land in Together's catalog.
 */
export const VARIANTS: Variant[] = [
  // Production (always first — harness uses index 0 as the speedup denominator).
  { id: "gpt-oss-120b",        label: "gpt-oss-120b (production)",   model: "openai/gpt-oss-120b" },

  // Previously production
  { id: "minimax-m2.7",        label: "MiniMax-M2.7",                model: "MiniMaxAI/MiniMax-M2.7" },

  // Cheap & fast tier
  { id: "gpt-oss-20b",         label: "gpt-oss-20b",                 model: "openai/gpt-oss-20b" },
  { id: "qwen3.5-9b",          label: "Qwen3.5-9B",                  model: "Qwen/Qwen3.5-9B" },
  { id: "gemma-4-31b",         label: "gemma-4-31B-it",              model: "google/gemma-4-31B-it" },

  // Throughput-optimized MoE / Turbo tier
  { id: "qwen3-235b-tput",     label: "Qwen3-235B-tput",             model: "Qwen/Qwen3-235B-A22B-Instruct-2507-tput" },
  { id: "llama-3.3-70b-turbo", label: "Llama-3.3-70B-Turbo",         model: "meta-llama/Llama-3.3-70B-Instruct-Turbo" },
  { id: "qwen3.6-plus",        label: "Qwen3.6-Plus",                model: "Qwen/Qwen3.6-Plus" },

  // Reasoning / larger models
  { id: "qwen3.5-397b",        label: "Qwen3.5-397B-A17B",           model: "Qwen/Qwen3.5-397B-A17B" },
  { id: "kimi-k2.5",           label: "Kimi-K2.5",                   model: "moonshotai/Kimi-K2.5" },
  { id: "kimi-k2.6",           label: "Kimi-K2.6",                   model: "moonshotai/Kimi-K2.6" },
  { id: "glm-5",               label: "GLM-5",                       model: "zai-org/GLM-5" },
  { id: "glm-5.1",             label: "GLM-5.1",                     model: "zai-org/GLM-5.1" },
  { id: "cogito-v2-671b",      label: "Cogito v2 671B",              model: "deepcogito/cogito-v2-1-671b" },

  // Frontier tier (expensive, ceiling reference)
  { id: "deepseek-v4-pro",     label: "DeepSeek-V4-Pro",             model: "deepseek-ai/DeepSeek-V4-Pro" },
];
