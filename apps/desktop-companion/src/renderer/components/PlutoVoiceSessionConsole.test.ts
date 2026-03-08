import { describe, expect, it } from 'vitest';
import {
    appendVoiceTimelineEntry,
    createPcmChunkBlob,
    encodePcm16Chunk,
    getPlutoPcmMimeType,
    getVoiceConsolePrimaryAction,
    getVoiceTimelineLayout,
    mergeVoiceTimelineText,
    shouldMergeVoiceTimelineEntry,
} from './PlutoVoiceSessionConsole.js';

describe('getVoiceConsolePrimaryAction', () => {
    it('offers Take mic when the client is attached and the session mic is free', () => {
        expect(
            getVoiceConsolePrimaryAction({
                canRequestSpeaker: true,
                hasClient: true,
                hasSession: true,
                isRecording: false,
                isSpeaker: false,
                isTakingMic: false,
                streamState: 'connected',
            }),
        ).toEqual({
            disabled: false,
            label: 'Take mic',
            mode: 'take-mic',
        });
    });

    it('keeps Record disabled for observers while another speaker owns the mic', () => {
        expect(
            getVoiceConsolePrimaryAction({
                canRequestSpeaker: false,
                hasClient: true,
                hasSession: true,
                isRecording: false,
                isSpeaker: false,
                isTakingMic: false,
                streamState: 'connected',
            }),
        ).toEqual({
            disabled: true,
            label: 'Record',
            mode: 'record',
        });
    });
});

describe('PCM helpers', () => {
    it('formats the Pluto PCM mime type with the sample rate', () => {
        expect(getPlutoPcmMimeType(16_000)).toBe('audio/pcm;rate=16000');
    });

    it('encodes float samples as little-endian 16-bit PCM', () => {
        const encoded = encodePcm16Chunk(
            new Float32Array([-1, -0.5, 0, 0.5, 1]),
        );
        const view = new DataView(encoded);

        expect(view.getInt16(0, true)).toBe(-32768);
        expect(view.getInt16(2, true)).toBe(-16384);
        expect(view.getInt16(4, true)).toBe(0);
        expect(view.getInt16(6, true)).toBe(16384);
        expect(view.getInt16(8, true)).toBe(32767);
    });

    it('wraps PCM payloads in a blob with the expected Pluto mime type', async () => {
        const blob = createPcmChunkBlob(new Float32Array([0, 0.25]), 24_000);

        expect(blob.type).toBe('audio/pcm;rate=24000');

        const bytes = new Uint8Array(await blob.arrayBuffer());
        expect(bytes).toHaveLength(4);
    });
});

describe('getVoiceTimelineLayout', () => {
    it('right-aligns the local speaker bubble', () => {
        expect(getVoiceTimelineLayout('you', false)).toEqual({
            rowClass: 'flex justify-end',
            bubbleClass:
                'max-w-[80%] rounded-2xl px-4 py-3 border border-cyan-400/30 bg-cyan-500/15 text-right',
        });
    });

    it('keeps Pluto replies left-aligned in overlay mode', () => {
        expect(getVoiceTimelineLayout('pluto', true)).toEqual({
            rowClass: 'flex justify-start',
            bubbleClass:
                'max-w-[85%] rounded-2xl px-3 py-2 border border-white/10 bg-white/8',
        });
    });

    it('centers system notices', () => {
        expect(getVoiceTimelineLayout('system', false)).toEqual({
            rowClass: 'flex justify-center',
            bubbleClass:
                'max-w-[80%] rounded-2xl px-4 py-3 border border-white/8 bg-black/25 text-center',
        });
    });
});

