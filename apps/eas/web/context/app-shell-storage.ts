"use client";

import { browserStorage } from "@/shared/storage";
import { activeWorkspaceId } from "@/lib/workspace-scope";
export const ACTIVE_SESSION_STORAGE_KEY = "eas.activeSessionId.tab";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "eas.sidebarCollapsed";
export const CODE_BLOCK_THEME_STORAGE_KEY = "eas.code-block-theme";
export const CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY =
  "eas.code-block-show-line-numbers";
export const CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY =
  "eas.code-block-wrap-long-lines";

export const ACTIVE_SESSION_EVENT = "eas:active-session";
export const SIDEBAR_COLLAPSED_EVENT = "eas:sidebar-collapsed";
export const CODE_BLOCK_SETTINGS_EVENT = "eas:code-block-settings";

export function readStoredActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return browserStorage.readRaw("session", `${ACTIVE_SESSION_STORAGE_KEY}:${activeWorkspaceId()}`);
  } catch {
    return null;
  }
}

export function writeStoredActiveSessionId(sessionId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (sessionId) {
      browserStorage.writeRaw("session", `${ACTIVE_SESSION_STORAGE_KEY}:${activeWorkspaceId()}`, sessionId);
    } else {
      browserStorage.removeRaw("session", `${ACTIVE_SESSION_STORAGE_KEY}:${activeWorkspaceId()}`);
    }
    window.dispatchEvent(
      new CustomEvent(ACTIVE_SESSION_EVENT, {
        detail: { sessionId },
      }),
    );
  } catch {
    // sessionStorage may be unavailable
  }
}

export function readStoredSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      browserStorage.readRaw("local", SIDEBAR_COLLAPSED_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    browserStorage.writeRaw(
      "local",
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
    window.dispatchEvent(
      new CustomEvent(SIDEBAR_COLLAPSED_EVENT, {
        detail: { collapsed },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

// Code block settings defaults
export const DEFAULT_CODE_BLOCK_THEME = "oneDark";
export const DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS = false;
export const DEFAULT_CODE_BLOCK_WRAP_LONG_LINES = false;

export function normalizeCodeBlockTheme(
  value: string | null | undefined,
): string {
  if (!value || value.trim() === "") return DEFAULT_CODE_BLOCK_THEME;
  return value.trim();
}

export function readStoredCodeBlockTheme(): string {
  if (typeof window === "undefined") return DEFAULT_CODE_BLOCK_THEME;
  try {
    const raw = browserStorage.readRaw("local", CODE_BLOCK_THEME_STORAGE_KEY);
    return normalizeCodeBlockTheme(raw);
  } catch {
    return DEFAULT_CODE_BLOCK_THEME;
  }
}

export function writeStoredCodeBlockTheme(theme: string): void {
  if (typeof window === "undefined") return;
  try {
    browserStorage.writeRaw(
      "local",
      CODE_BLOCK_THEME_STORAGE_KEY,
      normalizeCodeBlockTheme(theme),
    );
    window.dispatchEvent(
      new CustomEvent(CODE_BLOCK_SETTINGS_EVENT, {
        detail: { codeBlockTheme: normalizeCodeBlockTheme(theme) },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function normalizeCodeBlockShowLineNumbers(
  value: string | null | undefined,
): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS;
}

export function readStoredCodeBlockShowLineNumbers(): boolean {
  if (typeof window === "undefined")
    return DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS;
  try {
    const raw = browserStorage.readRaw(
      "local",
      CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY,
    );
    return normalizeCodeBlockShowLineNumbers(raw);
  } catch {
    return DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS;
  }
}

export function writeStoredCodeBlockShowLineNumbers(show: boolean): void {
  if (typeof window === "undefined") return;
  try {
    browserStorage.writeRaw(
      "local",
      CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY,
      String(show),
    );
    window.dispatchEvent(
      new CustomEvent(CODE_BLOCK_SETTINGS_EVENT, {
        detail: { codeBlockShowLineNumbers: show },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function normalizeCodeBlockWrapLongLines(
  value: string | null | undefined,
): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return DEFAULT_CODE_BLOCK_WRAP_LONG_LINES;
}

export function readStoredCodeBlockWrapLongLines(): boolean {
  if (typeof window === "undefined") return DEFAULT_CODE_BLOCK_WRAP_LONG_LINES;
  try {
    const raw = browserStorage.readRaw(
      "local",
      CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY,
    );
    return normalizeCodeBlockWrapLongLines(raw);
  } catch {
    return DEFAULT_CODE_BLOCK_WRAP_LONG_LINES;
  }
}

export function writeStoredCodeBlockWrapLongLines(wrap: boolean): void {
  if (typeof window === "undefined") return;
  try {
    browserStorage.writeRaw(
      "local",
      CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY,
      String(wrap),
    );
    window.dispatchEvent(
      new CustomEvent(CODE_BLOCK_SETTINGS_EVENT, {
        detail: { codeBlockWrapLongLines: wrap },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}
