/** Provider presentation only. IDs, protocols and saved account names stay intact.
 * Asset provenance is recorded in public/provider-icons/sources.json. */
export type ProviderIconSpec = { file: string; mono?: boolean; darkFile?: string };
export const PROVIDER_ICONS: Readonly<Record<string, ProviderIconSpec>> = {
  aihubmix: { file: "aihubmix-color.svg" },
  aliyun: { file: "bailian-color.svg" },
  aliyun_iqs: { file: "alibabacloud-color.svg" },
  anthropic: { file: "anthropic.svg", mono: true },
  api_route: { file: "api-route.png" },
  atlascloud: { file: "atlascloud.svg", mono: true },
  azure_openai: { file: "azure-color.svg" },
  baidu: { file: "baidu-color.svg" },
  bocha: { file: "bocha-color.svg" },
  brave: { file: "brave.svg" },
  byteplus: { file: "byteplus.png" },
  byteplus_coding_plan: { file: "byteplus.png" },
  cheaperinference: { file: "cheaperinference.svg" },
  codebuddy: { file: "codebuddy-official.svg" },
  cohere: { file: "cohere-color.svg" },
  dashscope: { file: "bailian-color.svg" },
  deepseek: { file: "deepseek-color.svg" },
  doubao: { file: "doubao.png" },
  duckduckgo: { file: "duckduckgo.svg" },
  edenai: { file: "edenai.png", darkFile: "edenai-dark.png" },
  exa: { file: "exa-color.svg" },
  firecrawl: { file: "firecrawl-color.svg" },
  futureinfra: { file: "futureinfra.svg" },
  gemini: { file: "gemini-color.svg" },
  google: { file: "gemini-color.svg" },
  groq: { file: "groq.svg", mono: true },
  jina: { file: "jina.svg", mono: true },
  lemonade: { file: "lemonade.ico" },
  llama_cpp: { file: "llama-cpp.svg", darkFile: "llama-cpp-dark.svg" },
  lm_studio: { file: "lmstudio.svg", mono: true },
  minimax: { file: "minimax-color.svg" },
  minimax_anthropic: { file: "minimax-color.svg" },
  mistral: { file: "mistral-color.svg" },
  moonshot: { file: "moonshot.svg", mono: true },
  novita: { file: "novita-official.svg", mono: true },
  nvidia_nim: { file: "nvidia-color.svg" },
  opper: { file: "opper.png", darkFile: "opper-dark.png" },
  ollama: { file: "ollama.svg", mono: true },
  openai: { file: "openai.svg", mono: true },
  openai_codex: { file: "openai.svg", mono: true },
  openrouter: { file: "openrouter.svg", mono: true },
  orcarouter: { file: "orcarouter.png" },
  ovms: { file: "openvino.ico" },
  perplexity: { file: "perplexity-color.svg" },
  qianfan: { file: "baiducloud-color.svg" },
  requesty: { file: "requesty.png" },
  searxng: { file: "searxng.svg" },
  serper: { file: "serper.png" },
  serply: { file: "serply.png" },
  siliconflow: { file: "siliconcloud-color.svg" },
  stepfun: { file: "stepfun-color.svg" },
  tavily: { file: "tavily-color.svg" },
  unifically: { file: "unifically.webp" },
  vllm: { file: "vllm-color.svg" },
  volcengine: { file: "volcengine-color.svg" },
  volcengine_coding_plan: { file: "volcengine-color.svg" },
  volcengine_speech: { file: "volcengine-color.svg" },
  xiaomi_mimo: { file: "xiaomimimo.svg", mono: true },
  zhipu: { file: "zhipu-color.svg" },
};

const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  "y-api": "y_api",
  "yapi": "y_api",
  "azure": "azure_openai",
  "azure-openai": "azure_openai",
  "azureopenai": "azure_openai",
  "google_genai": "gemini",
  "claude": "anthropic",
  "openai-codex": "openai_codex",
  "codebuddy-code": "codebuddy",
  "codebuddy_code": "codebuddy",
  "workbuddy": "codebuddy",
  "lm-studio": "lm_studio",
  "atlas": "atlascloud",
  "atlas_cloud": "atlascloud",
  "atlas-cloud": "atlascloud",
  "eden_ai": "edenai",
  "novita_ai": "novita",
  "orca_router": "orcarouter",
  "orca-router": "orcarouter",
  "cheaper_inference": "cheaperinference",
  "api route": "api_route",
  "future_infra": "futureinfra",
  "volcenginecodingplan": "volcengine_coding_plan",
  "bytepluscodingplan": "byteplus_coding_plan"
};

export function canonicalProviderBrand(provider?: string | null): string {
  const key = provider?.trim().toLowerCase() ?? "";
  return Object.hasOwn(PROVIDER_ALIASES, key) ? PROVIDER_ALIASES[key] : key;
}

export function providerIconSpec(provider?: string | null): ProviderIconSpec | undefined {
  const key = canonicalProviderBrand(provider);
  return Object.hasOwn(PROVIDER_ICONS, key) ? PROVIDER_ICONS[key] : undefined;
}

/** Provider labels follow the app's English-only interface. */
export function formatProviderLabel(_provider: string, label: string): string {
  return label;
}

/** Keep provider account names as entered by the user. */
export function formatConfiguredProviderName(_provider: string, name: string): string {
  return name;
}
