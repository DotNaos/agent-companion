import { describe, expect, it } from 'vitest';
import {
    isPointInsidePlutoAvatar,
    shouldOverlayIgnoreMouseEvents,
} from './overlay-hit-test.js';

describe('overlay hit testing', () => {
    const bounds = { x: 1000, y: 700, width: 248, height: 248 };

    it('treats the avatar center as clickable', () => {
        expect(
            isPointInsidePlutoAvatar(bounds, { x: 1126, y: 818 }),
        ).toBe(true);
    });

    it('ignores cursor positions outside the avatar circle', () => {
        expect(
            isPointInsidePlutoAvatar(bounds, { x: 1005, y: 705 }),
        ).toBe(false);
    });

    it('always captures mouse events while an approval bubble is visible', () => {
        expect(
            shouldOverlayIgnoreMouseEvents({
                bounds,
                cursorPoint: { x: 1005, y: 705 },
                hasApprovalBubble: true,
            }),
        ).toBe(false);
    });
});
