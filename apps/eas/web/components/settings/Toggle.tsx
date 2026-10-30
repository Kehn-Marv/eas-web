"use client";

import React from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  ariaLabel?: string;
  "aria-label"?: string;
  id?: string;
  className?: string;
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  size = "md",
  ariaLabel,
  "aria-label": ariaLabelAttr,
  id,
  className = "",
}: ToggleProps) {
  const isSm = size === "sm";

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? ariaLabelAttr}
      disabled={disabled}
      onClick={() => {
        if (!disabled) {
          onChange(!checked);
        }
      }}
      className={`relative shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)] disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none ${
        isSm ? "h-4 w-7" : "h-5 w-9"
      } ${
        checked ? "bg-[var(--foreground)]" : "bg-[var(--border)]"
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute rounded-full bg-[var(--background)] shadow-sm transition-transform duration-200 ease-in-out motion-reduce:transition-none ${
          isSm
            ? "left-0.5 top-0.5 h-3 w-3"
            : "left-0.5 top-0.5 h-4 w-4"
        } ${
          checked
            ? isSm
              ? "translate-x-3"
              : "translate-x-4"
            : "translate-x-0"
        }`}
      />
    </button>
  );
}
