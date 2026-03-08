import type {
    PlutoVoiceSession,
    PlutoVoiceSessionStreamEvent,
    PlutoVoiceSessionSummary,
} from '@agent-companion/shared';
import { plutoVoiceSessionStreamEventSchema } from '@agent-companion/shared';
import { Mic, MicOff, Radio, Volume2 } from 'lucide-react';
import {
    type Dispatch,
    type SetStateAction,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { plutoAudioState } from './PlutoAvatar.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { ScrollArea } from './ui/scroll-area.js';
import { parseJsonWebSocketData } from '../websocket.js';

type VoiceTimelineEntry = {
    id: string;
    label: string;
    text: string;
    tone: 'neutral' | 'accent' | 'error';
    createdAt: string;
};

type StreamState = 'idle' | 'connecting' | 'connected' | 'closed';

type Props = Readonly<{
    apiBase: string;
    desktopToken?: string;
    sessionId: string | null;
    clientId: string | null;
    sessions: PlutoVoiceSessionSummary[];
    variant?: 'panel' | 'overlay';
    onRequestSpeaker?: (sessionId: string) => Promise<void> | void;
    onError: (message: string) => void;
    onInfo: (message: string) => void;
}>;

const PLUTO_AUDIO_INPUT_STORAGE_KEY = 'agent-companion.pluto-audio-input';
const PLUTO_AUDIO_OUTPUT_STORAGE_KEY = 'agent-companion.pluto-audio-output';

export function PlutoVoiceSessionConsole({
    apiBase,
    desktopToken,
    sessionId,
    clientId,
    sessions,
    variant = 'panel',
    onRequestSpeaker,
    onError,
    onInfo,
}: Props) {
    const [streamState, setStreamState] = useState<StreamState>('idle');
    const [session, setSession] = useState<PlutoVoiceSession | null>(null);
    const [timeline, setTimeline] = useState<VoiceTimelineEntry[]>([]);
    const [isRecording, setIsRecording] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const [inlineNotice, setInlineNotice] = useState<{
        tone: 'neutral' | 'accent' | 'error';
        message: string;
    } | null>(null);
    const [availableInputs, setAvailableInputs] = useState<MediaDeviceInfo[]>(
        [],
    );
    const [availableOutputs, setAvailableOutputs] = useState<MediaDeviceInfo[]>(
        [],
    );
    const [selectedInputId, setSelectedInputId] = useState<string | null>(() =>
        readAudioDevicePreference(PLUTO_AUDIO_INPUT_STORAGE_KEY),
    );
    const [selectedOutputId, setSelectedOutputId] = useState<string | null>(
        () => readAudioDevicePreference(PLUTO_AUDIO_OUTPUT_STORAGE_KEY),
    );
    const [isTakingMic, setIsTakingMic] = useState(false);
    const socketRef = useRef<WebSocket | null>(null);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const scheduledPlaybackTimeRef = useRef(0);
    const playbackSourcesRef = useRef(0);
    const fallbackAudioRef = useRef<HTMLAudioElement | null>(null);
    const outputRoutingWarningShownRef = useRef(false);
    const micMonitorAnimationFrameRef = useRef<number | null>(null);
    const micMonitorContextRef = useRef<AudioContext | null>(null);
    const micMonitorSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
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
    const recordingHint = getRecordingHint(
        isSpeaker,
        Boolean(sessionId),
        canRequestSpeaker,
        isOverlay,
    );
    const visibleTimeline = isOverlay ? timeline.slice(-4) : timeline;
    const canEnumerateDevices = Boolean(
        globalThis.navigator?.mediaDevices?.enumerateDevices,
    );
    const canRouteOutputDevice = supportsOutputDeviceSelection();
    const roleStatus = getRoleStatus({
        isSpeaker,
        hasClient: Boolean(clientId),
        hasSession: Boolean(sessionId),
        hasSpeaker: Boolean(currentSpeakerClientId),
        canRequestSpeaker,
        isOverlay,
    });
    const inputDeviceHint = getInputDeviceHint({
        canEnumerateDevices,
        availableInputs,
        isRecording,
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

    useEffect(() => {
        void refreshAudioDevices();

        const mediaDevices = globalThis.navigator?.mediaDevices;
        if (!mediaDevices?.addEventListener) {
            return undefined;
        }

        const handleDeviceChange = () => {
            void refreshAudioDevices();
        };

        mediaDevices.addEventListener('devicechange', handleDeviceChange);
        return () => {
            mediaDevices.removeEventListener(
                'devicechange',
                handleDeviceChange,
            );
        };
    }, []);

    useEffect(() => {
        writeAudioDevicePreference(
            PLUTO_AUDIO_INPUT_STORAGE_KEY,
            selectedInputId,
        );
    }, [selectedInputId]);

    useEffect(() => {
        writeAudioDevicePreference(
            PLUTO_AUDIO_OUTPUT_STORAGE_KEY,
            selectedOutputId,
        );
    }, [selectedOutputId]);

    useEffect(() => {
        outputRoutingWarningShownRef.current = false;

        const globalState = globalThis as typeof globalThis & {
            _plutoVoiceAudioCtx?: AudioContext;
        };

        if (globalState._plutoVoiceAudioCtx) {
            void applyOutputDeviceToAudioContext(
                globalState._plutoVoiceAudioCtx,
                selectedOutputId,
                onInfo,
                outputRoutingWarningShownRef,
            );
        }

        if (fallbackAudioRef.current) {
            void applyOutputDeviceToAudioElement(
                fallbackAudioRef.current,
                selectedOutputId,
                onInfo,
                outputRoutingWarningShownRef,
            );
        }
    }, [onInfo, selectedOutputId]);

    useEffect(() => {
        setSession(null);
        setTimeline([]);
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
                    reason || 'Pluto session stream disconnected unexpectedly.',
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
        if (!sessionId || !selectedSummary) {
            return;
        }
        setSession((current) => current ?? null);
    }, [selectedSummary, sessionId]);

    const stopRecording = () => {
        stopPlutoRecording(mediaRecorderRef, appendTimelineEntry);
    };

    const toggleRecording = async () => {
        await togglePlutoRecording({
            appendTimelineEntry,
            cleanupAudioCapture,
            clientId,
            isRecording,
            isSpeaker,
            mediaRecorderRef,
            mediaStreamRef,
            publishError,
            publishInfo,
            refreshAudioDevices,
            selectedInputId,
            sendAudioChunk,
            sessionId,
            setIsRecording,
            socketRef,
            startMicMonitor,
            stopMediaStream,
            stopRecording,
        });
    };

    const handleStreamEvent = (event: PlutoVoiceSessionStreamEvent) => {
        handlePlutoStreamEvent({
            event,
            appendTimelineEntry,
            cleanupAudioCapture,
            playIncomingAudioChunk,
            publishError,
            setSession,
            setStreamState,
            streamTerminalEventRef,
        });
    };

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

        await applyOutputDeviceToAudioContext(
            ctx,
            selectedOutputId,
            onInfo,
            outputRoutingWarningShownRef,
        );

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
        await applyOutputDeviceToAudioElement(
            audio,
            selectedOutputId,
            onInfo,
            outputRoutingWarningShownRef,
        );
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
        stopMicMonitor();
        stopMediaStream();
        setIsRecording(false);
    }

    function stopMediaStream() {
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        setMicLevel(0);
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
                setMicLevel(normalized);
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
    }

    function publishInfo(message: string) {
        setInlineNotice({ tone: 'accent', message });
        onInfo(message);
    }

    function publishError(message: string) {
        setInlineNotice({ tone: 'error', message });
        onError(message);
    }

    async function refreshAudioDevices() {
        if (!globalThis.navigator?.mediaDevices?.enumerateDevices) {
            return;
        }

        try {
            const devices =
                await globalThis.navigator.mediaDevices.enumerateDevices();
            const inputs = devices
                .filter((device) => device.kind === 'audioinput')
                .filter(isSelectableDevice);
            const outputs = devices
                .filter((device) => device.kind === 'audiooutput')
                .filter(isSelectableDevice);

            setAvailableInputs(inputs);
            setAvailableOutputs(outputs);
            setSelectedInputId((current) =>
                normalizeAudioDeviceSelection(current, inputs),
            );
            setSelectedOutputId((current) =>
                normalizeAudioDeviceSelection(current, outputs),
            );
        } catch {
            // Device enumeration can fail before permissions exist; the voice
            // controls still work with the system default devices.
        }
    }

    return (
        <div
            className={
                isOverlay
                    ? 'flex w-full flex-col gap-3 text-left'
                    : 'mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4'
            }>
            <div className="flex flex-wrap items-center gap-2">
                <h4 className="mr-auto text-sm font-semibold text-slate-100">
                    {isOverlay ? 'Voice chat' : 'Live voice console'}
                </h4>
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

            <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                    size="sm"
                    onClick={() => {
                        if (
                            primaryAction.mode === 'take-mic' &&
                            sessionId &&
                            onRequestSpeaker
                        ) {
                            void (async () => {
                                try {
                                    setIsTakingMic(true);
                                    publishInfo(
                                        'Requesting the mic for this Pluto session…',
                                    );
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
                            })();
                            return;
                        }

                        void toggleRecording();
                    }}
                    disabled={primaryAction.disabled}>
                    {isRecording ? (
                        <MicOff className="mr-1.5 h-4 w-4" />
                    ) : (
                        <Mic className="mr-1.5 h-4 w-4" />
                    )}
                    {primaryAction.label}
                </Button>
                <span className="text-xs text-slate-400">{recordingHint}</span>
            </div>

            <VoiceConsoleSupportPanel
                roleStatus={roleStatus}
                isRecording={isRecording}
                liveMicFeedback={liveMicFeedback}
                micLevel={micLevel}
                inlineNotice={inlineNotice}
                canEnumerateDevices={canEnumerateDevices}
                isOverlay={isOverlay}
                availableInputs={availableInputs}
                availableOutputs={availableOutputs}
                selectedInputId={selectedInputId}
                selectedOutputId={selectedOutputId}
                canRouteOutputDevice={canRouteOutputDevice}
                inputDeviceHint={inputDeviceHint}
                onSelectInput={(nextValue) => {
                    setSelectedInputId(nextValue);
                    publishInfo(
                        nextValue
                            ? 'Microphone preference updated for Pluto voice chat.'
                            : 'Microphone set to the system default input.',
                    );
                }}
                onSelectOutput={(nextValue) => {
                    setSelectedOutputId(nextValue);
                    publishInfo(
                        nextValue
                            ? 'Playback device preference updated for Pluto voice chat.'
                            : 'Playback set to the system default output.',
                    );
                }}
            />

            <ScrollArea
                className={
                    isOverlay
                        ? 'mt-1 h-44 rounded-2xl border border-white/10 bg-black/30 p-3'
                        : 'mt-4 h-56 rounded-2xl border border-white/10 bg-black/30 p-3'
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

function formatStreamState(streamState: StreamState) {
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

function shouldReportUnexpectedDisconnect({
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

function handlePlutoStreamEvent({
    event,
    appendTimelineEntry,
    cleanupAudioCapture,
    playIncomingAudioChunk,
    publishError,
    setSession,
    setStreamState,
    streamTerminalEventRef,
}: Readonly<{
    event: PlutoVoiceSessionStreamEvent;
    appendTimelineEntry: (
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) => void;
    cleanupAudioCapture: () => void;
    playIncomingAudioChunk: (base64: string, mimeType: string) => Promise<void>;
    publishError: (message: string) => void;
    setSession: Dispatch<SetStateAction<PlutoVoiceSession | null>>;
    setStreamState: Dispatch<SetStateAction<StreamState>>;
    streamTerminalEventRef: { current: 'error' | 'closed' | null };
}>) {
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
            streamTerminalEventRef.current = 'error';
            appendTimelineEntry({
                label: 'Error',
                text: event.message,
                tone: 'error',
            });
            publishError(event.message);
            return;
        case 'closed':
            streamTerminalEventRef.current = 'closed';
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

async function togglePlutoRecording({
    appendTimelineEntry,
    cleanupAudioCapture,
    clientId,
    isRecording,
    isSpeaker,
    mediaRecorderRef,
    mediaStreamRef,
    publishError,
    publishInfo,
    refreshAudioDevices,
    selectedInputId,
    sendAudioChunk,
    sessionId,
    setIsRecording,
    socketRef,
    startMicMonitor,
    stopMediaStream,
    stopRecording,
}: Readonly<{
    appendTimelineEntry: (
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) => void;
    cleanupAudioCapture: () => void;
    clientId: string | null;
    isRecording: boolean;
    isSpeaker: boolean | null | undefined;
    mediaRecorderRef: { current: MediaRecorder | null };
    mediaStreamRef: { current: MediaStream | null };
    publishError: (message: string) => void;
    publishInfo: (message: string) => void;
    refreshAudioDevices: () => Promise<void>;
    selectedInputId: string | null;
    sendAudioChunk: (
        currentClientId: string,
        chunk: Blob,
        fallbackMimeType: string,
    ) => Promise<void>;
    sessionId: string | null;
    setIsRecording: Dispatch<SetStateAction<boolean>>;
    socketRef: { current: WebSocket | null };
    startMicMonitor: (stream: MediaStream) => Promise<void>;
    stopMediaStream: () => void;
    stopRecording: () => void;
}>) {
    if (isRecording) {
        stopRecording();
        return;
    }

    if (!sessionId || !clientId || !isSpeaker) {
        publishError(
            'Join the active Pluto session as speaker before talking.',
        );
        return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        publishError(
            'This browser environment does not expose microphone capture.',
        );
        return;
    }

    if (socketRef.current?.readyState !== WebSocket.OPEN) {
        publishError('The Pluto session stream is not connected yet.');
        return;
    }

    try {
        const audioConstraints = selectedInputId
            ? { deviceId: { exact: selectedInputId } }
            : true;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
        });
        mediaStreamRef.current = stream;
        void refreshAudioDevices();
        void startMicMonitor(stream);
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
            if (socketRef.current?.readyState === WebSocket.OPEN) {
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
        publishInfo(
            'Recording started. Speak and tap again when you are done.',
        );
    } catch (error) {
        cleanupAudioCapture();
        publishError(
            error instanceof Error
                ? error.message
                : 'Microphone capture failed',
        );
    }
}

function stopPlutoRecording(
    mediaRecorderRef: { current: MediaRecorder | null },
    appendTimelineEntry: (
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) => void,
) {
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
    canRequestSpeaker: boolean,
    isOverlay: boolean,
) {
    if (isSpeaker) {
        return isOverlay
            ? 'Press Record once to start and once more to stop and send.'
            : 'Press Record once to start and again to stop and send.';
    }
    if (canRequestSpeaker) {
        return 'The mic is free. Tap Take mic to become the speaker.';
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

function getRoleStatus({
    isSpeaker,
    hasClient,
    hasSession,
    hasSpeaker,
    canRequestSpeaker,
    isOverlay,
}: Readonly<{
    isSpeaker: boolean;
    hasClient: boolean;
    hasSession: boolean;
    hasSpeaker: boolean;
    canRequestSpeaker: boolean;
    isOverlay: boolean;
}>) {
    if (!hasSession) {
        return null;
    }
    if (isSpeaker) {
        return {
            tone: 'accent' as const,
            message:
                'You have the mic. Hit Record, speak, then tap again to send your turn to Pluto.',
        };
    }
    if (hasSpeaker) {
        return {
            tone: 'neutral' as const,
            message: isOverlay
                ? 'You are listening only right now. Open the dashboard and use “Take mic” when the current speaker is done.'
                : 'You are listening only right now. The session card keeps “Take mic” visible and it will enable itself when the mic becomes free.',
        };
    }
    if (canRequestSpeaker) {
        return {
            tone: 'accent' as const,
            message:
                'The mic is free. Tap “Take mic” below to become the speaker.',
        };
    }
    if (hasClient) {
        return {
            tone: 'neutral' as const,
            message:
                'You are attached to the session, but the mic action is not available here yet.',
        };
    }
    return {
        tone: 'neutral' as const,
        message:
            'Join the session first, then choose whether you want to listen or take the mic.',
    };
}

export function getVoiceConsolePrimaryAction({
    canRequestSpeaker,
    hasClient,
    hasSession,
    isRecording,
    isSpeaker,
    isTakingMic,
    streamState,
}: Readonly<{
    canRequestSpeaker: boolean;
    hasClient: boolean;
    hasSession: boolean;
    isRecording: boolean;
    isSpeaker: boolean;
    isTakingMic: boolean;
    streamState: StreamState;
}>) {
    if (isTakingMic) {
        return {
            disabled: true,
            label: 'Taking mic…',
            mode: 'take-mic' as const,
        };
    }

    if (isRecording) {
        return {
            disabled: false,
            label: 'Stop & send',
            mode: 'record' as const,
        };
    }

    if (canRequestSpeaker) {
        return {
            disabled: streamState !== 'connected' || !hasSession || !hasClient,
            label: 'Take mic',
            mode: 'take-mic' as const,
        };
    }

    return {
        disabled:
            streamState !== 'connected' ||
            !hasSession ||
            !hasClient ||
            !isSpeaker,
        label: 'Record',
        mode: 'record' as const,
    };
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

function AudioDeviceControls({
    isOverlay,
    availableInputs,
    availableOutputs,
    selectedInputId,
    selectedOutputId,
    canRouteOutputDevice,
    onSelectInput,
    onSelectOutput,
}: Readonly<{
    isOverlay: boolean;
    availableInputs: MediaDeviceInfo[];
    availableOutputs: MediaDeviceInfo[];
    selectedInputId: string | null;
    selectedOutputId: string | null;
    canRouteOutputDevice: boolean;
    onSelectInput: (deviceId: string | null) => void;
    onSelectOutput: (deviceId: string | null) => void;
}>) {
    const containerClassName = isOverlay
        ? 'grid gap-2 rounded-2xl border border-white/10 bg-black/20 p-3'
        : 'mt-4 grid gap-3 rounded-2xl border border-white/10 bg-black/20 p-3';
    const noteClassName = isOverlay
        ? 'text-[11px] text-amber-300/90'
        : 'text-xs text-amber-300/90';

    return (
        <div className={containerClassName}>
            <label className="grid gap-1.5 text-xs text-slate-400">
                <span className="font-medium text-slate-200">Microphone</span>
                <select
                    value={selectedInputId ?? 'default'}
                    onChange={(event) => {
                        const nextValue = event.target.value;
                        onSelectInput(
                            nextValue === 'default' ? null : nextValue,
                        );
                    }}
                    className="h-10 rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-slate-100 outline-none transition focus:border-white/30">
                    <option value="default">System default</option>
                    {availableInputs.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {formatAudioDeviceLabel(
                                device,
                                index,
                                'Microphone',
                            )}
                        </option>
                    ))}
                </select>
            </label>

            <label className="grid gap-1.5 text-xs text-slate-400">
                <span className="font-medium text-slate-200">
                    Headphones / speakers
                </span>
                <select
                    value={selectedOutputId ?? 'default'}
                    onChange={(event) => {
                        const nextValue = event.target.value;
                        onSelectOutput(
                            nextValue === 'default' ? null : nextValue,
                        );
                    }}
                    disabled={!canRouteOutputDevice}
                    className="h-10 rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-slate-100 outline-none transition focus:border-white/30 disabled:cursor-not-allowed disabled:opacity-60">
                    <option value="default">System default</option>
                    {availableOutputs.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                            {formatAudioDeviceLabel(device, index, 'Output')}
                        </option>
                    ))}
                </select>
            </label>

            {canRouteOutputDevice ? null : (
                <p className={noteClassName}>
                    This Electron runtime currently routes Pluto playback
                    through the system default output only.
                </p>
            )}
        </div>
    );
}

function VoiceConsoleSupportPanel({
    roleStatus,
    isRecording,
    liveMicFeedback,
    micLevel,
    inlineNotice,
    canEnumerateDevices,
    isOverlay,
    availableInputs,
    availableOutputs,
    selectedInputId,
    selectedOutputId,
    canRouteOutputDevice,
    inputDeviceHint,
    onSelectInput,
    onSelectOutput,
}: Readonly<{
    roleStatus: {
        tone: 'neutral' | 'accent';
        message: string;
    } | null;
    isRecording: boolean;
    liveMicFeedback: string;
    micLevel: number;
    inlineNotice: {
        tone: 'neutral' | 'accent' | 'error';
        message: string;
    } | null;
    canEnumerateDevices: boolean;
    isOverlay: boolean;
    availableInputs: MediaDeviceInfo[];
    availableOutputs: MediaDeviceInfo[];
    selectedInputId: string | null;
    selectedOutputId: string | null;
    canRouteOutputDevice: boolean;
    inputDeviceHint: string | null;
    onSelectInput: (deviceId: string | null) => void;
    onSelectOutput: (deviceId: string | null) => void;
}>) {
    return (
        <>
            {roleStatus ? (
                <div
                    className={
                        roleStatus.tone === 'accent'
                            ? 'mt-3 rounded-2xl border border-cyan-400/30 bg-cyan-500/10 p-3 text-xs text-cyan-100'
                            : 'mt-3 rounded-2xl border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-100'
                    }>
                    {roleStatus.message}
                </div>
            ) : null}

            {isRecording ? (
                <div className="mt-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-sm font-semibold text-emerald-200">
                                Pluto is listening
                            </div>
                            <p className="mt-1 text-xs text-emerald-100/90">
                                {liveMicFeedback}
                            </p>
                        </div>
                        <MicLevelMeter level={micLevel} />
                    </div>
                </div>
            ) : null}

            {inlineNotice ? (
                <div
                    className={
                        inlineNotice.tone === 'error'
                            ? 'mt-3 rounded-2xl border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-200'
                            : 'mt-3 rounded-2xl border border-cyan-400/30 bg-cyan-500/10 p-3 text-xs text-cyan-100'
                    }>
                    {inlineNotice.message}
                </div>
            ) : null}

            {canEnumerateDevices ? (
                <AudioDeviceControls
                    isOverlay={isOverlay}
                    availableInputs={availableInputs}
                    availableOutputs={availableOutputs}
                    selectedInputId={selectedInputId}
                    selectedOutputId={selectedOutputId}
                    canRouteOutputDevice={canRouteOutputDevice}
                    onSelectInput={onSelectInput}
                    onSelectOutput={onSelectOutput}
                />
            ) : null}

            {inputDeviceHint ? (
                <p className="text-xs text-slate-500">{inputDeviceHint}</p>
            ) : null}
        </>
    );
}

function MicLevelMeter({ level }: Readonly<{ level: number }>) {
    const bars = [0.18, 0.34, 0.5, 0.66, 0.82];

    return (
        <div className="flex min-w-18 items-end gap-1 rounded-full border border-emerald-300/20 bg-black/20 px-3 py-2">
            {bars.map((threshold, index) => {
                const active = level >= threshold;
                return (
                    <span
                        key={threshold}
                        className={
                            active ? 'bg-emerald-300' : 'bg-emerald-900/60'
                        }
                        style={{
                            width: '0.35rem',
                            height: `${0.55 + index * 0.3}rem`,
                            borderRadius: '999px',
                            transition: 'background-color 120ms ease',
                        }}
                    />
                );
            })}
        </div>
    );
}

function getLiveMicFeedback(level: number) {
    if (level > 0.5) {
        return 'Yep — I can hear you clearly.';
    }
    if (level > 0.22) {
        return 'I can hear something. Keep talking.';
    }
    return 'Say something — the mic level should jump here.';
}

function getInputDeviceHint({
    canEnumerateDevices,
    availableInputs,
    isRecording,
}: Readonly<{
    canEnumerateDevices: boolean;
    availableInputs: MediaDeviceInfo[];
    isRecording: boolean;
}>) {
    if (!canEnumerateDevices) {
        return 'This renderer cannot list audio devices, so Pluto uses your system defaults.';
    }
    if (availableInputs.length > 0) {
        return null;
    }
    if (isRecording) {
        return 'Microphone access is active now — device names should appear as the browser exposes them.';
    }
    return 'If the device names are empty, tap Record once to let the browser unlock microphone details.';
}

function isSelectableDevice(device: MediaDeviceInfo) {
    return (
        device.deviceId !== 'default' && device.deviceId !== 'communications'
    );
}

function normalizeAudioDeviceSelection(
    current: string | null,
    devices: MediaDeviceInfo[],
) {
    if (!current) {
        return null;
    }
    return devices.some((device) => device.deviceId === current)
        ? current
        : null;
}

function formatAudioDeviceLabel(
    device: MediaDeviceInfo,
    index: number,
    fallbackPrefix: string,
) {
    const label = device.label.trim();
    if (label) {
        return label;
    }
    return `${fallbackPrefix} ${index + 1}`;
}

function readAudioDevicePreference(storageKey: string) {
    if (globalThis.localStorage === undefined) {
        return null;
    }

    try {
        const stored = globalThis.localStorage.getItem(storageKey);
        return stored && stored.length > 0 ? stored : null;
    } catch {
        return null;
    }
}

function writeAudioDevicePreference(
    storageKey: string,
    deviceId: string | null,
) {
    if (globalThis.localStorage === undefined) {
        return;
    }

    try {
        if (deviceId) {
            globalThis.localStorage.setItem(storageKey, deviceId);
            return;
        }
        globalThis.localStorage.removeItem(storageKey);
    } catch {
        // Ignore persistence issues and keep the in-memory selection.
    }
}

function supportsOutputDeviceSelection() {
    const audioElementPrototype = globalThis.HTMLMediaElement?.prototype as
        | (HTMLMediaElement & {
              setSinkId?: (sinkId: string) => Promise<void>;
          })
        | undefined;
    const audioContextPrototype = globalThis.AudioContext?.prototype as
        | (AudioContext & {
              setSinkId?: (sinkId: string) => Promise<void>;
          })
        | undefined;

    return Boolean(
        audioElementPrototype?.setSinkId || audioContextPrototype?.setSinkId,
    );
}

async function applyOutputDeviceToAudioContext(
    ctx: AudioContext,
    deviceId: string | null,
    onInfo: (message: string) => void,
    warningShownRef: { current: boolean },
) {
    const contextWithSink = ctx as AudioContext & {
        sinkId?: string;
        setSinkId?: (sinkId: string) => Promise<void>;
    };
    const targetDeviceId = deviceId ?? 'default';

    if (contextWithSink.setSinkId) {
        if (contextWithSink.sinkId !== targetDeviceId) {
            await contextWithSink.setSinkId(targetDeviceId);
        }
        return;
    }

    if (deviceId && !warningShownRef.current) {
        warningShownRef.current = true;
        onInfo(
            'Playback device selection is not supported here; Pluto will use the system default output.',
        );
    }
}

async function applyOutputDeviceToAudioElement(
    audio: HTMLAudioElement,
    deviceId: string | null,
    onInfo: (message: string) => void,
    warningShownRef: { current: boolean },
) {
    const audioWithSink = audio as HTMLAudioElement & {
        setSinkId?: (sinkId: string) => Promise<void>;
    };
    const targetDeviceId = deviceId ?? 'default';

    if (audioWithSink.setSinkId) {
        await audioWithSink.setSinkId(targetDeviceId);
        return;
    }

    if (deviceId && !warningShownRef.current) {
        warningShownRef.current = true;
        onInfo(
            'Playback device selection is not supported here; Pluto will use the system default output.',
        );
    }
}
