import { describe, expect, it } from 'vitest';
import {
    plutoVoiceSessionStreamClientMessageSchema,
    plutoVoiceSessionStreamEventSchema,
} from './schemas.js';

describe('plutoVoiceSessionStreamClientMessageSchema', () => {
    it('parses text input messages for live Pluto sessions', () => {
        expect(
            plutoVoiceSessionStreamClientMessageSchema.parse({
                type: 'text_input',
                input: {
                    clientId: 'desktop-client',
                    text: 'Hallo Pluto',
                },
            }),
        ).toEqual({
            type: 'text_input',
            input: {
                clientId: 'desktop-client',
                text: 'Hallo Pluto',
            },
        });
    });
});

describe('plutoVoiceSessionStreamEventSchema', () => {
    it('parses output audio events with turn ids', () => {
        expect(
            plutoVoiceSessionStreamEventSchema.parse({
                type: 'audio_chunk',
                turnId: 3,
                audioBase64: 'Zm9v',
                mimeType: 'audio/pcm;rate=24000',
            }),
        ).toEqual({
            type: 'audio_chunk',
            turnId: 3,
            audioBase64: 'Zm9v',
            mimeType: 'audio/pcm;rate=24000',
        });
    });

    it('parses output turn completion events', () => {
        expect(
            plutoVoiceSessionStreamEventSchema.parse({
                type: 'output_turn_complete',
                turnId: 4,
            }),
        ).toEqual({
            type: 'output_turn_complete',
            turnId: 4,
        });
    });
});
