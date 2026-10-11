import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const calloutVariants = cva("rounded-xl border p-5 leading-relaxed", {
  variants: {
    variant: {
      info: "bg-info-bg border-info-border text-neutral-800",
      hint: "bg-hint-bg border-hint-border text-neutral-800",
      correct: "bg-correct-bg border-correct-border text-correct-fg",
      incorrect: "bg-incorrect-bg border-incorrect-border text-incorrect-fg",
      warning: "bg-warning-bg border-warning-border text-warning-fg",
      neutral: "bg-surface-muted border-border text-neutral-700",
    },
  },
  defaultVariants: { variant: "info" },
});

export interface CalloutProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof calloutVariants> {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  action?: React.ReactNode;
}

export function Callout({
  className,
  variant,
  icon,
  title,
  action,
  children,
  ...props
}: CalloutProps) {
  return (
    <div className={cn(calloutVariants({ variant }), className)} {...props}>
      {(icon || title || action) && (
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            {icon}
            {title && <p className="text-sm font-semibold">{title}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export { calloutVariants };
