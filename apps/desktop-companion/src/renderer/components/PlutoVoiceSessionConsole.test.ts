import { describe, expect, it } from 'vitest';
import { getVoiceConsolePrimaryAction } from './PlutoVoiceSessionConsole.js';

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
