import SettingsMain from "@/components/settings/SettingsMain";
import {
  ModelCatalogProvider,
  SettingsDraftProvider,
  SettingsProvider,
  UiSettingsProvider,
} from "@/features/settings/store";
import { SettingsAccessProvider } from "@/features/settings/navigation/SettingsAccessProvider";

export default function SettingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <SettingsProvider>
      <SettingsAccessProvider>
        <UiSettingsProvider>
          <ModelCatalogProvider>
            <SettingsDraftProvider>
              <SettingsMain>{children}</SettingsMain>
            </SettingsDraftProvider>
          </ModelCatalogProvider>
        </UiSettingsProvider>
      </SettingsAccessProvider>
    </SettingsProvider>
  );
}
