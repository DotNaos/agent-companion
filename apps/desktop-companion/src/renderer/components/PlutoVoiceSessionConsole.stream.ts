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
            });
            return;
        case 'output_transcription':
            setActiveStatusMessage('Pluto is speaking…');
            appendTimelineEntry({
                actor: 'pluto',
                label: 'Pluto',
                text: event.text,
                tone: 'neutral',
                turnId: event.turnId,
            });
            return;
        case 'audio_chunk':
            setActiveStatusMessage('Pluto is speaking…');
            enqueueIncomingAudioChunk(
                event.turnId,
                event.audioBase64,
                event.mimeType,
            );
            return;
        case 'output_turn_complete':
            setActiveStatusMessage('Pluto finished this response.');
            markOutputTurnComplete(event.turnId);
            return;
        case 'status':
            if (event.interrupted) {
                stopPlayback();
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

function describeStatusEvent(
    event: Extract<PlutoVoiceSessionStreamEvent, { type: 'status' }>,
) {
    if (event.waitingForInput) {
        return 'Pluto is waiting for the next turn.';
    }
    if (event.interrupted) {
        return 'Pluto was interrupted.';
    }
    if (event.status === 'listening') {
        return 'Pluto is listening.';
    }
    if (event.status === 'responding') {
        return 'Pluto is responding.';
    }
    if (event.status === 'error') {
        return 'Pluto hit an error.';
    }
    return 'Pluto is idle.';
}
