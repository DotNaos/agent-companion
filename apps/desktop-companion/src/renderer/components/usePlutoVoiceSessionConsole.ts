import type {
    PlutoVoiceSession,
    PlutoVoiceSessionStreamEvent,
} from '@agent-companion/shared';
import { plutoVoiceSessionStreamEventSchema } from '@agent-companion/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseJsonWebSocketData } from '../websocket.js';
import { usePlutoVoicePlayback } from './PlutoVoiceSessionConsole.audio.js';
import {
    getLiveMicFeedback,
    getRecordingHint,
    getRoleStatus,
    getVoiceChatInputPlaceholder,
    getVoiceConsolePrimaryAction,
} from './PlutoVoiceSessionConsole.controls.js';
import { usePlutoAudioDevices } from './PlutoVoiceSessionConsole.devices.js';
import {
    sendPlutoAudioChunk,
    stopPlutoRecording,
    togglePlutoRecording,
} from './PlutoVoiceSessionConsole.recording.js';
import type {
    PlutoAudioCapture,
    PlutoVoiceSessionConsoleProps,
    RecordingMode,
    StreamState,
    VoiceConsoleInlineNotice,
    VoiceTimelineDraftEntry,
    VoiceTimelineEntry,
} from './PlutoVoiceSessionConsole.shared.js';
import {
    buildSessionStreamUrl,
    handlePlutoStreamEvent,
    shouldReportUnexpectedDisconnect,
} from './PlutoVoiceSessionConsole.stream.js';
import { appendVoiceTimelineEntry } from './PlutoVoiceSessionConsole.timeline.js';

const AUTO_SCROLL_THRESHOLD_PX = 160;
const AUTO_SCROLL_DURATION_MS = 180;
const MIC_LEVEL_UPDATE_INTERVAL_MS = 80;
const MIC_LEVEL_DELTA_THRESHOLD = 0.035;

