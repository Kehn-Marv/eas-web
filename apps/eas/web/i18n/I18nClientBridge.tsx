"use client";

import { I18nProvider } from "./I18nProvider";

export function I18nClientBridge({ children }: { children: React.ReactNode }) {
  return <I18nProvider>{children}</I18nProvider>;
}
