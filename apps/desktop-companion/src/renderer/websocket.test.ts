import { describe, expect, it } from 'vitest';
import { parseJsonWebSocketData } from './websocket.js';

describe('parseJsonWebSocketData', () => {
    it('parses string payloads', async () => {
        await expect(
            parseJsonWebSocketData<{ type: string }>(
                '{"type":"bootstrap"}',
            ),
        ).resolves.toEqual({ type: 'bootstrap' });
    });

    it('parses Blob payloads', async () => {
        await expect(
            parseJsonWebSocketData<{ type: string }>(
                new Blob(['{"type":"bootstrap"}'], {
                    type: 'application/json',
                }),
            ),
        ).resolves.toEqual({ type: 'bootstrap' });
    });

    it('parses ArrayBuffer payloads', async () => {
        const buffer = new TextEncoder().encode('{"type":"bootstrap"}')
            .buffer;

        await expect(
            parseJsonWebSocketData<{ type: string }>(buffer),
        ).resolves.toEqual({ type: 'bootstrap' });
    });

    it('parses typed array payloads', async () => {
        const bytes = new TextEncoder().encode('{"type":"bootstrap"}');

        await expect(
            parseJsonWebSocketData<{ type: string }>(bytes),
        ).resolves.toEqual({ type: 'bootstrap' });
    });
});