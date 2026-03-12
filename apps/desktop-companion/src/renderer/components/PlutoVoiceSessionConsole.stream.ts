import type {
    PlutoVoiceSession,
    PlutoVoiceSessionStreamEvent,
} from '@agent-companion/shared';
import type { Dispatch, SetStateAction } from 'react';
import type {
    StreamState,
    VoiceTimelineEntry,
} from './PlutoVoiceSessionConsole.shared.js';

export function buildSessionStreamUrl(
    apiBase: string,
    sessionId: string,
    desktopToken?: string,
) {
    const streamUrl = new URL(
        `${apiBase}/pluto/sessions/${encodeURIComponent(sessionId)}/stream`,
        globalThis.location.origin,
    );
    if (desktopToken && apiBase === '/api/desktop') {
        streamUrl.searchParams.set('desktopToken', desktopToken);
    }
    streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return streamUrl.toString();
}

export function shouldReportUnexpectedDisconnect({
    intentionalClose,
    sawTerminalEvent,
    sawTransportError,
    wasClean,
}: Readonly<{
    intentionalClose: boolean;
    sawTerminalEvent: boolean;
    sawTransportError: boolean;
    wasClean: boolean;
}>) {
    if (intentionalClose || sawTerminalEvent) {
        return false;
    }

    return sawTransportError || !wasClean;
}

export function handlePlutoStreamEvent({
    event,
    appendTimelineEntry,
    cleanupAudioCapture,
    enqueueIncomingAudioChunk,
    markOutputTurnComplete,
    publishError,
    setRemoteSpeechActive,
    setActiveStatusMessage,
    setSession,
    setStreamState,
    stopPlayback,
    streamTerminalEventRef,
}: Readonly<{
    event: PlutoVoiceSessionStreamEvent;
    appendTimelineEntry: (
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) => void;
    cleanupAudioCapture: () => void;
    enqueueIncomingAudioChunk: (
        turnId: number,
        base64: string,
        mimeType: string,
    ) => void;
    markOutputTurnComplete: (turnId: number) => void;
    publishError: (message: string) => void;
    setRemoteSpeechActive: Dispatch<SetStateAction<boolean>>;
    setActiveStatusMessage: Dispatch<SetStateAction<string | null>>;
    setSession: Dispatch<SetStateAction<PlutoVoiceSession | null>>;
    setStreamState: Dispatch<SetStateAction<StreamState>>;
    stopPlayback: () => void;
    streamTerminalEventRef: { current: 'error' | 'closed' | null };
}>) {
    switch (event.type) {
        case 'session_snapshot':
        case 'session_updated':
            setSession(event.session);
            return;
        case 'input_transcription':
            setActiveStatusMessage(null);
            appendTimelineEntry({
                actor: 'you',
                label: 'You',
                text: event.text,
                tone: 'accent',
                turnId: event.turnId,
            });
            return;
        case 'output_transcription':
            setActiveStatusMessage('Codex is responding…');
            appendTimelineEntry({
                actor: 'pluto',
                label: 'Codex',
                text: event.text,
                tone: 'neutral',
                turnId: event.turnId,
                overlayBubble: false,
            });
            return;
        case 'audio_chunk':
            setActiveStatusMessage('Pluto is speaking…');
            setRemoteSpeechActive(true);
            enqueueIncomingAudioChunk(
                event.turnId,
                event.audioBase64,
                event.mimeType,
            );
            return;
        case 'output_turn_complete':
            setActiveStatusMessage('Codex finished this response.');
            setRemoteSpeechActive(false);
            markOutputTurnComplete(event.turnId);
            return;
        case 'tool_call':
            if (event.toolName === 'speak_to_user') {
                setActiveStatusMessage('Pluto is preparing speech…');
                return;
            }
            setActiveStatusMessage(`Codex uses ${event.toolName}…`);
            appendTimelineEntry(buildToolEntry(event.toolName, event.summary, true));
            return;
        case 'tool_result':
            if (event.toolName === 'codex_reasoning' && event.ok) {
                appendTimelineEntry({
                    actor: 'system',
                    label: 'Reasoning',
                    text: event.summary,
                    tone: 'neutral',
                    overlayBubble: false,
                });
                return;
            }
            if (event.toolName === 'speak_to_user' && event.ok) {
                setActiveStatusMessage('Pluto is speaking…');
                setRemoteSpeechActive(true);
                appendTimelineEntry({
                    actor: 'pluto',
                    label: 'Pluto',
                    text: event.summary,
                    tone: 'neutral',
                    overlayBubble: true,
                });
                return;
            }
            setActiveStatusMessage(
                event.ok
                    ? `${event.toolName} finished.`
                    : `${event.toolName} failed.`,
            );
            appendTimelineEntry(buildToolEntry(event.toolName, event.summary, false, event.ok));
            return;
        case 'approval_requested':
            setActiveStatusMessage(
                `Approval needed for ${event.toolName}.`,
            );
            appendTimelineEntry({
                actor: 'system',
                label: 'Approval',
                text: `${event.summary} Approve it in the desktop overlay to let Pluto continue.`,
                tone: 'accent',
            });
            return;
        case 'approval_resolved':
            setActiveStatusMessage(
                event.decision === 'approved'
                    ? `${event.toolName} approved.`
                    : `${event.toolName} denied.`,
            );
            appendTimelineEntry({
                actor: 'system',
                label: 'Approval',
                text:
                    event.decision === 'approved'
                        ? `Approval granted for ${event.toolName}. Codex continues.`
                        : `Approval denied for ${event.toolName}. Codex cannot continue with that action.`,
                tone: event.decision === 'approved' ? 'accent' : 'error',
            });
            return;
        case 'status':
            if (event.interrupted) {
                stopPlayback();
                setRemoteSpeechActive(false);
            }
            if (event.status === 'idle') {
                setRemoteSpeechActive(false);
            }
            setActiveStatusMessage(describeStatusEvent(event));
            setSession((current) =>
                current
                    ? {
                          ...current,
                          status: event.status,
                      }
                    : current,
            );
            return;
        case 'error':
            streamTerminalEventRef.current = 'error';
            stopPlayback();
            setRemoteSpeechActive(false);
            setActiveStatusMessage('Pluto hit an error.');
            appendTimelineEntry({
                actor: 'system',
                label: 'Error',
                text: event.message,
                tone: 'error',
            });
            publishError(event.message);
            return;
        case 'closed':
            streamTerminalEventRef.current = 'closed';
            stopPlayback();
            setRemoteSpeechActive(false);
            setActiveStatusMessage(event.reason ?? 'Session closed.');
            appendTimelineEntry({
                actor: 'system',
                label: 'Closed',
                text: event.reason ?? 'Session closed.',
                tone: 'neutral',
            });
            setStreamState('closed');
            cleanupAudioCapture();
            return;
    }
}