describe('voice transcript streaming', () => {
    it('merges progressive Pluto transcript chunks into one bubble', () => {
        const started = appendVoiceTimelineEntry([], {
            actor: 'pluto',
            label: 'Pluto',
            text: 'Wie kann',
            tone: 'neutral',
        }, '2026-03-08T17:38:28.000Z');

        const updated = appendVoiceTimelineEntry(started, {
            actor: 'pluto',
            label: 'Pluto',
            text: 'Wie kann ich dir helfen?',
            tone: 'neutral',
        }, '2026-03-08T17:38:28.300Z');

        expect(updated).toHaveLength(1);
        expect(updated[0]?.text).toBe('Wie kann ich dir helfen?');
        expect(updated[0]?.id).toBe(started[0]?.id);
    });

    it('merges word-by-word Pluto chunks into one sentence bubble', () => {
        let timeline = appendVoiceTimelineEntry(
            [],
            {
                actor: 'pluto',
                label: 'Pluto',
                text: 'Texte',
                tone: 'neutral',
            },
            '2026-03-08T17:38:28.000Z',
        );

        for (const [index, text] of [
            'übersetzen',
            'oder',
            'kreative',
            'Inhalte',
            'erstellen.',
        ].entries()) {
            timeline = appendVoiceTimelineEntry(
                timeline,
                {
                    actor: 'pluto',
                    label: 'Pluto',
                    text,
                    tone: 'neutral',
                },
                `2026-03-08T17:38:28.${100 + index}00Z`,
            );
        }

        expect(timeline).toHaveLength(1);
        expect(timeline[0]?.text).toBe(
            'Texte übersetzen oder kreative Inhalte erstellen.',
        );
    });

    it('merges delayed Pluto continuation chunks when the previous text is unfinished', () => {
        const started = appendVoiceTimelineEntry(
            [],
            {
                actor: 'pluto',
                label: 'Pluto',
                text: 'Ich kann dir bei der Planung helfen. Gibt',
                tone: 'neutral',
                turnId: 1,
            },
            '2026-03-08T18:23:52.000Z',
        );

        const updated = appendVoiceTimelineEntry(
            started,
            {
                actor: 'pluto',
                label: 'Pluto',
                text: 'es einen bestimmten Bereich, in dem du Hilfe benötigst?',
                tone: 'neutral',
                turnId: 1,
            },
            '2026-03-08T18:23:55.000Z',
        );

        expect(updated).toHaveLength(1);
        expect(updated[0]?.text).toBe(
            'Ich kann dir bei der Planung helfen. Gibt es einen bestimmten Bereich, in dem du Hilfe benötigst?',
        );
    });

    it('keeps Pluto chunks from different turns in separate bubbles', () => {
        const started = appendVoiceTimelineEntry(
            [],
            {
                actor: 'pluto',
                label: 'Pluto',
                text: 'Erste Antwort.',
                tone: 'neutral',
                turnId: 1,
            },
            '2026-03-08T18:23:52.000Z',
        );

        const updated = appendVoiceTimelineEntry(
            started,
            {
                actor: 'pluto',
                label: 'Pluto',
                text: 'Zweite Antwort.',
                tone: 'neutral',
                turnId: 2,
            },
            '2026-03-08T18:23:52.400Z',
        );

        expect(updated).toHaveLength(2);
        expect(updated[0]?.text).toBe('Erste Antwort.');
        expect(updated[1]?.text).toBe('Zweite Antwort.');
    });

    it('does not merge system notices into one bubble stream', () => {
        expect(
            shouldMergeVoiceTimelineEntry(
                {
                    actor: 'system',
                    label: 'Status',
                    text: 'Pluto is listening.',
                    tone: 'neutral',
                    createdAt: '2026-03-08T17:38:28.000Z',
                    turnId: undefined,
                },
                {
                    actor: 'system',
                    label: 'Status',
                    text: 'Pluto is responding.',
                    tone: 'neutral',
                },
                '2026-03-08T17:38:28.400Z',
            ),
        ).toBe(false);
    });

    it('starts a new bubble when the text is unrelated', () => {
        const started = appendVoiceTimelineEntry([], {
            actor: 'you',
            label: 'You',
            text: 'Hallo Pluto',
            tone: 'accent',
        }, '2026-03-08T17:38:28.000Z');

        const nextTurn = appendVoiceTimelineEntry(started, {
            actor: 'you',
            label: 'You',
            text: 'Öffne bitte Safari',
            tone: 'accent',
        }, '2026-03-08T17:38:40.000Z');

        expect(nextTurn).toHaveLength(2);
    });

    it('keeps appending a streamed user message even when status events appear in between', () => {
        let timeline = appendVoiceTimelineEntry(
            [],
            {
                actor: 'you',
                label: 'You',
                text: 'rede',
                tone: 'accent',
            },
            '2026-03-08T18:07:10.000Z',
        );

        timeline = appendVoiceTimelineEntry(
            timeline,
            {
                actor: 'system',
                label: 'Status',
                text: 'Pluto is listening.',
                tone: 'neutral',
            },
            '2026-03-08T18:07:10.100Z',
        );

        timeline = appendVoiceTimelineEntry(
            timeline,
            {
                actor: 'you',
                label: 'You',
                text: 'rede einfach mit dir.',
                tone: 'accent',
            },
            '2026-03-08T18:07:10.200Z',
        );

        expect(timeline).toHaveLength(2);
        expect(timeline[0]?.text).toBe('rede einfach mit dir.');
        expect(timeline[1]?.text).toBe('Pluto is listening.');
    });
});

describe('mergeVoiceTimelineText', () => {
    it('keeps the longer progressive transcript when the next chunk is a prefix extension', () => {
        expect(mergeVoiceTimelineText('Wie kann', 'Wie kann ich helfen?')).toBe(
            'Wie kann ich helfen?',
        );
    });

    it('concatenates non-overlapping word chunks with spacing', () => {
        expect(mergeVoiceTimelineText('Texte', 'übersetzen')).toBe(
            'Texte übersetzen',
        );
    });
});
