import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap select-none cursor-pointer transition-[transform,background-color,border-color,color,box-shadow] duration-200 ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50 disabled:pointer-events-none active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
  {
    variants: {
      variant: {
        primary:
          "bg-neutral-900 text-white hover:bg-neutral-800 shadow-sm hover:shadow",
        secondary:
          "bg-surface-muted text-neutral-700 border border-border hover:bg-neutral-200 hover:text-neutral-900",
        outline:
          "border-2 border-neutral-900 text-neutral-900 bg-white hover:bg-surface-muted",
        ghost:
          "text-neutral-600 hover:text-neutral-900 hover:bg-surface-muted",
        danger:
          "bg-incorrect text-white hover:bg-red-700 shadow-sm hover:shadow",
      },
      size: {
        sm: "h-9 px-3 text-sm",
        md: "h-11 px-6 text-sm",
        lg: "h-14 px-8 text-base",
        icon: "h-9 w-9",
      },
      shape: {
        pill: "rounded-full",
        lg: "rounded-lg",
      },
    },
    defaultVariants: { variant: "primary", size: "md", shape: "pill" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, shape }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