function buildToolEntry(
    toolName: string,
    summary: string,
    isCall: boolean,
    ok = true,
): Omit<VoiceTimelineEntry, 'id' | 'createdAt'> {
    return {
        actor: 'system' as const,
        label: ok ? 'Tool' : 'Tool error',
        text: buildCompactToolText(toolName, summary, isCall, ok),
        details: summary,
        tone: isCall ? 'accent' : ok ? 'neutral' : 'error',
    };
}

function buildCompactToolText(
    toolName: string,
    summary: string,
    isCall: boolean,
    ok: boolean,
) {
    if (toolName === 'codex_command') {
        return isCall ? 'Running command' : ok ? 'Command finished' : 'Command failed';
    }
    if (toolName === 'codex_patch') {
        return isCall ? 'Applying file changes' : ok ? 'File changes finished' : 'File changes failed';
    }
    return isCall
        ? `Calling ${toolName}`
        : ok
          ? `${toolName} finished`
          : `${toolName} failed`;
}

function describeStatusEvent(
    event: Extract<PlutoVoiceSessionStreamEvent, { type: 'status' }>,
) {
    if (event.waitingForInput) {
        return 'Codex is waiting for the next turn.';
    }
    if (event.interrupted) {
        return 'The current response was interrupted.';
    }
    if (event.status === 'listening') {
        return 'Pluto is listening.';
    }
    if (event.status === 'responding') {
        return 'Codex is responding.';
    }
    if (event.status === 'error') {
        return 'Codex hit an error.';
    }
    return 'Pluto is idle.';
}
