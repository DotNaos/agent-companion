import type {
    PlutoVoiceSession,
    PlutoVoiceSessionStreamEvent,
    PlutoVoiceSessionSummary,
} from '@agent-companion/shared';
import { plutoVoiceSessionStreamEventSchema } from '@agent-companion/shared';
import { Mic, MicOff, Radio, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { plutoAudioState } from './PlutoAvatar.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { ScrollArea } from './ui/scroll-area.js';

type VoiceTimelineEntry = {
    id: string;
    label: string;
    text: string;
    tone: 'neutral' | 'accent' | 'error';
    createdAt: string;
};

type Props = Readonly<{
    apiBase: string;
    desktopToken?: string;
    sessionId: string | null;
    clientId: string | null;
    sessions: PlutoVoiceSessionSummary[];
    variant?: 'panel' | 'overlay';
    onError: (message: string) => void;
    onInfo: (message: string) => void;
}>;

export function PlutoVoiceSessionConsole({
    apiBase,
    desktopToken,
    sessionId,
    clientId,
    sessions,
    variant = 'panel',
    onError,
    onInfo,
}: Props) {
    const [streamState, setStreamState] = useState<
        'idle' | 'connecting' | 'connected' | 'closed'
    >('idle');
    const [session, setSession] = useState<PlutoVoiceSession | null>(null);
    const [timeline, setTimeline] = useState<VoiceTimelineEntry[]>([]);
    const [isRecording, setIsRecording] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const socketRef = useRef<WebSocket | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const scheduledPlaybackTimeRef = useRef(0);
    const playbackSourcesRef = useRef(0);
    const fallbackAudioRef = useRef<HTMLAudioElement | null>(null);

    const selectedSummary = useMemo(
        () => sessions.find((entry) => entry.id === sessionId) ?? null,
        [sessionId, sessions],
    );
    const activeSession = session ?? null;
    const isSpeaker =
        Boolean(clientId) && activeSession?.speakerClientId === clientId;
    const isOverlay = variant === 'overlay';
    const recordingHint = getRecordingHint(
        isSpeaker,
        Boolean(sessionId),
        isOverlay,
    );
    const roleLabel = getRoleLabel(isSpeaker, Boolean(clientId));
    const visibleTimeline = isOverlay ? timeline.slice(-4) : timeline;
    const descriptionText = getDescriptionText(Boolean(sessionId), isOverlay);

    useEffect(() => {
        setSession(null);
        setTimeline([]);

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
        });

        socket.addEventListener('message', (event) => {
            const parsed = plutoVoiceSessionStreamEventSchema.safeParse(
                JSON.parse(String(event.data)),
            );
            if (!parsed.success) {
                return;
            }
            handleStreamEvent(parsed.data);
        });

        socket.addEventListener('close', () => {
            setStreamState('closed');
            cleanupAudioCapture();
        });

        socket.addEventListener('error', () => {
            setStreamState('closed');
            onError('Pluto session stream disconnected unexpectedly.');
            cleanupAudioCapture();
        });

        return () => {
            cleanupAudioCapture();
            socketRef.current = null;
            socket.close();
        };
    }, [apiBase, desktopToken, onError, sessionId]);

    useEffect(() => {
        if (!sessionId || !selectedSummary) {
            return;
        }
        setSession((current) => current ?? null);
    }, [selectedSummary, sessionId]);

    async function toggleRecording() {
        if (isRecording) {
            stopRecording();
            return;
        }

        if (!sessionId || !clientId || !isSpeaker) {
            onError('Join the active Pluto session as speaker before talking.');
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            onError(
                'This browser environment does not expose microphone capture.',
            );
            return;
        }

        if (socketRef.current?.readyState !== WebSocket.OPEN) {
            onError('The Pluto session stream is not connected yet.');
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
            });
            mediaStreamRef.current = stream;
            const mimeType = pickRecordingMimeType();
            const recorder = mimeType
                ? new MediaRecorder(stream, { mimeType })
                : new MediaRecorder(stream);
            mediaRecorderRef.current = recorder;

            recorder.addEventListener('dataavailable', (event) => {
                if (event.data.size === 0 || !clientId) {
                    return;
                }
                void sendAudioChunk(clientId, event.data, recorder.mimeType);
            });

            recorder.addEventListener('stop', () => {
                setIsRecording(false);
                mediaRecorderRef.current = null;
                stopMediaStream();
                if (
                    clientId &&
                    socketRef.current?.readyState === WebSocket.OPEN
                ) {
                    socketRef.current.send(
                        JSON.stringify({
                            type: 'audio_stream_end',
                            clientId,
                        }),
                    );
                }
            });

            recorder.start(250);
            setIsRecording(true);
            appendTimelineEntry({
                label: 'Mic',
                text: 'Recording started.',
                tone: 'accent',
            });
            onInfo('Recording started. Speak and tap again when you are done.');
        } catch (error) {
            cleanupAudioCapture();
            onError(
                error instanceof Error
                    ? error.message
                    : 'Microphone capture failed',
            );
        }
    }

    function stopRecording() {
        const recorder = mediaRecorderRef.current;
        if (!recorder || recorder.state === 'inactive') {
            return;
        }
        recorder.stop();
        appendTimelineEntry({
            label: 'Mic',
            text: 'Recording stopped. Sending to Pluto…',
            tone: 'neutral',
        });
    }

    function handleStreamEvent(event: PlutoVoiceSessionStreamEvent) {
        switch (event.type) {
            case 'session_snapshot':
            case 'session_updated':
                setSession(event.session);
                return;
            case 'input_transcription':
                appendTimelineEntry({
                    label: 'You',
                    text: event.text,
                    tone: 'accent',
                });
                return;
            case 'output_transcription':
                appendTimelineEntry({
                    label: 'Pluto',
                    text: event.text,
                    tone: 'neutral',
                });
                return;
            case 'audio_chunk':
                void playIncomingAudioChunk(event.audioBase64, event.mimeType);
                return;
            case 'status':
                appendTimelineEntry({
                    label: 'Status',
                    text: describeStatusEvent(event),
                    tone: 'neutral',
                });
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
                appendTimelineEntry({
                    label: 'Error',
                    text: event.message,
                    tone: 'error',
                });
                onError(event.message);
                return;
            case 'closed':
                appendTimelineEntry({
                    label: 'Closed',
                    text: event.reason ?? 'Session closed.',
                    tone: 'neutral',
                });
                setStreamState('closed');
                cleanupAudioCapture();
                return;
        }
    }

    async function sendAudioChunk(
        currentClientId: string,
        chunk: Blob,
        fallbackMimeType: string,
    ) {
        if (socketRef.current?.readyState !== WebSocket.OPEN) {
            return;
        }
        const audioBase64 = await blobToBase64(chunk);
        socketRef.current.send(
            JSON.stringify({
                type: 'audio_chunk',
                chunk: {
                    clientId: currentClientId,
                    audioBase64,
                    mimeType: chunk.type || fallbackMimeType || 'audio/webm',
                },
            }),
        );
    }

    async function playIncomingAudioChunk(base64: string, mimeType: string) {
        if (mimeType.startsWith('audio/pcm')) {
            await playPcmChunk(base64, mimeType);
            return;
        }
        await playBlobChunk(base64, mimeType);
    }

    async function playPcmChunk(base64: string, mimeType: string) {
        const ctx = await ensureAudioContext();
        if (!ctx) {
            return;
        }

        const sampleRate = parseSampleRate(mimeType, 24_000);
        const bytes = decodeBase64(base64);
        const frameCount = Math.floor(bytes.length / 2);
        const samples = new Float32Array(frameCount);
        const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        );

        let amplitudeSum = 0;
        for (let index = 0; index < frameCount; index += 1) {
            const sample = view.getInt16(index * 2, true) / 32768;
            samples[index] = sample;
            amplitudeSum += Math.abs(sample);
        }

        const buffer = ctx.createBuffer(1, frameCount, sampleRate);
        buffer.copyToChannel(samples, 0);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        const startAt = Math.max(
            ctx.currentTime,
            scheduledPlaybackTimeRef.current,
        );
        scheduledPlaybackTimeRef.current = startAt + buffer.duration;
        playbackSourcesRef.current += 1;
        setIsPlaying(true);
        if (plutoAudioState) {
            plutoAudioState.isSpeaking = true;
            plutoAudioState.volume = Math.min(1, amplitudeSum / frameCount);
        }

        source.addEventListener('ended', () => {
            playbackSourcesRef.current = Math.max(
                0,
                playbackSourcesRef.current - 1,
            );
            if (playbackSourcesRef.current === 0) {
                setIsPlaying(false);
                if (plutoAudioState) {
                    plutoAudioState.isSpeaking = false;
                    plutoAudioState.volume = 0;
                }
            }
        });

        source.start(startAt);
    }

    async function playBlobChunk(base64: string, mimeType: string) {
        const bytes = decodeBase64(base64);
        const blob = new Blob([bytes], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        fallbackAudioRef.current?.pause();
        const audio = new Audio(objectUrl);
        fallbackAudioRef.current = audio;
        audio.addEventListener('play', () => {
            setIsPlaying(true);
            if (plutoAudioState) {
                plutoAudioState.isSpeaking = true;
                plutoAudioState.volume = 0.6;
            }
        });
        audio.addEventListener('ended', () => {
            setIsPlaying(false);
            if (plutoAudioState) {
                plutoAudioState.isSpeaking = false;
                plutoAudioState.volume = 0;
            }
            URL.revokeObjectURL(objectUrl);
        });
        await audio.play().catch(() => undefined);
    }

    function appendTimelineEntry(
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) {
        setTimeline((current) => {
            const nextEntry: VoiceTimelineEntry = {
                ...entry,
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
            };
            const previous = current.at(-1);
            if (
                previous?.label === nextEntry.label &&
                previous.text === nextEntry.text
            ) {
                return current;
            }
            return [...current, nextEntry].slice(-30);
        });
    }

    function cleanupAudioCapture() {
        const recorder = mediaRecorderRef.current;
        if (recorder && recorder.state !== 'inactive') {
            recorder.stop();
        }
        mediaRecorderRef.current = null;
        stopMediaStream();
        setIsRecording(false);
    }

    function stopMediaStream() {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
    }

    return (
        <div
            className={
                isOverlay
                    ? 'flex w-full flex-col gap-3 text-left'
                    : 'mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4'
            }>
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h4 className="text-sm font-semibold text-slate-100">
                        {isOverlay ? 'Voice chat' : 'Live voice console'}
                    </h4>
                    <p className="mt-1 text-xs text-slate-400">
                        {descriptionText}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Badge
                        variant="secondary"
                        className="border-white/10 bg-black/40 text-slate-300">
                        <Radio className="mr-1 h-3.5 w-3.5" />
                        {formatStreamState(streamState)}
                    </Badge>
                    <Badge
                        variant="secondary"
                        className="border-white/10 bg-black/40 text-slate-300">
                        <Volume2 className="mr-1 h-3.5 w-3.5" />
                        {isPlaying ? 'Pluto speaking' : 'Playback idle'}
                    </Badge>
                </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                    size="sm"
                    onClick={() => void toggleRecording()}
                    disabled={
                        !sessionId ||
                        !clientId ||
                        !isSpeaker ||
                        streamState !== 'connected'
                    }>
                    {isRecording ? (
                        <MicOff className="mr-1.5 h-4 w-4" />
                    ) : (
                        <Mic className="mr-1.5 h-4 w-4" />
                    )}
                    {isRecording ? 'Stop & send' : 'Record'}
                </Button>
                <span className="text-xs text-slate-400">{recordingHint}</span>
            </div>

            <div
                className={
                    isOverlay
                        ? 'mt-1 grid gap-3'
                        : 'mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem]'
                }>
                <ScrollArea
                    className={
                        isOverlay
                            ? 'h-44 rounded-2xl border border-white/10 bg-black/30 p-3'
                            : 'h-56 rounded-2xl border border-white/10 bg-black/30 p-3'
                    }>
                    <div className="space-y-3">
                        {visibleTimeline.length === 0 ? (
                            <div className="text-sm text-slate-500">
                                Pluto is waiting for the first live event.
                            </div>
                        ) : (
                            visibleTimeline.map((entry) => (
                                <div
                                    key={entry.id}
                                    className={
                                        isOverlay
                                            ? 'rounded-2xl border border-white/8 bg-white/6 p-3'
                                            : 'rounded-xl border border-white/8 bg-white/4 p-3'
                                    }>
                                    <div className="flex items-center justify-between gap-2">
                                        <span
                                            className={timelineToneClass(
                                                entry.tone,
                                            )}>
                                            {entry.label}
                                        </span>
                                        <time className="text-[11px] text-slate-500">
                                            {new Date(
                                                entry.createdAt,
                                            ).toLocaleTimeString()}
                                        </time>
                                    </div>
                                    <p className="mt-1 text-sm text-slate-200">
                                        {entry.text}
                                    </p>
                                </div>
                            ))
                        )}
                    </div>
                </ScrollArea>

                <div className="rounded-2xl border border-white/10 bg-black/25 p-3 text-xs text-slate-300">
                    <div className="font-semibold text-slate-100">
                        Session details
                    </div>
                    <dl className="mt-3 space-y-2">
                        <div>
                            <dt className="text-slate-500">Session</dt>
                            <dd>
                                {activeSession?.title ??
                                    selectedSummary?.title ??
                                    '—'}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-slate-500">Status</dt>
                            <dd>
                                {activeSession?.status ??
                                    selectedSummary?.status ??
                                    '—'}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-slate-500">Role</dt>
                            <dd>{roleLabel}</dd>
                        </div>
                        <div>
                            <dt className="text-slate-500">Clients</dt>
                            <dd>{activeSession?.clients.length ?? '—'}</dd>
                        </div>
                    </dl>
                </div>
            </div>
        </div>
    );
}

