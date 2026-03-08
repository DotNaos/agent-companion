import type { ActivityEvent } from '@agent-companion/shared';
import { useMemo, useState } from 'react';
import { cn } from '../lib/utils.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from './ui/card.js';
import { ScrollArea } from './ui/scroll-area.js';

type ActivityViewProps = Readonly<{
    activity: ActivityEvent[];
}>;

type ActivityDisplayMode = 'pretty' | 'json' | 'raw';

export function ActivityView({ activity }: ActivityViewProps) {
    const [displayMode, setDisplayMode] =
        useState<ActivityDisplayMode>('pretty');
    const [copied, setCopied] = useState(false);

    const reversedActivity = useMemo(
        () => activity.slice().reverse(),
        [activity],
    );
    const jsonText = useMemo(
        () => JSON.stringify(reversedActivity, null, 2),
        [reversedActivity],
    );
    const rawText = useMemo(
        () => reversedActivity.map(formatActivityEntryAsRaw).join('\n\n'),
        [reversedActivity],
    );
    const copyText = displayMode === 'raw' ? rawText : jsonText;
    const bodyText =
        displayMode === 'json'
            ? jsonText
            : rawText || 'No activity recorded yet.';

    async function copyCurrentView() {
        try {
            await globalThis.navigator?.clipboard?.writeText(copyText);
            setCopied(true);
            globalThis.setTimeout(() => setCopied(false), 1600);
        } catch {
            setCopied(false);
        }
    }

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div>
                        <CardTitle>Live Activity</CardTitle>
                        <CardDescription>
                            Auth, tool calls, writes, command execution, and
                            process lifecycle events.
                        </CardDescription>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="inline-flex rounded-xl border border-white/10 bg-black/30 p-1">
                            {(['pretty', 'json', 'raw'] as const).map(
                                (mode) => (
                                    <Button
                                        key={mode}
                                        size="sm"
                                        variant="ghost"
                                        className={cn(
                                            'h-8 px-3 text-xs capitalize',
                                            displayMode === mode
                                                ? 'bg-white/10 text-white hover:bg-white/10'
                                                : 'text-slate-400 hover:text-white',
                                        )}
                                        onClick={() => setDisplayMode(mode)}>
                                        {mode}
                                    </Button>
                                ),
                            )}
                        </div>
                        <Button
                            size="sm"
                            variant="secondary"
                            className="h-8 px-3 text-xs"
                            onClick={() => void copyCurrentView()}
                            disabled={activity.length === 0}>
                            {copied ? 'Copied' : 'Copy view'}
                        </Button>
                    </div>
                </div>
            </CardHeader>
            <CardContent>
                <ScrollArea className="h-150 w-full rounded-3xl border border-white/10 bg-slate-900/30 p-4">
                    {displayMode === 'pretty' ? (
                        <div className="flex flex-col gap-3">
                            {reversedActivity.map((entry) => (
                                <article
                                    key={entry.id}
                                    className={cn(
                                        'rounded-2xl border border-white/10 p-4 transition-colors',
                                        entry.level === 'error'
                                            ? 'border-red-500/20 bg-red-500/5'
                                            : 'bg-white/2 hover:bg-white/4',
                                    )}>
                                    <div className="mb-2 flex items-center justify-between">
                                        <Badge
                                            variant="outline"
                                            className={cn(
                                                'border-white/10 font-mono text-[10px]',
                                                entry.level === 'error'
                                                    ? 'border-red-400/30 text-red-400'
                                                    : 'text-white',
                                            )}>
                                            {entry.type}
                                        </Badge>
                                        <time className="font-mono text-xs text-slate-500">
                                            {new Date(
                                                entry.timestamp,
                                            ).toLocaleTimeString()}
                                        </time>
                                    </div>
                                    <p
                                        className={cn(
                                            'wrap-break-word text-sm',
                                            entry.level === 'error'
                                                ? 'text-red-200'
                                                : 'text-slate-200',
                                        )}>
                                        {entry.message}
                                    </p>
                                    {Object.keys(entry.data).length > 0 ? (
                                        <div className="mt-3 overflow-x-auto rounded bg-black/40 p-2">
                                            <pre className="wrap-break-word whitespace-pre-wrap text-[11px] font-mono text-slate-400">
                                                {JSON.stringify(
                                                    entry.data,
                                                    null,
                                                    2,
                                                )}
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
                    ) : (
                        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-slate-300">
                            {bodyText}
                        </pre>
                    )}
                </ScrollArea>
            </CardContent>
        </Card>
    );
}

function formatActivityEntryAsRaw(entry: ActivityEvent) {
    const header = `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.type}: ${entry.message}`;
    if (Object.keys(entry.data).length === 0) {
        return header;
    }

    return `${header}\n${JSON.stringify(entry.data, null, 2)}`;
}
