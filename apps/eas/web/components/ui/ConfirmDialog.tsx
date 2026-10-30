"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, HelpCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body content — plain text or richer markup (e.g. an avatar row). */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" renders a red confirm button and warning badge for destructive actions. */
  tone?: "default" | "danger";
  /** Disables the buttons and swaps the confirm label while pending. */
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Standard confirmation modal matching the app's dialog design language
 * (backdrop blur, subtle zoom-in animation, rounded-2xl card, dark/light theme support),
 * replacing native browser window.confirm() dialogs.
 * Closes on Escape and on overlay click; the cancel button takes initial focus so a
 * stray Enter never triggers a destructive action.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  tone = "default",
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const resolvedCancelLabel = cancelLabel ?? t("Cancel");
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Handle escape key
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  // Initial focus onto cancel button to avoid accidental Enter confirmation
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      cancelButtonRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const content = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--overlay)] backdrop-blur-sm px-4 animate-in fade-in duration-200"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-start gap-3.5 mb-2">
          {tone === "danger" ? (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-600 dark:bg-red-950/40 dark:text-red-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
          ) : (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[var(--foreground)]">
              <HelpCircle className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="text-base font-semibold text-[var(--foreground)]">
              {title}
            </h2>
            {children && (
              <div className="mt-1.5 text-sm leading-relaxed text-[var(--muted-foreground)] whitespace-pre-line">
                {children}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
            aria-label={t("Close")}
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2.5">
          <button
            type="button"
            ref={cancelButtonRef}
            onClick={onCancel}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-sm font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          >
            {resolvedCancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`rounded-xl px-4 py-2 text-sm font-medium disabled:opacity-40 transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 ${
              tone === "danger"
                ? "bg-red-600 text-white hover:bg-red-700 active:bg-red-800 focus-visible:ring-red-500"
                : "bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 active:opacity-100 focus-visible:ring-[var(--ring)]"
            }`}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document !== "undefined") {
    return createPortal(content, document.body);
  }
  return content;
}

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

/**
 * Provides an app-wide imperative `confirm({...})` hook that replaces browser `window.confirm`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [activeOptions, setActiveOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setActiveOptions(options);
    });
  }, []);

  const handleConfirm = useCallback(() => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setActiveOptions(null);
    resolve?.(true);
  }, []);

  const handleCancel = useCallback(() => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setActiveOptions(null);
    resolve?.(false);
  }, []);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {activeOptions && (
        <ConfirmDialog
          open={Boolean(activeOptions)}
          title={activeOptions.title}
          confirmLabel={activeOptions.confirmLabel ?? t("Confirm")}
          cancelLabel={activeOptions.cancelLabel ?? t("Cancel")}
          tone={activeOptions.tone ?? "default"}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        >
          {activeOptions.message}
        </ConfirmDialog>
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * Imperative hook to display a rich in-app confirmation modal.
 * Replaces native browser `window.confirm(...)`.
 */
export function useConfirm() {
  const context = useContext(ConfirmContext);
  return useCallback(
    (options: ConfirmOptions) => {
      if (context) {
        return context.confirm(options);
      }
      // Fallback for tests spying on window.confirm or environments without provider
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        const text =
          typeof options.message === "string" ? options.message : options.title;
        return Promise.resolve(window.confirm(text));
      }
      return Promise.resolve(true);
    },
    [context],
  );
}
