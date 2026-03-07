import { describe, expect, it } from 'vitest';
import {
    buildGenerateContentParts,
    buildLiveTurn,
    resolvePlutoTextModel,
} from './pluto.js';

describe('buildLiveTurn', () => {
    it('creates a user turn with text only', () => {
        expect(buildLiveTurn('Hallo Pluto')).toEqual([
            {
                role: 'user',
                parts: [{ text: 'Hallo Pluto' }],
            },
        ]);
    });

    it('adds inline image data when provided', () => {
        expect(
            buildLiveTurn('Was siehst du?', {
                data: 'ZmFrZQ==',
                mimeType: 'image/jpeg',
            }),
        ).toEqual([
            {
                role: 'user',
                parts: [
                    { text: 'Was siehst du?' },
                    {
                        inlineData: {
                            data: 'ZmFrZQ==',
                            mimeType: 'image/jpeg',
                        },
                    },
                ],
            },
        ]);
    });

    it('falls back to a text model for native audio previews', () => {
        expect(
            resolvePlutoTextModel(
                'models/gemini-2.5-flash-native-audio-preview-12-2025',
            ),
        ).toBe('gemini-2.5-flash');
    });

    it('builds multimodal generateContent parts', () => {
        expect(
            buildGenerateContentParts('Beschreibe das Bild', {
                data: 'ZmFrZQ==',
                mimeType: 'image/jpeg',
            }),
        ).toEqual([
            {
                inlineData: {
                    data: 'ZmFrZQ==',
                    mimeType: 'image/jpeg',
                },
            },
            'Beschreibe das Bild',
        ]);
    });
});
