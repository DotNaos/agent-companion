import { describe, expect, it } from 'vitest';
import { plutoVoiceSessionStreamClientMessageSchema } from './schemas.js';

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
