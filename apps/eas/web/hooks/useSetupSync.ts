"use client";

import { useEffect, useRef } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import { setTheme, type Theme } from "@/lib/theme";
import { collectAppliedSettingIds } from "@/lib/setup-signals";
import type { StreamEvent } from "@/features/chat/model/protocol";

const THEMES: readonly Theme[] = ["light", "dark", "glass", "snow"];

function asTheme(value: unknown): Theme | null {
  return typeof value === "string" &&
    (THEMES as readonly string[]).includes(value)
    ? (value as Theme)
    : null;
}

/**
 * Refresh theme changes made by the in-app setup flow. Language
 * is fixed to English throughout EAS.
 *
 * Each tool call is honoured once — replayed history and re-renders must not
 * keep overwriting a preference the user has since changed by hand.
 */
export function useSetupSync(
  messages: ReadonlyArray<{ events?: StreamEvent[] }> | undefined,
): void {
  const handledRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const fresh = collectAppliedSettingIds(messages).filter(
      (id) => !handledRef.current.has(id),
    );
    if (fresh.length === 0) return;
    for (const id of fresh) handledRef.current.add(id);

    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch(apiUrl("/api/settings/ui"));
        if (!res.ok || cancelled) return;
        const payload = (await res.json()) as {
          theme?: unknown;
        };
        if (cancelled) return;
        const theme = asTheme(payload.theme);
        if (theme) setTheme(theme);
      } catch {
        // A preference that failed to refresh is a cosmetic miss: the value is
        // stored server-side and the next load picks it up.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages]);
}

