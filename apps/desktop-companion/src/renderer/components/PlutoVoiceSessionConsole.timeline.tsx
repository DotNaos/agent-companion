import type {
    OverlayBubblePreview,
    VoiceTimelineDraftEntry,
    VoiceTimelineEntry,
} from './PlutoVoiceSessionConsole.shared.js';

export function renderVoiceTimeline(
    entries: VoiceTimelineEntry[],
    isOverlay: boolean,
) {
    return (
        <div className="space-y-3">
            {entries.length === 0 ? (
                <div className="text-sm text-slate-500">
                    Pluto is waiting for the first live event.
                </div>
            ) : (
                entries.map((entry) => (
                    <div key={entry.id} className={getTimelineEntryRowClass(entry)}>
                        {renderTimelineEntry(entry, isOverlay)}
                    </div>
                ))
            )}
        </div>
    );
}

function getTimelineEntryRowClass(entry: VoiceTimelineEntry) {
    return getVoiceTimelineLayout(entry.actor, false).rowClass;
}

function getTimelineEntryBubbleClass(
    entry: VoiceTimelineEntry,
    isOverlay: boolean,
) {
    return getVoiceTimelineLayout(entry.actor, isOverlay).bubbleClass;
}

export function getVoiceTimelineLayout(
    actor: VoiceTimelineEntry['actor'],
    isOverlay: boolean,
) {
    let rowClass = 'flex justify-center';
    if (actor === 'you') {
        rowClass = 'flex justify-end';
    } else if (actor === 'pluto') {
        rowClass = 'flex justify-start';
    }

    const baseClass = isOverlay
        ? 'max-w-[85%] rounded-2xl px-3 py-2'
        : 'max-w-[80%] rounded-2xl px-4 py-3';

    let bubbleClass = `${baseClass} border border-white/8 bg-black/25 text-center`;
    if (actor === 'you') {
        bubbleClass = `${baseClass} border border-cyan-400/30 bg-cyan-500/15 text-right`;
    } else if (actor === 'pluto') {
        bubbleClass = isOverlay
            ? `${baseClass} border border-white/10 bg-white/8`
            : 'w-full max-w-3xl px-1 py-1 text-left';
    }

    return {
        rowClass,
        bubbleClass,
    };
}

function renderTimelineEntry(entry: VoiceTimelineEntry, isOverlay: boolean) {
    if (entry.details) {
        return (
            <details
                className={getTimelineEntryBubbleClass(entry, isOverlay)}>
                <summary className="cursor-pointer list-none">
                    <div className="flex items-center justify-between gap-2">
                        <span className={timelineToneClass(entry.tone)}>
                            {entry.label}
                        </span>
                        <time className="text-[11px] text-slate-500">
                            {new Date(entry.createdAt).toLocaleTimeString()}
                        </time>
                    </div>
                    <p className="mt-1 text-sm text-slate-100">{entry.text}</p>
                </summary>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-xl border border-white/8 bg-black/25 px-3 py-2 text-xs text-slate-300">
                    {entry.details}
                </pre>
            </details>
        );
    }

    if (entry.actor === 'pluto' && !isOverlay) {
        return (
            <div className={getTimelineEntryBubbleClass(entry, isOverlay)}>
                <div className="flex items-center justify-between gap-2">
                    <span className={timelineToneClass(entry.tone)}>
                        {entry.label}
                    </span>
                    <time className="text-[11px] text-slate-500">
                        {new Date(entry.createdAt).toLocaleTimeString()}
                    </time>
                </div>
                <p className="mt-2 text-base leading-7 text-slate-100">
                    {entry.text}
                </p>
            </div>
        );
    }

    return (
        <div className={getTimelineEntryBubbleClass(entry, isOverlay)}>
            <div className="flex items-center justify-between gap-2">
                <span className={timelineToneClass(entry.tone)}>
                    {entry.label}
                </span>
                <time className="text-[11px] text-slate-500">
                    {new Date(entry.createdAt).toLocaleTimeString()}
                </time>
            </div>
            <p className="mt-1 text-sm text-slate-100">{entry.text}</p>
        </div>
    );
}

export function appendVoiceTimelineEntry(
    current: VoiceTimelineEntry[],
    entry: VoiceTimelineDraftEntry,
    now = new Date().toISOString(),
) {
    const previous = current.at(-1);

    if (previous?.label === entry.label && previous.text === entry.text) {
        return current;
    }

    const mergeTargetIndex = findVoiceTimelineMergeTargetIndex(current, entry);
    const mergeTarget =
        mergeTargetIndex >= 0 ? current[mergeTargetIndex] : undefined;

    if (mergeTarget && shouldMergeVoiceTimelineEntry(mergeTarget, entry, now)) {
        const mergedEntry: VoiceTimelineEntry = {
            ...mergeTarget,
            text: mergeVoiceTimelineText(mergeTarget.text, entry.text),
            tone: entry.tone,
        };
        return current.map((timelineEntry, index) =>
            index === mergeTargetIndex ? mergedEntry : timelineEntry,
        );
    }

    const nextEntry: VoiceTimelineEntry = {
        ...entry,
        id: crypto.randomUUID(),
        createdAt: now,
    };

    return [...current, nextEntry].slice(-30);
}

export function deriveLatestOverlayBubble(
    entries: VoiceTimelineEntry[],
): OverlayBubblePreview | null {
    return deriveOverlayBubblePreviewHistory(entries, 1)[0] ?? null;
}

export function deriveOverlayBubblePreviewHistory(
    entries: VoiceTimelineEntry[],
    maxCount = 2,
): OverlayBubblePreview[] {
    const previews: OverlayBubblePreview[] = [];

    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const preview = buildOverlayBubblePreview(entries[index]);
        if (!preview) {
            continue;
        }

        previews.push(preview);
        if (previews.length >= maxCount) {
            break;
        }
    }

    return previews.reverse();
}

