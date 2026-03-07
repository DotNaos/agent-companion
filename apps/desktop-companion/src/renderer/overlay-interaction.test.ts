import { describe, expect, it } from 'vitest';
import { isOverlayInteractiveTarget } from './overlay-interaction.js';

describe('isOverlayInteractiveTarget', () => {
    it('treats the Pluto avatar hit target as interactive', () => {
        const target = {
            closest: (selector: string) =>
                selector.includes('.pluto-hit-target') ? {} : null,
        } as unknown as EventTarget;

        expect(isOverlayInteractiveTarget(target)).toBe(true);
    });

    it('ignores passive Pluto bubbles so clicks pass through', () => {
        const target = {
            closest: () => null,
        } as unknown as EventTarget;

        expect(isOverlayInteractiveTarget(target)).toBe(false);
    });
});
