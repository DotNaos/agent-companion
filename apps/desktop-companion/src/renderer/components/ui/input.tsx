import * as React from "react";
import { cn } from "../../lib/utils.js";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "flex h-12 w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-300/45 focus:ring-2 focus:ring-emerald-300/20",
      className,
    )}
    {...props}
  />
));

Input.displayName = "Input";

export { Input };