function findVoiceTimelineMergeTargetIndex(
    entries: VoiceTimelineEntry[],
    next: VoiceTimelineDraftEntry,
) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!shouldInspectMergeCandidate(entry)) {
            continue;
        }

        const turnMatch = resolveTurnBasedMergeMatch(entry, next);
        if (turnMatch === 'match') {
            return index;
        }

        if (turnMatch === 'stop') {
            return -1;
        }

        if (entry.actor === next.actor && entry.label === next.label) {
            return index;
        }

        return -1;
    }

    return -1;
}

function buildOverlayBubblePreview(
    entry: VoiceTimelineEntry | undefined,
): OverlayBubblePreview | null {
    if (!entry) {
        return null;
    }

    if (!isOverlayBubbleSource(entry)) {
        return null;
    }

    const text = entry.text.trim();
    if (!text) {
        return null;
    }

    return {
        id: entry.id,
        actor: entry.actor,
        title: entry.actor === 'pluto' ? 'Pluto' : entry.label,
        text,
        tone: entry.tone,
    };
}

function isOverlayBubbleSource(entry: VoiceTimelineEntry) {
    if (entry.overlayBubble !== undefined) {
        return entry.overlayBubble;
    }

    return entry.actor === 'pluto' && entry.label === 'Pluto';
}

function shouldInspectMergeCandidate(entry: VoiceTimelineEntry | undefined) {
    return Boolean(entry) && entry?.actor !== 'system';
}

function resolveTurnBasedMergeMatch(
    entry: VoiceTimelineEntry,
    next: VoiceTimelineDraftEntry,
) {
    if (next.turnId === undefined && entry.turnId === undefined) {
        return 'defer' as const;
    }

    if (entry.turnId === next.turnId && entry.actor === next.actor) {
        return 'match' as const;
    }

    if (entry.actor === next.actor) {
        return 'stop' as const;
    }

    return 'defer' as const;
}

export function shouldMergeVoiceTimelineEntry(
    previous: Pick<
        VoiceTimelineEntry,
        'actor' | 'label' | 'text' | 'tone' | 'createdAt' | 'turnId'
    >,
    next: VoiceTimelineDraftEntry,
    now = new Date().toISOString(),
) {
    if (previous.actor !== next.actor || previous.label !== next.label) {
        return false;
    }

    if (previous.turnId !== next.turnId) {
        return false;
    }

    if (previous.actor === 'system') {
        return false;
    }

    if (previous.turnId !== undefined && next.turnId !== undefined) {
        return true;
    }

    const previousText = previous.text.trim();
    const nextText = next.text.trim();

    if (!previousText || !nextText) {
        return true;
    }

    const previousTime = Date.parse(previous.createdAt);
    const currentTime = Date.parse(now);
    const withinStreamingWindow =
        Number.isFinite(previousTime) &&
        Number.isFinite(currentTime) &&
        currentTime - previousTime <= 2_500;

    return (
        nextText.startsWith(previousText) ||
        previousText.startsWith(nextText) ||
        isLikelyTranscriptContinuation(previousText, nextText) ||
        withinStreamingWindow ||
        longestCommonPrefixLength(previousText, nextText) >=
            Math.min(previousText.length, nextText.length) * 0.7
    );
}

function isLikelyTranscriptContinuation(
    previousText: string,
    nextText: string,
) {
    if (!previousText || !nextText) {
        return false;
    }

    if (/[.!?…]["')\]]?$/.test(previousText)) {
        return false;
    }

    return /^[a-zäöüß,(]/.test(nextText);
}

export function mergeVoiceTimelineText(previousText: string, nextText: string) {
    const previousTrimmed = previousText.trim();
    const nextTrimmed = nextText.trim();

    if (!previousTrimmed) {
        return nextTrimmed;
    }

    if (!nextTrimmed) {
        return previousTrimmed;
    }

    if (nextTrimmed.startsWith(previousTrimmed)) {
        return nextTrimmed;
    }

    if (previousTrimmed.startsWith(nextTrimmed)) {
        return previousTrimmed;
    }

    const overlap = longestSuffixPrefixOverlap(previousTrimmed, nextTrimmed);
    if (overlap >= 3) {
        return `${previousTrimmed}${nextTrimmed.slice(overlap)}`.trim();
    }

    const joiner = shouldJoinWithoutSpace(previousTrimmed, nextTrimmed)
        ? ''
        : ' ';
    return `${previousTrimmed}${joiner}${nextTrimmed}`.trim();
}

function longestSuffixPrefixOverlap(left: string, right: string) {
    const maxLength = Math.min(left.length, right.length);

    for (let size = maxLength; size > 0; size -= 1) {
        if (left.slice(-size) === right.slice(0, size)) {
            return size;
        }
    }

    return 0;
}

function shouldJoinWithoutSpace(left: string, right: string) {
    return /[\s([{„"']$/.test(left) || /^[,.;:!?)}\]"'”]/.test(right);
}

function longestCommonPrefixLength(left: string, right: string) {
    const maxLength = Math.min(left.length, right.length);
    let index = 0;

    while (index < maxLength && left[index] === right[index]) {
        index += 1;
    }

    return index;
}

function timelineToneClass(entryTone: VoiceTimelineEntry['tone']) {
    if (entryTone === 'error') {
        return 'text-xs font-semibold text-red-300';
    }
    if (entryTone === 'accent') {
        return 'text-xs font-semibold text-cyan-300';
    }
    return 'text-xs font-semibold text-slate-300';
}
