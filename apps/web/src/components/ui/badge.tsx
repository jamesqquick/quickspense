import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
  {
    variants: {
      variant: {
        default: "bg-white/10 text-slate-300",
        success: "bg-green-500/20 text-green-300",
        warning: "bg-yellow-500/20 text-yellow-300",
        info: "bg-blue-500/20 text-blue-300",
        destructive: "bg-red-500/20 text-red-300",
        muted: "bg-slate-500/20 text-slate-300",
        primary: "bg-primary-500 text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants>;

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
