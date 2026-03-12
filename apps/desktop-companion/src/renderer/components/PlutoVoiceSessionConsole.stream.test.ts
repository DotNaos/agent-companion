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
    const setRemoteSpeechActive = vi.fn();
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
        setRemoteSpeechActive,
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
            'Codex uses run_command…',
        );
        expect(harness.timeline).toEqual([
            {
                actor: 'system',
                label: 'Tool',
                text: 'Calling run_command',
                details: '/Users/oli $ moodle list timetable --json',
                tone: 'accent',
            },
        ]);
    });

    it('renders Codex reasoning in the chat timeline only', () => {
        const harness = createHarness();

        handlePlutoStreamEvent({
            event: {
                type: 'tool_result',
                toolName: 'codex_reasoning',
                summary: 'I should inspect the existing Moodle CLI skill before acting.',
                ok: true,
                toolCallId: 'reason-1',
            },
            ...harness,
        });

        expect(harness.timeline).toEqual([
            {
                actor: 'system',
                label: 'Reasoning',
                text: 'I should inspect the existing Moodle CLI skill before acting.',
                tone: 'neutral',
                overlayBubble: false,
            },
        ]);
    });

    it('renders spoken Pluto output separately from the Codex transcript', () => {
        const harness = createHarness();

        handlePlutoStreamEvent({
            event: {
                type: 'tool_result',
                toolName: 'speak_to_user',
                summary: 'Ich habe den Stundenplan geladen und lese ihn dir jetzt vor.',
                ok: true,
                toolCallId: 'speech-1',
            },
            ...harness,
        });

        expect(harness.setActiveStatusMessage).toHaveBeenCalledWith(
            'Pluto is speaking…',
        );
        expect(harness.setRemoteSpeechActive).toHaveBeenCalledWith(true);
        expect(harness.timeline).toEqual([
            {
                actor: 'pluto',
                label: 'Pluto',
                text: 'Ich habe den Stundenplan geladen und lese ihn dir jetzt vor.',
                tone: 'neutral',
                overlayBubble: true,
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
        expect(harness.setRemoteSpeechActive).toHaveBeenCalledWith(false);
        expect(harness.setActiveStatusMessage).toHaveBeenCalledWith(
            'The current response was interrupted.',
        );
    });
});
