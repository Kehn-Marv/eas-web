"use client";

import { usePreviewUrl } from "./usePreviewUrl";
import { useEffect, useState } from "react";

/**
 * SVGs are shown in an <img> document context so embedded scripts cannot run.
 * Same-origin files are fetched through the authenticated API client first.
 */
export default function SvgPreview({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  const { src, loading, error } = usePreviewUrl(url, "image/svg+xml");
  const [imageError, setImageError] = useState(false);
  useEffect(() => setImageError(false), [src]);

  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--muted)]/30 p-6">
      {loading ? (
        <span className="text-sm text-[var(--muted-foreground)]">Loading preview…</span>
      ) : error || imageError || !src ? (
        <div className="flex flex-col items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <span>Could not load this SVG preview.</span>
          <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            Open original file
          </a>
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
