"use client";

import { useTranslation } from "react-i18next";
import { ModelsWorkspace } from "@/components/settings/ModelsWorkspace";
import { SettingsPageHeader } from "@/components/settings/shared";

export default function TaskSettingsSection() {
  const { t } = useTranslation();

  return (
    <div>
      <SettingsPageHeader
        title={t("Task models")}
        description={t(
          "Choose the model EAS uses for short background tasks such as titles and suggestions.",
        )}
      />
      <ModelsWorkspace page="task" />
    </div>
  );
}
