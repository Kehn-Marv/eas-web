"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const loading = () => <div className="min-h-40 animate-pulse rounded-xl bg-[var(--muted)]/30" aria-busy="true" />;
const Providers = dynamic(() => import("@/components/settings/ProvidersWorkspace").then((module) => module.ProvidersWorkspace), { loading });
const LanguageModels = dynamic(() => import("@/features/settings/sections/models/LlmSettingsSection"), { loading });
const TaskModels = dynamic(() => import("@/features/settings/sections/models/TaskSettingsSection"), { loading });
const Embeddings = dynamic(() => import("@/features/settings/sections/models/EmbeddingSettingsSection"), { loading });
const SearchModels = dynamic(() => import("@/features/settings/sections/models/SearchSettingsSection"), { loading });
const VoiceModels = dynamic(() => import("@/features/settings/sections/models/VoiceSettingsSection"), { loading });
const MultimodalModels = dynamic(() => import("@/features/settings/sections/models/MultimodalSettingsSection"), { loading });

const TABS = [
  { key: "providers", label: "Providers", Component: Providers },
  { key: "language", label: "Language", Component: LanguageModels },
  { key: "tasks", label: "Tasks", Component: TaskModels },
  { key: "embeddings", label: "Embeddings", Component: Embeddings },
  { key: "search", label: "Search", Component: SearchModels },
  { key: "voice", label: "Voice", Component: VoiceModels },
  { key: "multimodal", label: "Multimodal", Component: MultimodalModels },
] as const;

type ProviderTab = (typeof TABS)[number]["key"];

function isProviderTab(value: string | null): value is ProviderTab {
  return TABS.some((tab) => tab.key === value);
}

export default function ProviderSettingsWorkspace({ initialTab = "providers" }: { initialTab?: string }) {
  const router = useRouter();
  const [selected, setSelected] = useState<ProviderTab>(isProviderTab(initialTab) ? initialTab : "providers");

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (isProviderTab(tab)) setSelected(tab);
    else {
      setSelected(isProviderTab(initialTab) ? initialTab : "providers");
      if (tab) {
        const params = new URLSearchParams(window.location.search);
        params.delete("tab");
        const query = params.toString();
        router.replace(`/settings/providers${query ? `?${query}` : ""}`, { scroll: false });
      }
    }
  }, [initialTab, router]);

  const active = TABS.find((tab) => tab.key === selected) ?? TABS[0];
  const ActiveSection = active.Component;

  const selectTab = (tab: ProviderTab) => {
    setSelected(tab);
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tab);
    router.replace(`/settings/providers?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="space-y-6" data-provider-settings>
      <nav aria-label="Provider settings" role="tablist" className="-mx-1 flex gap-1 overflow-x-auto border-b border-[var(--border)] px-1">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            id={`provider-tab-${tab.key}`}
            aria-selected={selected === tab.key}
            aria-controls="provider-tab-panel"
            onClick={() => selectTab(tab.key)}
            className={`shrink-0 border-b-2 px-3 py-3 text-[13px] font-medium transition-colors ${selected === tab.key ? "border-[var(--foreground)] text-[var(--foreground)]" : "border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"}`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <section id="provider-tab-panel" role="tabpanel" aria-labelledby={`provider-tab-${selected}`}>
        <ActiveSection />
      </section>
    </div>
  );
}
