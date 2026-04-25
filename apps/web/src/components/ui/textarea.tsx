import * as React from "react";
import { cn } from "@/lib/utils";

type TextareaProps = React.ComponentProps<"textarea">;

function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full min-h-[60px] px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent disabled:bg-white/5 disabled:text-slate-500 disabled:border-white/10 resize-y",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