export function usePlutoVoiceSessionConsole({
    apiBase,
    clientId,
    desktopToken,
    onError,
    onInfo,
    onRequestSpeaker,
    sessionId,
    sessions,
    variant = 'panel',
}: PlutoVoiceSessionConsoleProps) {
    const [streamState, setStreamState] = useState<StreamState>('idle');
    const [session, setSession] = useState<PlutoVoiceSession | null>(null);
    const [timeline, setTimeline] = useState<VoiceTimelineEntry[]>([]);
    const [isChatExpanded, setIsChatExpanded] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(
        null,
    );
    const [activeStatusMessage, setActiveStatusMessage] = useState<
        string | null
    >(null);
    const [micLevel, setMicLevel] = useState(0);
    const [textDraft, setTextDraft] = useState('');
    const [inlineNotice, setInlineNotice] = useState<
        VoiceConsoleInlineNotice | null
    >(null);
    const [isTakingMic, setIsTakingMic] = useState(false);

    const socketRef = useRef<WebSocket | null>(null);
    const audioCaptureRef = useRef<PlutoAudioCapture | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const micMonitorAnimationFrameRef = useRef<number | null>(null);
    const micMonitorContextRef = useRef<AudioContext | null>(null);
    const micMonitorSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const panelScrollAreaRef = useRef<HTMLDivElement | null>(null);
    const expandedScrollAreaRef = useRef<HTMLDivElement | null>(null);
    const panelScrollAnimationFrameRef = useRef<number | null>(null);
    const expandedScrollAnimationFrameRef = useRef<number | null>(null);
    const lastCommittedMicLevelRef = useRef(0);
    const lastMicLevelCommitAtRef = useRef(0);
    const intentionalSocketCloseRef = useRef(false);
    const transportErrorRef = useRef(false);
    const streamTerminalEventRef = useRef<'error' | 'closed' | null>(null);

    const selectedSummary = useMemo(
        () => sessions.find((entry) => entry.id === sessionId) ?? null,
        [sessionId, sessions],
    );
    const activeSession = session ?? null;
    const isSpeaker =
        Boolean(clientId) && activeSession?.speakerClientId === clientId;
    const isOverlay = variant === 'overlay';
    const currentSpeakerClientId =
        activeSession?.speakerClientId ??
        selectedSummary?.speakerClientId ??
        null;
    const canRequestSpeaker = Boolean(
        onRequestSpeaker &&
            sessionId &&
            clientId &&
            !isSpeaker &&
            !currentSpeakerClientId,
    );

    const publishInfo = (message: string) => {
        setInlineNotice({ tone: 'accent', message });
        onInfo(message);
    };
    const publishError = (message: string) => {
        setInlineNotice({ tone: 'error', message });
        onError(message);
    };

    const audioDevices = usePlutoAudioDevices({ isRecording, onInfo: publishInfo });
    const playback = usePlutoVoicePlayback({ selectedOutputId: audioDevices.selectedOutputId, onInfo });

    const recordingHint = getRecordingHint(
        isSpeaker,
        Boolean(sessionId),
        canRequestSpeaker,
        isOverlay,
    );
    const visibleTimeline = isOverlay ? timeline.slice(-4) : timeline;
    const roleStatus = getRoleStatus({
        isSpeaker,
        hasClient: Boolean(clientId),
        hasSession: Boolean(sessionId),
        hasSpeaker: Boolean(currentSpeakerClientId),
        canRequestSpeaker,
        isOverlay,
    });
    const liveMicFeedback = getLiveMicFeedback(micLevel);
    const primaryAction = getVoiceConsolePrimaryAction({
        canRequestSpeaker,
        hasClient: Boolean(clientId),
        hasSession: Boolean(sessionId),
        isRecording,
        isSpeaker,
        isTakingMic,
        streamState,
    });
    const inputPlaceholder = getVoiceChatInputPlaceholder({
        hasClient: Boolean(clientId),
        hasSession: Boolean(sessionId),
        isSpeaker,
    });
    const visibleTimelineTailKey = buildTimelineTailKey(visibleTimeline);
    const fullTimelineTailKey = buildTimelineTailKey(timeline);

    useEffect(() => {
        setSession(null);
        setTimeline([]);
        setActiveStatusMessage(null);
        intentionalSocketCloseRef.current = false;
        transportErrorRef.current = false;
        streamTerminalEventRef.current = null;

        if (!sessionId) {
            setStreamState('idle');
            cleanupAudioCapture();
            return undefined;
        }

        const socket = new WebSocket(
            buildSessionStreamUrl(apiBase, sessionId, desktopToken),
        );
        socketRef.current = socket;
        setStreamState('connecting');

        socket.addEventListener('open', () => {
            setStreamState('connected');
            transportErrorRef.current = false;
        });

        socket.addEventListener('message', (event) => {
            void (async () => {
                const payload = await parseJsonWebSocketData<unknown>(
                    event.data,
                );
                const parsed =
                    plutoVoiceSessionStreamEventSchema.safeParse(payload);
                if (!parsed.success) {
                    return;
                }
                handleStreamEvent(parsed.data);
            })().catch((parseError) => {
                console.warn(
                    'Failed to parse Pluto voice session stream message.',
                    parseError,
                );
            });
        });

        socket.addEventListener('close', (event) => {
            setStreamState('closed');
            cleanupAudioCapture();

            if (
                shouldReportUnexpectedDisconnect({
                    intentionalClose: intentionalSocketCloseRef.current,
                    sawTerminalEvent: streamTerminalEventRef.current !== null,
                    sawTransportError: transportErrorRef.current,
                    wasClean: event.wasClean,
                })
            ) {
                const reason = event.reason.trim();
                onError(
                    reason ||
                        'Pluto session stream disconnected unexpectedly.',
                );
            }
        });

        socket.addEventListener('error', () => {
            transportErrorRef.current = true;
        });

        return () => {
            intentionalSocketCloseRef.current = true;
            cleanupAudioCapture();
            socketRef.current = null;
            socket.close();
        };
    }, [apiBase, desktopToken, onError, sessionId]);

    useEffect(() => {
        if (!visibleTimelineTailKey && !fullTimelineTailKey) {
            return;
        }

        const frame = globalThis.requestAnimationFrame(() => {
            const panelViewport = getScrollViewport(panelScrollAreaRef.current);
            smoothScrollViewportToBottom(
                panelViewport,
                panelScrollAnimationFrameRef,
            );

            if (isChatExpanded) {
                const expandedViewport = getScrollViewport(
                    expandedScrollAreaRef.current,
                );
                smoothScrollViewportToBottom(
                    expandedViewport,
                    expandedScrollAnimationFrameRef,
                );
            }
        });

        return () => {
            globalThis.cancelAnimationFrame(frame);
        };
    }, [fullTimelineTailKey, isChatExpanded, visibleTimelineTailKey]);

    const appendTimelineEntry = (entry: VoiceTimelineDraftEntry) =>
        setTimeline((current) => appendVoiceTimelineEntry(current, entry));

    const appendStandaloneTimelineEntry = (entry: VoiceTimelineDraftEntry) => {
        setTimeline((current) => {
            const nextEntry: VoiceTimelineEntry = {
                ...entry,
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
            };
            return [...current, nextEntry].slice(-30);
        });
    };

    const stopRecording = () => {
        stopPlutoRecording(audioCaptureRef, appendTimelineEntry, recordingMode);
        setRecordingMode(null);
    };

    const cleanupAudioCapture = () => {
        const capture = audioCaptureRef.current;
        if (capture) {
            capture.stop();
        }
        stopMicMonitor();
        stopMediaStream();
        setIsRecording(false);
        setRecordingMode(null);
    };

    const handleStreamEvent = (event: PlutoVoiceSessionStreamEvent) => {
        handlePlutoStreamEvent({
            event,
            appendTimelineEntry,
            cleanupAudioCapture,
            enqueueIncomingAudioChunk: playback.enqueueIncomingAudioChunk,
            markOutputTurnComplete: playback.markOutputTurnComplete,
            publishError,
            setActiveStatusMessage,
            setSession,
            setStreamState,
            stopPlayback: playback.stopPlayback,
            streamTerminalEventRef,
        });
    };

    async function sendTextTurn(text: string) {
        if (!sessionId || !clientId) {
            publishError('Join the active Pluto session before sending text.');
            return false;
        }

        if (!isSpeaker) {
            publishError('Take the mic before sending text to Pluto.');
            return false;
        }

        if (socketRef.current?.readyState !== WebSocket.OPEN) {
            publishError('The Pluto session stream is not connected yet.');
            return false;
        }

        playback.stopPlayback();
        setActiveStatusMessage('Interrupting Pluto and sending your text…');

        appendStandaloneTimelineEntry({
            actor: 'you',
            label: 'You',
            text,
            tone: 'accent',
        });

        socketRef.current.send(
            JSON.stringify({
                type: 'text_input',
                input: {
                    clientId,
                    text,
                },
            }),
        );
        publishInfo('Sent your text turn to Pluto.');
        return true;
    }

    async function submitTextDraft() {
        const trimmed = textDraft.trim();
        if (!trimmed) {
            return;
        }

        const sent = await sendTextTurn(trimmed);
        if (sent) {
            setTextDraft('');
        }
    }

    async function requestMic() {
        if (!sessionId || !onRequestSpeaker) {
            return;
        }

        try {
            setIsTakingMic(true);
            publishInfo('Requesting the mic for this Pluto session…');
            await onRequestSpeaker(sessionId);
        } catch (error) {
            publishError(
                error instanceof Error
                    ? error.message
                    : 'Failed to take the mic for this Pluto session.',
            );
        } finally {
            setIsTakingMic(false);
        }
    }

    async function toggleRecording(mode: RecordingMode = 'push-to-talk') {
        if (!isRecording) {
            playback.stopPlayback();
            setActiveStatusMessage('Interrupting Pluto and opening your mic…');
        }

        await togglePlutoRecording({
            appendTimelineEntry,
            cleanupAudioCapture,
            clientId,
            isRecording,
            isSpeaker,
            audioCaptureRef,
            mediaStreamRef,
            mode,
            publishError,
            publishInfo,
            refreshAudioDevices: audioDevices.refreshAudioDevices,
            selectedInputId: audioDevices.selectedInputId,
            sendAudioChunk: (currentClientId, chunk, fallbackMimeType) =>
                sendPlutoAudioChunk({
                    chunk,
                    currentClientId,
                    fallbackMimeType,
                    socketRef,
                }),
            sessionId,
            setIsRecording,
            setRecordingMode,
            socketRef,
            startMicMonitor,
            stopMediaStream,
            stopRecording,
        });
    }

    function stopMediaStream() {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        setMicLevel(0);
        lastCommittedMicLevelRef.current = 0;
        lastMicLevelCommitAtRef.current = 0;
    }

    async function startMicMonitor(stream: MediaStream) {
        stopMicMonitor();

        const AudioContextCtor =
            globalThis.AudioContext ??
            (
                globalThis as typeof globalThis & {
                    webkitAudioContext?: typeof AudioContext;
                }
            ).webkitAudioContext;

        if (!AudioContextCtor) {
            return;
        }

        try {
            const ctx = new AudioContextCtor();
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;

            const source = ctx.createMediaStreamSource(stream);
            source.connect(analyser);

            micMonitorContextRef.current = ctx;
            micMonitorSourceRef.current = source;

            const samples = new Uint8Array(analyser.fftSize);

            const pumpLevel = () => {
                analyser.getByteTimeDomainData(samples);

                let deviation = 0;
                for (const sample of samples) {
                    deviation += Math.abs(sample - 128);
                }

                const normalized = Math.min(
                    1,
                    deviation / (samples.length * 24),
                );
                const now = performance.now();
                const lastLevel = lastCommittedMicLevelRef.current;
                if (
                    Math.abs(normalized - lastLevel) >=
                        MIC_LEVEL_DELTA_THRESHOLD &&
                    now - lastMicLevelCommitAtRef.current >=
                        MIC_LEVEL_UPDATE_INTERVAL_MS
                ) {
                    lastCommittedMicLevelRef.current = normalized;
                    lastMicLevelCommitAtRef.current = now;
                    setMicLevel(normalized);
                }
                micMonitorAnimationFrameRef.current =
                    globalThis.requestAnimationFrame(pumpLevel);
            };

            micMonitorAnimationFrameRef.current =
                globalThis.requestAnimationFrame(pumpLevel);
        } catch {
            setMicLevel(0);
        }
    }

    function stopMicMonitor() {
        if (micMonitorAnimationFrameRef.current !== null) {
            globalThis.cancelAnimationFrame(
                micMonitorAnimationFrameRef.current,
            );
            micMonitorAnimationFrameRef.current = null;
        }

        micMonitorSourceRef.current?.disconnect();
        micMonitorSourceRef.current = null;

        const ctx = micMonitorContextRef.current;
        micMonitorContextRef.current = null;
        if (ctx) {
            void ctx.close().catch(() => undefined);
        }

        cancelScrollAnimation(panelScrollAnimationFrameRef);
        cancelScrollAnimation(expandedScrollAnimationFrameRef);
    }

    return {
        activeStatusMessage,
        activeSession,
        audioDevices,
        canRequestSpeaker,
        currentSpeakerClientId,
        expandedScrollAreaRef,
        inlineNotice,
        inputPlaceholder,
        isChatExpanded,
        isOverlay,
        isPlaying: playback.isPlaying,
        isRecording,
        isSpeaker,
        isTakingMic,
        liveMicFeedback,
        micLevel,
        panelScrollAreaRef,
        primaryAction,
        recordingHint,
        recordingMode,
        roleStatus,
        selectedSummary,
        sessionId,
        setIsChatExpanded,
        setTextDraft,
        streamState,
        submitTextDraft,
        textDraft,
        timeline,
        toggleRecording,
        requestMic,
        visibleTimeline,
    };
}

