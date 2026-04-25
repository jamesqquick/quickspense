import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors duration-200 disabled:pointer-events-none disabled:opacity-50 cursor-pointer [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-accent-500 text-white hover:bg-accent-600",
        destructive:
          "bg-red-500/20 text-red-300 hover:bg-red-500/30",
        "destructive-solid":
          "bg-red-600 text-white hover:bg-red-700",
        success:
          "bg-green-500/20 text-green-300 hover:bg-green-500/30",
        outline:
          "border border-white/20 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white",
        ghost:
          "text-slate-400 hover:bg-white/10 hover:text-white",
        link:
          "text-primary-400 underline-offset-4 hover:underline hover:text-primary-300",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        lg: "h-10 px-6",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
