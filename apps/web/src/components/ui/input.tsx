import * as React from "react";
import { cn } from "@/lib/utils";

type InputProps = React.ComponentProps<"input">;

function Input({ className, type, ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent disabled:bg-white/5 disabled:text-slate-500 disabled:border-white/10 file:text-sm file:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