function buildSessionStreamUrl(
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

function formatStreamState(
    streamState: 'idle' | 'connecting' | 'connected' | 'closed',
) {
    switch (streamState) {
        case 'idle':
            return 'No session';
        case 'connecting':
            return 'Connecting';
        case 'connected':
            return 'Live';
        case 'closed':
            return 'Closed';
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

function pickRecordingMimeType() {
    if (typeof MediaRecorder === 'undefined') {
        return '';
    }

    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

    return (
        candidates.find((candidate) =>
            MediaRecorder.isTypeSupported(candidate),
        ) ?? ''
    );
}

async function blobToBase64(blob: Blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }
    return globalThis.btoa(binary);
}

function decodeBase64(base64: string) {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }
    return bytes;
}

async function ensureAudioContext() {
    const audioWindow = globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextCtor =
        globalThis.AudioContext ?? audioWindow.webkitAudioContext;
    if (!AudioContextCtor) {
        return null;
    }

    const globalState = globalThis as typeof globalThis & {
        _plutoVoiceAudioCtx?: AudioContext;
    };

    if (!globalState._plutoVoiceAudioCtx) {
        globalState._plutoVoiceAudioCtx = new AudioContextCtor();
    }
    if (globalState._plutoVoiceAudioCtx.state === 'suspended') {
        await globalState._plutoVoiceAudioCtx.resume();
    }
    return globalState._plutoVoiceAudioCtx;
}

function parseSampleRate(mimeType: string, fallback: number) {
    for (const parameter of mimeType.split(';').slice(1)) {
        const [key, value] = parameter.split('=').map((entry) => entry.trim());
        if (key === 'rate') {
            const parsed = Number.parseInt(value ?? '', 10);
            if (!Number.isNaN(parsed)) {
                return parsed;
            }
        }
    }
    return fallback;
}

function getRecordingHint(
    isSpeaker: boolean,
    hasSession: boolean,
    isOverlay: boolean,
) {
    if (isSpeaker) {
        return isOverlay
            ? 'Press Record once to start and once more to stop and send.'
            : 'Press Record once to start and again to stop and send.';
    }
    if (hasSession) {
        return 'This desktop client is currently observing. Rejoin as speaker to talk.';
    }
    return 'No active session selected yet.';
}

function getDescriptionText(hasSession: boolean, isOverlay: boolean) {
    if (hasSession) {
        return isOverlay
            ? 'Tap Record, talk, tap again. Pluto answers automatically.'
            : 'Desktop voice chat over the live Pluto session stream.';
    }
    return isOverlay
        ? 'Select a Pluto session in the dashboard to chat here.'
        : 'Start or join a session to open the live Pluto console.';
}

function getRoleLabel(isSpeaker: boolean, hasClient: boolean) {
    if (isSpeaker) {
        return 'Speaker';
    }
    if (hasClient) {
        return 'Observer';
    }
    return 'Not attached';
}

function timelineToneClass(entryTone: VoiceTimelineEntry['tone']) {
    if (entryTone === 'error') {
        return 'text-xs font-semibold text-red-300';
    }
    if (entryTone === 'accent') {
        return 'text-xs font-semibold text-cyan-300';
    }
    return 'text-xs font-semibold text-slate-300';
}
