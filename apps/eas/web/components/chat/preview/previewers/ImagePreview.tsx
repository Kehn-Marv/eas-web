"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { usePreviewUrl } from "./usePreviewUrl";

/**
 * Image preview. Uses a native <img> instead of next/image because:
 *   1. The /files/attachments URL is dynamic per-session and not in the
 *      next.config remotePatterns whitelist.
 *   2. We want object-contain centering against a checkered backdrop.
 *
 * Data URLs (the pending-attachment case) work the same way.
 */
export default function ImagePreview({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  const { t } = useTranslation();
  const { src, loading, error } = usePreviewUrl(url);
  const [imageError, setImageError] = useState(false);
  useEffect(() => setImageError(false), [src]);

  return (
    <div
      className="relative flex h-full w-full items-center justify-center bg-[var(--muted)]/30"
      style={{
        backgroundImage:
          "linear-gradient(45deg, rgba(0,0,0,0.04) 25%, transparent 25%), " +
          "linear-gradient(-45deg, rgba(0,0,0,0.04) 25%, transparent 25%), " +
          "linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.04) 75%), " +
          "linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.04) 75%)",
        backgroundSize: "16px 16px",
        backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
      }}
    >
      {loading && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <Loader2
            size={16}
            className="animate-spin text-[var(--muted-foreground)]"
          />
        </div>
      )}
      {error || imageError || !src ? (
        <div className="text-[12px] text-[var(--muted-foreground)]">
          {t("Failed to load image.")}
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={filename}
          className="max-h-full max-w-full object-contain"
          onError={() => setImageError(true)}
        />
      )}
    </div>
  );
}
