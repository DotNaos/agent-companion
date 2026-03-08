import type { ActivityEvent } from "@agent-companion/shared";
import { Badge } from "./ui/badge.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.js";
import { ScrollArea } from "./ui/scroll-area.js";
import { cn } from "../lib/utils.js";

type ActivityViewProps = Readonly<{
  activity: ActivityEvent[];
}>;

export function ActivityView({ activity }: ActivityViewProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Live Activity</CardTitle>
        <CardDescription>
          Auth, tool calls, writes, command execution, and process lifecycle
          events.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-150 w-full rounded-3xl border border-white/10 bg-slate-900/30 p-4">
          <div className="flex flex-col gap-3">
            {activity
              .slice()
              .reverse()
              .map((entry) => (
                <article
                  key={entry.id}
                  className={cn(
                    "rounded-2xl border border-white/10 p-4 transition-colors",
                    entry.level === "error"
                      ? "border-red-500/20 bg-red-500/5"
                      : "bg-white/2 hover:bg-white/4",
                  )}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <Badge
                      variant="outline"
                      className={cn(
                        "border-white/10 font-mono text-[10px]",
                        entry.level === "error"
                          ? "border-red-400/30 text-red-400"
                          : "text-white",
                      )}
                    >
                      {entry.type}
                    </Badge>
                    <time className="font-mono text-xs text-slate-500">
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </time>
                  </div>
                  <p
                    className={cn(
                      "wrap-break-word text-sm",
                      entry.level === "error"
                        ? "text-red-200"
                        : "text-slate-200",
                    )}
                  >
                    {entry.message}
                  </p>
                  {Object.keys(entry.data).length > 0 ? (
                    <div className="mt-3 overflow-x-auto rounded bg-black/40 p-2">
                      <pre className="wrap-break-word whitespace-pre-wrap text-[11px] font-mono text-slate-400">
                        {JSON.stringify(entry.data, null, 2)}
                      </pre>
                    </div>
                  ) : null}
                </article>
              ))}
            {activity.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                No activity recorded yet.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
