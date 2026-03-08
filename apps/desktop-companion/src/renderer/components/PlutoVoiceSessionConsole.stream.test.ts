import { describe, expect, it, vi } from 'vitest';
import type {
    VoiceTimelineEntry
} from './PlutoVoiceSessionConsole.shared.js';
import { handlePlutoStreamEvent } from './PlutoVoiceSessionConsole.stream.js';

function createHarness() {
    const timeline: Array<Omit<VoiceTimelineEntry, 'id' | 'createdAt'>> = [];
    const appendTimelineEntry = vi.fn((entry) => {
        timeline.push(entry);
    });
    const setActiveStatusMessage = vi.fn();
    const setSession = vi.fn();
    const setStreamState = vi.fn();
    const stopPlayback = vi.fn();
    const cleanupAudioCapture = vi.fn();
    const enqueueIncomingAudioChunk = vi.fn();
    const markOutputTurnComplete = vi.fn();
    const publishError = vi.fn();
    const streamTerminalEventRef = {
        current: null as 'error' | 'closed' | null,
    };

    return {
        timeline,
        appendTimelineEntry,
        setActiveStatusMessage,
        setSession,
        setStreamState,
        stopPlayback,
        cleanupAudioCapture,
        enqueueIncomingAudioChunk,
        markOutputTurnComplete,
        publishError,
        streamTerminalEventRef,
    };
}

describe('handlePlutoStreamEvent', () => {
    it('adds a visible timeline entry for tool calls', () => {
        const harness = createHarness();

        handlePlutoStreamEvent({
            event: {
                type: 'tool_call',
                toolName: 'run_command',
                summary: '/Users/oli $ moodle list timetable --json',
                toolCallId: 'call-1',
            },
            ...harness,
        });

        expect(harness.setActiveStatusMessage).toHaveBeenCalledWith(
            'Pluto uses run_command…',
        );
        expect(harness.timeline).toEqual([
            {
                actor: 'system',
                label: 'Tool',
                text: 'Calling run_command: /Users/oli $ moodle list timetable --json',
                tone: 'accent',
            },
        ]);
    });

    it('adds an approval notice entry for Pluto-triggered approvals', () => {
        const harness = createHarness();

        handlePlutoStreamEvent({
            event: {
                type: 'approval_requested',
                approvalId: 'approval-1',
                toolName: 'run_command',
                summary: 'run_command needs approval for moodle list timetable --json',
            },
            ...harness,
        });

        expect(harness.setActiveStatusMessage).toHaveBeenCalledWith(
            'Approval needed for run_command.',
        );
        expect(harness.timeline[0]).toMatchObject({
            label: 'Approval',
            tone: 'accent',
        });
        expect(harness.timeline[0]?.text).toContain(
            'Approve it in the desktop overlay',
        );
    });

    it('stops playback immediately when the server reports an interruption', () => {
        const harness = createHarness();

        handlePlutoStreamEvent({
            event: {
                type: 'status',
                status: 'idle',
                interrupted: true,
            },
            ...harness,
        });

        expect(harness.stopPlayback).toHaveBeenCalledTimes(1);
        expect(harness.setActiveStatusMessage).toHaveBeenCalledWith(
            'Pluto was interrupted.',
        );
    });
});
