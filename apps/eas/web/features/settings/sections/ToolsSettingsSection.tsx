"use client";

import Tooltip from "@/shared/ui/Tooltip";
import { useStagedSettings } from "@/features/settings/store/useStagedSettings";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Loader2, Lock, Search, Wrench, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useSettings } from "@/features/settings/store/SettingsStore";
import { SettingsPageHeader } from "@/components/settings/shared";
import { apiFetch, apiUrl } from "@/lib/api";
import {
  toolAvailabilityCopy,
  toolEffectiveEnabled,
} from "@/lib/tool-availability";
import { Toggle } from "@/components/settings/Toggle";

type ToolHints = {
  short_description: string;
  when_to_use: string;
  input_format: string;
  guideline: string;
  note: string;
  phase: string;
  aliases: { name: string; description: string; phase: string }[];
};

type BuiltinTool = {
  name: string;
  description: string;
  hints: Partial<Record<string, ToolHints>> & { en: ToolHints };
  aliases: string[];
  toggleable: boolean;
  enabled: boolean;
  // ``coming_soon`` tools are listed for visibility but the chat agent
  // cannot invoke them. The settings UI surfaces them with a locked-off
  // toggle and a "Coming soon" badge.
  coming_soon?: boolean;
  // The capability that owns this tool (e.g. "solve" / "mastery"), or null
  // for a plain system built-in. Owned tools render in their own section
  // below the built-in tools.
  capability?: string | null;
  // Runtime readiness is independent of the saved composer preference.
  available?: boolean;
  unavailable_reason?: string | null;
};

type ToolsResponse = {
  tools: Array<BuiltinTool & { parameters?: unknown }>;
  enabled_optional_tools: string[];
};

type ToolSection = {
  key: string;
  label: string;
  hint: string;
  tools: BuiltinTool[];
};

const VISIBLE_TOGGLEABLE_TOOLS = new Set([
  "brainstorm",
  "web_search",
  "paper_search",
  "reason",
  "geogebra_analysis",
  "imagegen",
  "videogen",
]);

