import { describe, expect, it } from 'vitest';
import { getTakeMicButtonState } from './DashboardView.js';

describe('getTakeMicButtonState', () => {
    it('keeps Take mic visible but disabled while another speaker owns the mic', () => {
        expect(
            getTakeMicButtonState({
                isBusy: false,
                isCurrentSpeaker: false,
                isSpeakerOccupiedByOtherClient: true,
                plutoAvailable: true,
            }),
        ).toEqual({
            disabled: true,
            title: 'Available when the current speaker releases the mic.',
            visible: true,
        });
    });

    it('enables Take mic when the observer can become speaker', () => {
        expect(
            getTakeMicButtonState({
                isBusy: false,
                isCurrentSpeaker: false,
                isSpeakerOccupiedByOtherClient: false,
                plutoAvailable: true,
            }),
        ).toEqual({
            disabled: false,
            title: undefined,
            visible: true,
        });
    });

    it('hides Take mic for the current speaker', () => {
        expect(
            getTakeMicButtonState({
                isBusy: false,
                isCurrentSpeaker: true,
                isSpeakerOccupiedByOtherClient: false,
                plutoAvailable: true,
            }),
        ).toEqual({
            disabled: true,
            title: undefined,
            visible: false,
        });
    });
});
