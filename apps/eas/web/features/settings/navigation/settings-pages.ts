import type { LucideIcon } from "lucide-react";
import {
  SETTINGS_CATEGORIES,
  isSettingsCategoryVisible,
  isSettingsLeafVisible,
  resolveSettingsKey,
  settingsAnchorHref,
  type Lang,
  type SettingsLeaf,
} from "./settings-nav";
import type { SettingsAccess } from "./settings-access";

export const SETTINGS_PAGE_GROUPS: { label: Lang; keys: string[] }[] = [
  { label: { en: "Personal" }, keys: ["appearance"] },
  { label: { en: "Models & services" }, keys: ["providers"] },
  { label: { en: "Learning" }, keys: ["tools", "knowledge", "learner-profile"] },
  { label: { en: "Archived" }, keys: ["archive"] },
];

export function isWideSettingsPage(key: string): boolean {
  return ["providers", "tools", "knowledge"].includes(resolveSettingsKey(key));
}

export const SETTINGS_PAGE_FAMILIES: string[][] = [["providers"]];

export function settingsPageFamily(key: string): string[] {
  return SETTINGS_PAGE_FAMILIES.find((family) => family.includes(resolveSettingsKey(key))) ?? [resolveSettingsKey(key)];
}

export function visibleSettingsPages(access: SettingsAccess): SettingsLeaf[] {
  return [
    ...SETTINGS_CATEGORIES
      .filter((category) => isSettingsCategoryVisible(category, access))
      .flatMap((category) => category.children ?? [category])
      .filter((leaf) => isSettingsLeafVisible(leaf, access)),
  ];
}

export function settingsPageLabel(_key: string, fallback: Lang): Lang {
  return fallback;
}

export function settingsPageIcon(_key: string, fallback: LucideIcon): LucideIcon {
  return fallback;
}

export function legacySettingsDestination(hash: string, search: string): string {
  const [rawKey, hashQuery = ""] = hash.replace(/^#/, "").split("?");
  let legacyKey = "appearance";
  try {
    legacyKey = decodeURIComponent(rawKey || "appearance");
  } catch {
    return "/settings/appearance";
  }
  const key = resolveSettingsKey(legacyKey);
  const visible = new Set(visibleSettingsPages({
    resolved: true,
    hideAdminOnly: false,
    showLearnerOnly: true,
    showGuardianOnly: true,
  }).map((item) => item.key));
  const destination = visible.has(key) ? settingsAnchorHref(legacyKey) : "/settings/appearance";
  const [path, destinationQuery = ""] = destination.split("?");
  const query = new URLSearchParams(destinationQuery);
  new URLSearchParams(search).forEach((value, name) => query.set(name, value));
  new URLSearchParams(hashQuery).forEach((value, name) => query.set(name, value));
  return `${path}${query.size ? `?${query.toString()}` : ""}`;
}

export function settingsPageExists(key: string, access: SettingsAccess): boolean {
  return visibleSettingsPages(access).some((page) => page.key === resolveSettingsKey(key));
}

