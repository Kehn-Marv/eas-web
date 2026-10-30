import {
  Archive,
  BookOpen,
  Brain,
  KeyRound,
  Palette,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { ServiceName } from "@/features/settings/store/SettingsStore";
import type { SettingsAccess } from "./settings-access";

export type Lang = { en: string };

export interface SettingsLeaf {
  key: string;
  href: string;
  label: Lang;
  blurb: Lang;
  icon: LucideIcon;
  tile: string;
  service?: ServiceName;
  adminOnly?: boolean;
}

export interface SettingsCategory extends SettingsLeaf {
  children?: SettingsLeaf[];
  learnerOnly?: boolean;
  guardianOnly?: boolean;
}

export function isSettingsLeafVisible(leaf: SettingsLeaf, access: SettingsAccess): boolean {
  return !(leaf.adminOnly && access.hideAdminOnly);
}

export function isSettingsCategoryVisible(category: SettingsCategory, access: SettingsAccess): boolean {
  if (category.learnerOnly && !access.showLearnerOnly) return false;
  if (category.guardianOnly && !access.showGuardianOnly) return false;
  return !category.children || category.children.some((leaf) => isSettingsLeafVisible(leaf, access));
}

export function visibleSettingsChildren(categoryKey: string, access: SettingsAccess): SettingsLeaf[] {
  return (SETTINGS_CATEGORIES.find((category) => category.key === categoryKey)?.children ?? [])
    .filter((leaf) => isSettingsLeafVisible(leaf, access));
}

const page = (key: string, label: string, blurb: string, icon: LucideIcon, href = `/settings/${key}`): SettingsCategory => ({
  key,
  href,
  label: { en: label },
  blurb: { en: blurb },
  icon,
  tile: "",
});

export const SETTINGS_CATEGORIES: SettingsCategory[] = [
  page("appearance", "Appearance", "Choose how the app looks.", Palette),
  page("providers", "Providers", "Connect models and services used by the app.", KeyRound),
  page("tools", "Tools", "Choose which optional tools are available in chat.", Wrench),
  page("knowledge", "Knowledge & documents", "Choose how documents are read and searched.", BookOpen),
  {
    ...page("learner-profile", "Learning profile", "Adjust learning preferences.", Brain),
    learnerOnly: true,
  },
  page("archive", "Archived chats", "Search, unarchive, or permanently delete archived conversations.", Archive),
];

export const SETTINGS_HUB_HREF = "/settings";

/** Old model-service links now open the matching tab in the Providers workspace. */
const PROVIDER_TABS: Record<string, string> = {
  connections: "providers",
  llm: "language",
  "task-models": "tasks",
  task: "tasks",
  embedding: "embeddings",
  reranker: "embeddings",
  search: "search",
  voice: "voice",
  tts: "voice",
  stt: "voice",
  multimodal: "multimodal",
  imagegen: "multimodal",
  videogen: "multimodal",
};

export const SETTINGS_ALIASES: Record<string, string> = {
  overview: "appearance",
  models: "providers",
  "task-models": "providers",
  "document-parsing": "knowledge",
  "archived-chats": "archive",
  archived: "archive",
  ...Object.fromEntries(Object.keys(PROVIDER_TABS).map((key) => [key, "providers"])),
};

export function resolveSettingsKey(key: string): string {
  return SETTINGS_ALIASES[key] ?? key;
}

export function settingsAnchorHref(key: string): string {
  const providerTab = PROVIDER_TABS[key];
  if (providerTab) return `/settings/providers?tab=${providerTab}`;
  const resolved = resolveSettingsKey(key);
  return `${SETTINGS_HUB_HREF}/${resolved}`;
}

