import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createTogetherAI } from "@ai-sdk/togetherai";

interface JudgeModelOptions {
  judgeModel: string;
  togetherApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  ollamaBaseUrl?: string;
}

export function getJudgeModel({
  judgeModel,
  togetherApiKey,
  anthropicApiKey,
  openrouterApiKey,
  ollamaBaseUrl,
}: JudgeModelOptions) {
  if (judgeModel.startsWith("anthropic/")) {
    const modelId = judgeModel.replace("anthropic/", "");
    if (anthropicApiKey) {
      return createAnthropic({ apiKey: anthropicApiKey })(modelId);
    }
    if (openrouterApiKey) {
      return createOpenAI({
        apiKey: openrouterApiKey,
        baseURL: "https://openrouter.ai/api/v1",
      })(judgeModel);
    }
    throw new Error(
      "anthropic/ judge requires ANTHROPIC_API_KEY or OPENROUTER_API_KEY"
    );
  }

  if (judgeModel.startsWith("openrouter/")) {
    if (!openrouterApiKey) {
      throw new Error("openrouter/ judge requires OPENROUTER_API_KEY");
    }
    const modelId = judgeModel.replace("openrouter/", "");
    return createOpenAI({
      apiKey: openrouterApiKey,
      baseURL: "https://openrouter.ai/api/v1",
    })(modelId);
  }

  if (judgeModel.startsWith("ollama/")) {
    const modelId = judgeModel.replace("ollama/", "");
    const baseURL = `${(ollamaBaseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/v1`;
    return createOpenAI({
      apiKey: "ollama",
      baseURL,
    })(modelId);
  }

  if (!togetherApiKey) {
    throw new Error("Together judge requires TOGETHER_API_KEY");
  }

  return createTogetherAI({ apiKey: togetherApiKey })(judgeModel);
}