export default function ToolsSettingsPage() {
  const { t } = useTranslation();
  const { draftRevision } = useSettings();
  const hintLanguage = "en";
  const [tools, setTools] = useState<BuiltinTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [liveTools, setLiveTools] = useState({ enabled_tools: [] as string[] });
  const [toolDraft, setToolDraft] = useStagedSettings("tools", liveTools, setLiveTools);
  const enabled = new Set(toolDraft.enabled_tools);
  const pending = new Set<string>();

  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(apiUrl("/api/tools"));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = (await res.json()) as ToolsResponse;
        if (!cancelled) {
          setTools(
            payload.tools
              .filter((tool) => VISIBLE_TOGGLEABLE_TOOLS.has(tool.name) && tool.toggleable)
              .map(({ parameters: _parameters, ...tool }) => tool),
          );
          setLiveTools({ enabled_tools: (payload.enabled_optional_tools ?? []).filter((name) => VISIBLE_TOGGLEABLE_TOOLS.has(name)).slice().sort() });
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftRevision]);

  const handleToggleEnabled = (toolName: string) => {
    setToolDraft((current) => {
      const next = new Set(current.enabled_tools);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return { enabled_tools: Array.from(next).sort() };
    });
  };

  const sections = useMemo<ToolSection[] | null>(() => {
    if (!tools) return null;
    return tools.length ? [{
      key: "optional-tools",
      label: "Optional tools",
      hint: "Turn the tools you use on or off.",
      tools,
    }] : [];
  }, [tools]);

  const filteredSections = useMemo<ToolSection[] | null>(() => {
    if (!sections) return null;
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return sections;

    return sections
      .map((section) => ({
        ...section,
        tools: section.tools.filter((tool) => {
          const hints = tool.hints[hintLanguage] ?? tool.hints.en;
          const searchableText = [
            tool.name,
            tool.description,
            ...tool.aliases,
            hints.short_description,
            hints.when_to_use,
            hints.input_format,
            hints.guideline,
            hints.note,
            ...hints.aliases.flatMap((alias) => [
              alias.name,
              alias.description,
              alias.phase,
            ]),
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase();
          return searchableText.includes(needle);
        }),
      }))
      .filter((section) => section.tools.length > 0);
  }, [hintLanguage, query, sections]);

  const toggleExpanded = (name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div>
      <SettingsPageHeader
        title={t("Tools")}
        description={t("Switch user-toggleable tools on or off.")}
      />

      <div className="mb-8">
        <label className="sr-only" htmlFor="tools-search">
          {t("Search tools")}
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            id="tools-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Search tools")}
            aria-label={t("Search tools")}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--card)] py-2.5 pl-10 pr-10 text-[13px] text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--muted-foreground)]/60 focus:border-[var(--ring)] focus:ring-2 focus:ring-[var(--ring)]/20"
            spellCheck={false}
          />
          {query && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2">
              <Tooltip label={t("Clear")} side="top">
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label={t("Clear")}
                  className="rounded-md p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/60 hover:text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]/30"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-[12px] text-red-500">
          {t("Failed to load tools")}: {error}
        </div>
      )}



      {!tools && !error && (
        <div className="flex items-center gap-2 text-[12px] text-[var(--muted-foreground)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("Loading...")}
        </div>
      )}

      {filteredSections && query.trim() && filteredSections.length === 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-8 text-center text-[12.5px] text-[var(--muted-foreground)]">
          {t("No tools match “{{query}}”.", { query: query.trim() })}
        </div>
      )}

      {filteredSections && filteredSections.length > 0 && (
        <div className="space-y-8">
          {filteredSections.map((section) => {
            const list = section.tools;
            if (list.length === 0) return null;
            return (
              <section key={section.key}>
                <header className="mb-3 flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[14px] font-semibold tracking-tight text-[var(--foreground)]">
                      {section.label}
                    </h2>
                    <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
                      {section.hint}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
                    {list.length}
                  </span>
                </header>
                <div className="border-t border-[var(--border)]/60">
                  {list.map((tool, idx) => {
                    const isOpen = expanded.has(tool.name);
                    const hints = tool.hints[hintLanguage] ?? tool.hints.en;
                    const isPending = pending.has(tool.name);
                    const isComingSoon = !!tool.coming_soon;
                    const isAvailable = tool.available !== false;
                    const availability = !isAvailable
                      ? toolAvailabilityCopy(
                          tool.unavailable_reason,
          "en",
                        )
                      : null;
                    const isEnabled = toolEffectiveEnabled(
                      tool.toggleable ? enabled.has(tool.name) : true,
                      isAvailable,
                      isComingSoon,
                    );
                    return (
                      <div
                        key={tool.name}
                        className={
                          idx > 0
                            ? "border-t border-[var(--border)]/50"
                            : undefined
                        }
                      >
                        <div className="flex w-full items-start gap-3 px-5 py-4">
                          <Wrench
                            className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                              isComingSoon || !isAvailable
                                ? "text-[var(--muted-foreground)]/40"
                                : "text-[var(--muted-foreground)]"
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => toggleExpanded(tool.name)}
                            className="flex min-w-0 flex-1 items-start gap-3 text-left"
                            aria-expanded={isOpen}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span
                                  className={`font-mono text-[13px] font-medium ${
                                    isComingSoon
                                      ? "text-[var(--foreground)]/60"
                                      : "text-[var(--foreground)]"
                                  }`}
                                >
                                  {tool.name}
                                </span>
                                {tool.aliases.length > 0 && (
                                  <span className="text-[10.5px] text-[var(--muted-foreground)]/70">
                                    {tool.aliases.join(" · ")}
                                  </span>
                                )}
                                {isComingSoon && (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--muted)]/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                                    Coming soon
                                  </span>
                                )}
                                {availability && !isComingSoon && (
                                  <span className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                    {availability.badge}
                                  </span>
                                )}
                              </div>
                              <p
                                className={`mt-1 text-[12.5px] leading-relaxed ${
                                  isComingSoon
                                    ? "text-[var(--muted-foreground)]/70"
                                    : "text-[var(--muted-foreground)]"
                                }`}
                              >
                                {hints.short_description || tool.description}
                              </p>
                              {availability && !isComingSoon && (
                                <p className="mt-1 text-[11.5px] leading-relaxed text-amber-700 dark:text-amber-300">
                                  {availability.detail}{" "}
                                  {availability.href && (
                                    <a
                                      href={availability.href}
                                      className="font-medium underline underline-offset-2"
                                    >
                                      Open settings
                                    </a>
                                  )}
                                </p>
                              )}
                            </div>
                            <ChevronDown
                              className={`mt-1 h-4 w-4 shrink-0 text-[var(--muted-foreground)] transition-transform ${
                                isOpen ? "rotate-180" : ""
                              }`}
                            />
                          </button>
                          <div className="mt-0.5 flex shrink-0 items-center gap-2">
                            {isComingSoon ? (
                              <ToolToggle
                                checked={false}
                                disabled
                                onChange={() => {
                                  /* locked */
                                }}
                                label={
                                  "Coming soon"
                                }
                              />
                            ) : !isAvailable ? (
                              <ToolToggle
                                checked={false}
                                disabled
                                onChange={() => {
                                  /* runtime unavailable */
                                }}
                                label={
                                  availability?.badge ?? t("Not configured")
                                }
                              />
                            ) : tool.toggleable ? (
                              <ToolToggle
                                checked={isEnabled}
                                disabled={isPending}
                                onChange={() => handleToggleEnabled(tool.name)}
                                label={t(isEnabled ? "On" : "Off")}
                              />
                            ) : (
                              <Tooltip
                                label={t(
                                  "Auto-mounted by the agent when needed. Not user-toggleable.",
                                )}
                                side="top"
                              >
                                <span
                                  role="note"
                                  tabIndex={0}
                                  className="inline-flex items-center gap-1 rounded-full bg-[var(--muted)]/40 px-2 py-0.5 text-[10.5px] text-[var(--muted-foreground)]"
                                >
                                  <Lock className="h-3 w-3" />
                                  {t("Always on")}
                                </span>
                              </Tooltip>
                            )}
                          </div>
                        </div>
                        {isOpen && (
                          <div className="space-y-4 border-t border-[var(--border)]/40 bg-[var(--background)]/40 px-5 py-4 text-[12.5px] leading-relaxed">
                            {hints.when_to_use && (
                              <Field
                                label={t("When to use")}
                                body={hints.when_to_use}
                              />
                            )}
                            {hints.input_format && (
                              <Field
                                label={t("Input format")}
                                body={hints.input_format}
                                mono
                              />
                            )}
                            {hints.guideline && (
                              <Field
                                label={t("Guideline")}
                                body={hints.guideline}
                              />
                            )}
                            {hints.note && (
                              <Field label={t("Note")} body={hints.note} />
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolToggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <Toggle
      checked={checked}
      disabled={disabled}
      onChange={() => onChange()}
      ariaLabel={label}
    />
  );
}

function Field({
  label,
  body,
  mono,
}: {
  label: string;
  body: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]/80">
        {label}
      </div>
      <p
        className={`whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--foreground)]/90 ${
          mono ? "font-mono" : ""
        }`}
      >
        {body}
      </p>
    </div>
  );
}
