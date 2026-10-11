const appUrl = process.env.NEXT_PUBLIC_APP_URL;

export const metadataBase = appUrl ? new URL(appUrl) : undefined;
