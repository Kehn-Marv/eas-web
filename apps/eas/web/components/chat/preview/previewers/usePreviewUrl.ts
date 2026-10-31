"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/shared/api/client";

type PreviewState = { src: string | null; loading: boolean; error: boolean };

/**
 * Turn same-origin protected file URLs into browser-loadable blob URLs.
 * Native <img> requests cannot attach the app's session headers, which made
 * saved SVG/image previews appear as broken-image icons in hosted deployments.
 * External, data, and already-local blob URLs remain direct to preserve signed
 * media URLs and pending composer attachments.
 */
export function usePreviewUrl(url: string, expectedMime?: string): PreviewState {
  const [state, setState] = useState<PreviewState>({
    src: null,
    loading: true,
    error: false,
  });

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    setState({ src: null, loading: true, error: false });

    const directUrl = /^(data:|blob:)/i.test(url);
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url, window.location.origin).origin === window.location.origin;
    } catch {
      // Invalid URL is surfaced as an unavailable preview below.
    }

    if (directUrl || !sameOrigin) {
      if (active) setState({ src: url, loading: false, error: false });
    } else {
      void (async () => {
        try {
          const response = await apiFetch(url, { signal: controller.signal });
          if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
          const blob = await response.blob();
          if (expectedMime && blob.type && blob.type !== expectedMime) {
            // Some storage gateways omit a MIME type; reject only an explicit
            // different type, especially HTML auth/error pages.
            if (blob.type === "text/html" || blob.type === "application/json") {
              throw new Error("The server returned an error page instead of a file.");
            }
          }
          objectUrl = URL.createObjectURL(blob);
          if (active) {
            setState({ src: objectUrl, loading: false, error: false });
          } else {
            // A fetch implementation may resolve despite aborting during
            // unmount. Revoke here because the effect cleanup has already run.
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
          }
        } catch {
          if (active && !controller.signal.aborted) {
            setState({ src: null, loading: false, error: true });
          }
        }
      })();
    }

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, expectedMime]);

  return state;
}
