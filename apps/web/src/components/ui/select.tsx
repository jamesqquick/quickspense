import * as React from "react";
import { cn } from "@/lib/utils";

type NativeSelectProps = React.ComponentProps<"select">;

function NativeSelect({ className, children, ...props }: NativeSelectProps) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "w-full px-3 py-2 bg-white/10 border border-white/20 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-transparent disabled:bg-white/5 disabled:text-slate-500 disabled:border-white/10",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { NativeSelect };
