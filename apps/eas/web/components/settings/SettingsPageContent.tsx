"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/features/settings/store/SettingsStore";
import { useSettingsAccess } from "@/features/settings/navigation/SettingsAccessProvider";
import { resolveSettingsKey, settingsAnchorHref } from "@/features/settings/navigation/settings-nav";
import { visibleSettingsPages } from "@/features/settings/navigation/settings-pages";

const loading = () => <div className="min-h-48 animate-pulse rounded-xl bg-[var(--muted)]/30" aria-busy="true" />;
const Appearance = dynamic(() => import("@/features/settings/sections/AppearanceSettingsSection"), { loading });
const Knowledge = dynamic(() => import("@/features/settings/sections/DocumentParsingSettingsSection"), { loading });
const Learner = dynamic(() => import("@/features/settings/sections/LearnerProfileSettingsSection"), { loading });
const Tools = dynamic(() => import("@/features/settings/sections/ToolsSettingsSection"), { loading });
const Providers = dynamic(() => import("./ProviderSettingsWorkspace"), { loading });
const Archive = dynamic(() => import("@/features/settings/sections/ArchivedChatsSettingsSection"), { loading });

const PAGES: Record<string, React.ComponentType> = {
  appearance: Appearance,
  knowledge: Knowledge,
  "learner-profile": Learner,
  tools: Tools,
  archive: Archive,
};

const LEGACY_PROVIDER_TABS: Record<string, string> = {
  connections: "providers",
  llm: "language",
  "task-models": "tasks",
  task: "tasks",
  embedding: "embeddings",
  search: "search",
  voice: "voice",
  tts: "voice",
  stt: "voice",
  multimodal: "multimodal",
  imagegen: "multimodal",
  videogen: "multimodal",
};

export default function SettingsPageContent({ section }: { section: string }) {
  const { t } = useTranslation();
  const router = useRouter();
  const access = useSettingsAccess();
  const { settingsLoading, saving, applying } = useSettings();
  const key = resolveSettingsKey(section);
  const pages = visibleSettingsPages(access);
  const page = pages.find((item) => item.key === key);

  useEffect(() => {
    if (!access.resolved) return;
    if (!page) {
      router.replace("/settings/appearance", { scroll: false });
      return;
    }
    if (key !== section) {
      const target = new URL(settingsAnchorHref(section), window.location.origin);
      const current = new URLSearchParams(window.location.search);
      current.forEach((value, name) => {
        if (!target.searchParams.has(name)) target.searchParams.set(name, value);
      });
      router.replace(`${target.pathname}${target.search}`, { scroll: false });
    }
  }, [access.resolved, key, page, router, section]);

  if (!access.resolved || settingsLoading) return loading();
  if (!page)
    return (
      <div className="min-h-48 animate-pulse rounded-xl bg-[var(--muted)]/30" aria-busy="true" />
    );

  const Component = PAGES[key];
  const legacyTab = LEGACY_PROVIDER_TABS[section];
  return (
    <fieldset disabled={saving || applying} aria-busy={saving || applying} className="min-w-0" data-settings-page={key}>
      {key === "providers" ? <Providers initialTab={legacyTab} /> : Component ? <Component /> : null}
    </fieldset>
  );
}
