export type KnowledgeEngineGroup = "local" | "server";

const SERVER_ENGINE_IDS = new Set(["lightrag-server"]);
const LOCAL_ENGINE_IDS = new Set([
  "llamaindex",
  "pageindex-oss",
  "graphrag",
  "lightrag",
]);

/**
 * Keep the Knowledge Center grouping stable for the built-in engines while
 * still giving future providers a sensible home.
 */
export function knowledgeEngineGroup(provider: {
  id: string;
  requires_api_key?: boolean;
}): KnowledgeEngineGroup {
  if (SERVER_ENGINE_IDS.has(provider.id)) return "server";
  if (LOCAL_ENGINE_IDS.has(provider.id)) return "local";
  return "local";
}
