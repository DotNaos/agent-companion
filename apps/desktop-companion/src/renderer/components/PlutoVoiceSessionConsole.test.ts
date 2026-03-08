import { describe, expect, it } from 'vitest';
import {
    createPcmChunkBlob,
    encodePcm16Chunk,
    getPlutoPcmMimeType,
    getVoiceConsolePrimaryAction,
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
