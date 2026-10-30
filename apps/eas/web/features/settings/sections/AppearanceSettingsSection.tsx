"use client";

import { useTranslation } from "react-i18next";

import { useUiSettings } from "@/features/settings/store";
import { ThemePreviewCard } from "@/components/settings/ThemePreviewCard";
import { SettingSection, SettingsPageHeader } from "@/components/settings/shared";

export default function AppearanceSettingsPage() {
  const { t } = useTranslation();
  const { theme, updateTheme } = useUiSettings();

  return (
    <div>
      <SettingsPageHeader
        title={t("Appearance")}
        description={t(
          "Customize the visual theme. Apply changes using the bar below.",
        )}
      />

      <SettingSection
        title={t("Theme")}
      >
        <div className="py-3.5">
          {/* Order is intentional: Default (pure-white neutral, the default
              selection; theme id "snow" kept for stored preferences) →
              warm-light Cream → warm-dark Dark → cool-dark Glass. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                { id: "snow", label: t("Default") },
                { id: "light", label: t("Cream") },
                { id: "dark", label: t("Dark") },
                { id: "glass", label: t("Glass") },
              ] as const
            ).map(({ id, label }) => (
              <ThemePreviewCard
                key={id}
                theme={id}
                label={label}
                selected={theme === id}
                onSelect={updateTheme}
              />
            ))}
          </div>
        </div>
      </SettingSection>
    </div>
  );
}
