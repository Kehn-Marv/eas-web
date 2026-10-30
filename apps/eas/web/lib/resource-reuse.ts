export const RESOURCE_KINDS = [
  "attachments",
  "books",
  "reading",
  "notebooks",
  "chat_history",
  "question_bank",
  "knowledge",
  "persona",
  "agent",
  "skills",
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export type ResourceReuse = Record<ResourceKind, boolean>;
export const DEFAULT_RESOURCE_REUSE: ResourceReuse = {
  attachments: false,
  books: false,
  reading: false,
  notebooks: false,
  chat_history: false,
  question_bank: false,
  knowledge: true,
  persona: true,
  agent: true,
  skills: true,
};
export function retainedKnowledgeBases(
  names: string[],
  agents: Set<string>,
  reuse: ResourceReuse,
) {
  return names.filter(
    (name) => reuse[agents.has(name) ? "agent" : "knowledge"],
  );
}
