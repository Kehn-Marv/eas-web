"use client";

import { useEffect } from "react";
import i18n from "i18next";
import { initI18n } from "./init";

// Initialize i18next at module load (before any React render) so that the
// `init()` call — which fires `initialized` / `languageChanged` events that
// trigger setState on subscribed components — never happens during another
// component's render phase. Calling `initI18n` from the render body would
// produce the React warning:
//   "Cannot update a component (`X`) while rendering a different component
//   (`I18nProvider`)."
initI18n();

export function I18nProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (i18n.language !== "en") void i18n.changeLanguage("en");
    document.documentElement.lang = "en";
  }, []);

  return children;
}
