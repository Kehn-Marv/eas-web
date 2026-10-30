/**
 * Destination for the EAS learning workspace.
 * Defaults to the local `/chat` route in the merged app.
 */
const configuredUrl = process.env.NEXT_PUBLIC_EAS_APP_URL?.trim();

function resolveEasAppUrl(): string {
  if (!configuredUrl) return "/chat";
  return configuredUrl;
}

export const EAS_APP_URL = resolveEasAppUrl();