function buildTimelineTailKey(entries: VoiceTimelineEntry[]) {
    const lastEntry = entries.at(-1);
    if (!lastEntry) {
        return '';
    }

    return `${lastEntry.id}:${lastEntry.text}:${entries.length}`;
}

function getScrollViewport(root: HTMLDivElement | null) {
    if (!root) {
        return null;
    }

    return root.querySelector<HTMLDivElement>(
        '[data-radix-scroll-area-viewport]',
    );
}

function smoothScrollViewportToBottom(
    viewport: HTMLDivElement | null,
    animationFrameRef: { current: number | null },
) {
    if (!viewport || !shouldAutoScroll(viewport)) {
        return;
    }

    cancelScrollAnimation(animationFrameRef);

    const startTop = viewport.scrollTop;
    const targetTop = viewport.scrollHeight - viewport.clientHeight;
    if (targetTop <= startTop) {
        return;
    }

    const startedAt = performance.now();

    const tick = (now: number) => {
        const progress = Math.min(
            1,
            (now - startedAt) / AUTO_SCROLL_DURATION_MS,
        );
        viewport.scrollTop = interpolateEaseOutCubic(
            startTop,
            targetTop,
            progress,
        );

        if (progress < 1) {
            animationFrameRef.current = globalThis.requestAnimationFrame(tick);
            return;
        }

        animationFrameRef.current = null;
    };

    animationFrameRef.current = globalThis.requestAnimationFrame(tick);
}

function shouldAutoScroll(viewport: HTMLDivElement) {
    const distanceFromBottom =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    return distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
}

function cancelScrollAnimation(animationFrameRef: { current: number | null }) {
    if (animationFrameRef.current === null) {
        return;
    }

    globalThis.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
}

function interpolateEaseOutCubic(start: number, end: number, progress: number) {
    const eased = 1 - (1 - progress) ** 3;
    return start + (end - start) * eased;
}
