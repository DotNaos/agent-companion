import type {
    PlutoVoiceSession,
    PlutoVoiceSessionStreamEvent,
    PlutoVoiceSessionSummary,
} from '@agent-companion/shared';
import { plutoVoiceSessionStreamEventSchema } from '@agent-companion/shared';
import { Expand, Mic, MicOff, Radio, Volume2 } from 'lucide-react';
import {
    type Dispatch,
    type SetStateAction,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { parseJsonWebSocketData } from '../websocket.js';
import {
    resetPlutoSpeakingState,
    setPlutoSpeakingState,
} from './PlutoAvatar.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from './ui/dialog.js';
import { Input } from './ui/input.js';
import { ScrollArea } from './ui/scroll-area.js';

type VoiceTimelineEntry = {
    id: string;
    label: string;
    text: string;
    actor: 'you' | 'pluto' | 'system';
    tone: 'neutral' | 'accent' | 'error';
    createdAt: string;
};

type VoiceTimelineDraftEntry = Omit<VoiceTimelineEntry, 'id' | 'createdAt'>;

type StreamState = 'idle' | 'connecting' | 'connected' | 'closed';
type RecordingMode = 'push-to-talk' | 'live';
type PlutoAudioCapture = {
    stop: () => void;
};

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
    const [isChatExpanded, setIsChatExpanded] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [recordingMode, setRecordingMode] = useState<RecordingMode | null>(
        null,
    );
    const [isPlaying, setIsPlaying] = useState(false);
    const [micLevel, setMicLevel] = useState(0);
    const [textDraft, setTextDraft] = useState('');
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
    const audioCaptureRef = useRef<PlutoAudioCapture | null>(null);
    const mediaStreamRef = useRef<MediaStream | null>(null);
    const scheduledPlaybackTimeRef = useRef(0);
    const playbackSourcesRef = useRef(0);
    const pcmSourcesRef = useRef(new Set<AudioBufferSourceNode>());
    const fallbackAudioRef = useRef<HTMLAudioElement | null>(null);
    const outputRoutingWarningShownRef = useRef(false);
    const micMonitorAnimationFrameRef = useRef<number | null>(null);
    const micMonitorContextRef = useRef<AudioContext | null>(null);
    const micMonitorSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const panelTimelineEndRef = useRef<HTMLDivElement | null>(null);
    const expandedTimelineEndRef = useRef<HTMLDivElement | null>(null);
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

    useEffect(() => {
        if (visibleTimeline.length === 0) {
            return;
        }

        const frame = globalThis.requestAnimationFrame(() => {
            panelTimelineEndRef.current?.scrollIntoView({
                block: 'end',
                behavior: 'auto',
            });

            if (isChatExpanded) {
                expandedTimelineEndRef.current?.scrollIntoView({
                    block: 'end',
                    behavior: 'auto',
                });
            }
        });

        return () => {
            globalThis.cancelAnimationFrame(frame);
        };
    }, [isChatExpanded, timeline, visibleTimeline]);

    const stopRecording = () => {
        stopPlutoRecording(audioCaptureRef, appendTimelineEntry, recordingMode);
        setRecordingMode(null);
    };

    const toggleRecording = async (mode: RecordingMode = 'push-to-talk') => {
        await togglePlutoRecording({
            appendTimelineEntry,
            appendStandaloneTimelineEntry,
            cleanupAudioCapture,
            clientId,
            isRecording,
            isSpeaker,
            audioCaptureRef,
            mediaStreamRef,
            mode,
            publishError,
            publishInfo,
            refreshAudioDevices,
            selectedInputId,
            sendAudioChunk,
            sessionId,
            setIsRecording,
            setRecordingMode,
            socketRef,
            startMicMonitor,
            stopMediaStream,
            stopRecording,
        });
    };

    const requestMic = async () => {
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
            stopPlayback,
            streamTerminalEventRef,
        });
    };

    function stopPlayback() {
        scheduledPlaybackTimeRef.current = 0;
        playbackSourcesRef.current = 0;

        for (const source of pcmSourcesRef.current) {
            try {
                source.stop();
            } catch {
                // Ignore already-stopped sources.
            }
            source.disconnect();
        }
        pcmSourcesRef.current.clear();

        if (fallbackAudioRef.current) {
            fallbackAudioRef.current.pause();
            fallbackAudioRef.current.currentTime = 0;
        }

        setIsPlaying(false);
        resetPlutoSpeakingState();
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

    function appendStandaloneTimelineEntry(entry: VoiceTimelineDraftEntry) {
        setTimeline((current) => {
            const nextEntry: VoiceTimelineEntry = {
                ...entry,
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
            };

            return [...current, nextEntry].slice(-30);
        });
    }

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
        pcmSourcesRef.current.add(source);

        const startAt = Math.max(
            ctx.currentTime,
            scheduledPlaybackTimeRef.current,
        );
        scheduledPlaybackTimeRef.current = startAt + buffer.duration;
        playbackSourcesRef.current += 1;
        setIsPlaying(true);
        setPlutoSpeakingState(true, Math.min(1, amplitudeSum / frameCount));

        source.addEventListener('ended', () => {
            pcmSourcesRef.current.delete(source);
            playbackSourcesRef.current = Math.max(
                0,
                playbackSourcesRef.current - 1,
            );
            if (playbackSourcesRef.current === 0) {
                setIsPlaying(false);
                resetPlutoSpeakingState();
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
            setPlutoSpeakingState(true, 0.6);
        });
        audio.addEventListener('ended', () => {
            setIsPlaying(false);
            resetPlutoSpeakingState();
            scheduledPlaybackTimeRef.current = 0;
            URL.revokeObjectURL(objectUrl);
        });
        await audio.play().catch(() => undefined);
    }

    function appendTimelineEntry(entry: VoiceTimelineDraftEntry) {
        setTimeline((current) => {
            return appendVoiceTimelineEntry(current, entry);
        });
    }

    function cleanupAudioCapture() {
        const capture = audioCaptureRef.current;
        if (capture) {
            capture.stop();
        }
        stopMicMonitor();
        stopMediaStream();
        setIsRecording(false);
        setRecordingMode(null);
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

    if (isOverlay) {
        return (
            <div className="flex w-full flex-col gap-2 text-left">
                {visibleTimeline.length === 0 ? null : (
                    <div className="flex flex-col gap-2">
                        {visibleTimeline.map((entry) => (
                            <div
                                key={entry.id}
                                className={getTimelineEntryRowClass(entry)}>
                                <div
                                    className={getTimelineEntryBubbleClass(
                                        entry,
                                        true,
                                    )}>
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
                                    <p className="mt-1 text-sm text-slate-100">
                                        {entry.text}
                                    </p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div
            className={
                'mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4'
            }>
            <div className="flex flex-wrap items-center gap-2">
                <h4 className="mr-auto text-sm font-semibold text-slate-100">
                    Live voice console
                </h4>
                <Button
                    size="sm"
                    variant="outline"
                    className="border-white/10 bg-black/30 text-slate-200 hover:bg-white/8"
                    onClick={() => setIsChatExpanded(true)}>
                    <Expand className="mr-1.5 h-4 w-4" />
                    Open chat
                </Button>
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
                        if (primaryAction.mode === 'take-mic') {
                            void requestMic();
                            return;
                        }

                        void toggleRecording('push-to-talk');
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

            <ScrollArea className="mt-4 h-56 rounded-2xl border border-white/10 bg-black/30 p-3">
                {renderVoiceTimeline(visibleTimeline, false)}
                <div ref={panelTimelineEndRef} aria-hidden="true" />
            </ScrollArea>

            <Dialog open={isChatExpanded} onOpenChange={setIsChatExpanded}>
                <DialogContent className="h-[calc(100vh-40px)] w-[calc(100vw-40px)] max-h-[calc(100vh-40px)] max-w-none overflow-hidden p-0">
                    <div className="flex h-full flex-col bg-[linear-gradient(180deg,rgba(9,15,25,0.98),rgba(7,11,20,0.98))]">
                        <DialogHeader className="border-b border-white/10 px-6 py-5 pr-16">
                            <DialogTitle className="text-2xl">
                                Pluto voice chat
                            </DialogTitle>
                            <DialogDescription>
                                Large transcript view for the live Pluto voice
                                session.
                            </DialogDescription>
                        </DialogHeader>
                        <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
                            <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-400">
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
                                    {isPlaying
                                        ? 'Pluto speaking'
                                        : 'Playback idle'}
                                </Badge>
                            </div>
                            <ScrollArea className="min-h-0 flex-1 rounded-2xl border border-white/10 bg-black/25 p-4">
                                {renderVoiceTimeline(timeline, false)}
                                <div ref={expandedTimelineEndRef} aria-hidden="true" />
                            </ScrollArea>
                        </div>
                        <VoiceChatComposer
                            canRequestSpeaker={canRequestSpeaker}
                            canSend={Boolean(
                                sessionId && clientId && isSpeaker,
                            )}
                            draft={textDraft}
                            inputDisabled={
                                !sessionId || !clientId || !isSpeaker
                            }
                            isRecording={isRecording}
                            isTakingMic={isTakingMic}
                            mode={recordingMode}
                            onChangeDraft={setTextDraft}
                            onRequestMic={() => {
                                void requestMic();
                            }}
                            onSend={() => {
                                void submitTextDraft();
                            }}
                            onStartLive={() => {
                                void toggleRecording('live');
                            }}
                            onStartPushToTalk={() => {
                                void toggleRecording('push-to-talk');
                            }}
                            placeholder={getVoiceChatInputPlaceholder({
                                hasClient: Boolean(clientId),
                                hasSession: Boolean(sessionId),
                                isSpeaker,
                            })}
                        />
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function renderVoiceTimeline(
    entries: VoiceTimelineEntry[],
    isOverlay: boolean,
) {
    return (
        <div className="space-y-3">
            {entries.length === 0 ? (
                <div className="text-sm text-slate-500">
                    Pluto is waiting for the first live event.
                </div>
            ) : (
                entries.map((entry) => (
                    <div
                        key={entry.id}
                        className={getTimelineEntryRowClass(entry)}>
                        <div
                            className={getTimelineEntryBubbleClass(
                                entry,
                                isOverlay,
                            )}>
                            <div className="flex items-center justify-between gap-2">
                                <span className={timelineToneClass(entry.tone)}>
                                    {entry.label}
                                </span>
                                <time className="text-[11px] text-slate-500">
                                    {new Date(
                                        entry.createdAt,
                                    ).toLocaleTimeString()}
                                </time>
                            </div>
                            <p className="mt-1 text-sm text-slate-100">
                                {entry.text}
                            </p>
                        </div>
                    </div>
                ))
            )}
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

export function getPlutoPcmMimeType(sampleRate: number) {
    return `audio/pcm;rate=${sampleRate}`;
}

export function encodePcm16Chunk(samples: Float32Array) {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);

    for (let index = 0; index < samples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
        const normalized = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(index * 2, Math.round(normalized), true);
    }

    return buffer;
}

export function createPcmChunkBlob(samples: Float32Array, sampleRate: number) {
    return new Blob([encodePcm16Chunk(samples)], {
        type: getPlutoPcmMimeType(sampleRate),
    });
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
    stopPlayback,
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
    stopPlayback: () => void;
    streamTerminalEventRef: { current: 'error' | 'closed' | null };
}>) {
    switch (event.type) {
        case 'session_snapshot':
        case 'session_updated':
            setSession(event.session);
            return;
        case 'input_transcription':
            appendTimelineEntry({
                actor: 'you',
                label: 'You',
                text: event.text,
                tone: 'accent',
            });
            return;
        case 'output_transcription':
            appendTimelineEntry({
                actor: 'pluto',
                label: 'Pluto',
                text: event.text,
                tone: 'neutral',
            });
            return;
        case 'audio_chunk':
            void playIncomingAudioChunk(event.audioBase64, event.mimeType);
            return;
        case 'status':
            if (event.interrupted) {
                stopPlayback();
            }
            appendTimelineEntry({
                actor: 'system',
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
            stopPlayback();
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

async function togglePlutoRecording({
    appendTimelineEntry,
    appendStandaloneTimelineEntry,
    cleanupAudioCapture,
    clientId,
    isRecording,
    isSpeaker,
    audioCaptureRef,
    mediaStreamRef,
    mode,
    publishError,
    publishInfo,
    refreshAudioDevices,
    selectedInputId,
    sendAudioChunk,
    sessionId,
    setIsRecording,
    setRecordingMode,
    socketRef,
    startMicMonitor,
    stopMediaStream,
    stopRecording,
}: Readonly<{
    appendTimelineEntry: (
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) => void;
    appendStandaloneTimelineEntry: (
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) => void;
    cleanupAudioCapture: () => void;
    clientId: string | null;
    isRecording: boolean;
    isSpeaker: boolean | null | undefined;
    audioCaptureRef: { current: PlutoAudioCapture | null };
    mediaStreamRef: { current: MediaStream | null };
    mode: RecordingMode;
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
    setRecordingMode: Dispatch<SetStateAction<RecordingMode | null>>;
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
        const AudioContextCtor =
            globalThis.AudioContext ??
            (
                globalThis as typeof globalThis & {
                    webkitAudioContext?: typeof AudioContext;
                }
            ).webkitAudioContext;

        if (!AudioContextCtor) {
            publishError(
                'This browser environment does not expose raw audio capture.',
            );
            return;
        }

        const audioConstraints = selectedInputId
            ? { deviceId: { exact: selectedInputId } }
            : true;
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints,
        });
        mediaStreamRef.current = stream;
        void refreshAudioDevices();
        void startMicMonitor(stream);

        const audioContext = new AudioContextCtor();
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);
        const mimeType = getPlutoPcmMimeType(audioContext.sampleRate);
        let stopped = false;

        const stopCapture = () => {
            if (stopped) {
                return;
            }

            stopped = true;
            processor.onaudioprocess = null;
            processor.disconnect();
            source.disconnect();
            audioCaptureRef.current = null;
            setIsRecording(false);
            setRecordingMode(null);
            stopMediaStream();
            void audioContext.close().catch(() => undefined);

            if (socketRef.current?.readyState === WebSocket.OPEN) {
                socketRef.current.send(
                    JSON.stringify({
                        type: 'audio_stream_end',
                        clientId,
                    }),
                );
            }
        };

        processor.onaudioprocess = (event) => {
            if (stopped || !clientId) {
                return;
            }

            const input = event.inputBuffer.getChannelData(0);
            if (input.length === 0) {
                return;
            }

            const chunk = createPcmChunkBlob(
                new Float32Array(input),
                audioContext.sampleRate,
            );
            void sendAudioChunk(clientId, chunk, mimeType);
        };

        source.connect(processor);
        processor.connect(audioContext.destination);
        audioCaptureRef.current = { stop: stopCapture };

        setIsRecording(true);
        setRecordingMode(mode);
        appendTimelineEntry({
            actor: 'system',
            label: mode === 'live' ? 'Live' : 'Mic',
            text:
                mode === 'live'
                    ? 'Live mode started. Keep talking naturally — it stays on until you stop it.'
                    : 'Recording started.',
            tone: 'accent',
        });
        publishInfo(
            mode === 'live'
                ? 'Live mode started. It will stay active until you switch it off.'
                : 'Recording started. Speak and tap again when you are done.',
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
    audioCaptureRef: { current: PlutoAudioCapture | null },
    appendTimelineEntry: (
        entry: Omit<VoiceTimelineEntry, 'id' | 'createdAt'>,
    ) => void,
    recordingMode: RecordingMode | null,
) {
    const capture = audioCaptureRef.current;
    if (!capture) {
        return;
    }
    capture.stop();
    appendTimelineEntry({
        actor: 'system',
        label: recordingMode === 'live' ? 'Live' : 'Mic',
        text:
            recordingMode === 'live'
                ? 'Live mode stopped. Sending to Pluto…'
                : 'Recording stopped. Sending to Pluto…',
        tone: 'neutral',
    });
}

function VoiceChatComposer({
    canRequestSpeaker,
    canSend,
    draft,
    inputDisabled,
    isRecording,
    isTakingMic,
    mode,
    onChangeDraft,
    onRequestMic,
    onSend,
    onStartLive,
    onStartPushToTalk,
    placeholder,
}: Readonly<{
    canRequestSpeaker: boolean;
    canSend: boolean;
    draft: string;
    inputDisabled: boolean;
    isRecording: boolean;
    isTakingMic: boolean;
    mode: RecordingMode | null;
    onChangeDraft: (value: string) => void;
    onRequestMic: () => void;
    onSend: () => void;
    onStartLive: () => void;
    onStartPushToTalk: () => void;
    placeholder: string;
}>) {
    const pushToTalkActive = isRecording && mode === 'push-to-talk';
    const liveActive = isRecording && mode === 'live';

    return (
        <div className="border-t border-white/10 px-6 py-4">
            {canRequestSpeaker ? (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-500/10 px-4 py-3">
                    <p className="text-sm text-cyan-100">
                        The mic is free — take it here to chat with Pluto in
                        full screen.
                    </p>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={onRequestMic}
                        disabled={isTakingMic}>
                        {isTakingMic ? 'Taking mic…' : 'Take mic'}
                    </Button>
                </div>
            ) : null}

            <div className="rounded-[28px] border border-white/10 bg-black/35 p-3 shadow-[0_18px_48px_rgba(0,0,0,0.28)] backdrop-blur">
                <div className="flex flex-wrap items-center gap-3">
                    <Input
                        value={draft}
                        onChange={(event) => onChangeDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter') {
                                return;
                            }

                            event.preventDefault();
                            onSend();
                        }}
                        disabled={inputDisabled || isTakingMic}
                        placeholder={placeholder}
                        className="h-14 min-w-70 flex-1 rounded-[22px] border-white/5 bg-white/5 px-5 text-base placeholder:text-slate-500 focus:border-cyan-300/40 focus:ring-cyan-300/15 disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <Button
                        size="icon"
                        variant={pushToTalkActive ? 'default' : 'secondary'}
                        className="h-14 w-14"
                        title={
                            pushToTalkActive ? 'Stop and send' : 'Push to talk'
                        }
                        onClick={onStartPushToTalk}
                        disabled={!canSend}>
                        {pushToTalkActive ? (
                            <MicOff className="h-5 w-5" />
                        ) : (
                            <Mic className="h-5 w-5" />
                        )}
                    </Button>
                    <Button
                        size="icon"
                        variant={liveActive ? 'default' : 'secondary'}
                        className="h-14 w-14"
                        title={liveActive ? 'Stop live mode' : 'Live mode'}
                        onClick={onStartLive}
                        disabled={!canSend}>
                        <Radio className="h-5 w-5" />
                    </Button>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
                    <span>
                        {canSend
                            ? 'Press Enter to send text, use Mic for push-to-talk, or Live for automatic end-of-speech sending.'
                            : canRequestSpeaker
                              ? 'Take the mic first, then you can type or speak to Pluto here.'
                              : 'This fullscreen view mirrors the live transcript until you become the speaker.'}
                    </span>
                    <span>
                        {liveActive
                            ? 'Live mode stays active until you switch it off.'
                            : pushToTalkActive
                              ? 'Push-to-talk recording is active.'
                              : 'Ready when you are.'}
                    </span>
                </div>
            </div>
        </div>
    );
}

function getVoiceChatInputPlaceholder({
    hasClient,
    hasSession,
    isSpeaker,
}: Readonly<{
    hasClient: boolean;
    hasSession: boolean;
    isSpeaker: boolean;
}>) {
    if (!hasSession) {
        return 'Select a Pluto session to start chatting…';
    }
    if (!hasClient) {
        return 'Join the Pluto session first…';
    }
    if (!isSpeaker) {
        return 'Take the mic to type or talk to Pluto…';
    }
    return 'Type a message to Pluto and press Enter…';
}

function getTimelineEntryRowClass(entry: VoiceTimelineEntry) {
    return getVoiceTimelineLayout(entry.actor, false).rowClass;
}

function getTimelineEntryBubbleClass(
    entry: VoiceTimelineEntry,
    isOverlay: boolean,
) {
    return getVoiceTimelineLayout(entry.actor, isOverlay).bubbleClass;
}

export function getVoiceTimelineLayout(
    actor: VoiceTimelineEntry['actor'],
    isOverlay: boolean,
) {
    const rowClass =
        actor === 'you'
            ? 'flex justify-end'
            : actor === 'pluto'
              ? 'flex justify-start'
              : 'flex justify-center';

    const baseClass = isOverlay
        ? 'max-w-[85%] rounded-2xl px-3 py-2'
        : 'max-w-[80%] rounded-2xl px-4 py-3';

    const bubbleClass =
        actor === 'you'
            ? `${baseClass} border border-cyan-400/30 bg-cyan-500/15 text-right`
            : actor === 'pluto'
              ? `${baseClass} border border-white/10 bg-white/8`
              : `${baseClass} border border-white/8 bg-black/25 text-center`;

    return {
        rowClass,
        bubbleClass,
    };
}

export function appendVoiceTimelineEntry(
    current: VoiceTimelineEntry[],
    entry: VoiceTimelineDraftEntry,
    now = new Date().toISOString(),
) {
    const previous = current.at(-1);

    if (previous?.label === entry.label && previous.text === entry.text) {
        return current;
    }

    const mergeTargetIndex = findVoiceTimelineMergeTargetIndex(current, entry);
    const mergeTarget =
        mergeTargetIndex >= 0 ? current[mergeTargetIndex] : undefined;

    if (mergeTarget && shouldMergeVoiceTimelineEntry(mergeTarget, entry, now)) {
        const mergedEntry: VoiceTimelineEntry = {
            ...mergeTarget,
            text: mergeVoiceTimelineText(mergeTarget.text, entry.text),
            tone: entry.tone,
        };
        return current.map((timelineEntry, index) =>
            index === mergeTargetIndex ? mergedEntry : timelineEntry,
        );
    }

    const nextEntry: VoiceTimelineEntry = {
        ...entry,
        id: crypto.randomUUID(),
        createdAt: now,
    };

    return [...current, nextEntry].slice(-30);
}

function findVoiceTimelineMergeTargetIndex(
    entries: VoiceTimelineEntry[],
    next: VoiceTimelineDraftEntry,
) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!entry) {
            continue;
        }

        if (entry.actor === 'system') {
            continue;
        }

        if (entry.actor === next.actor && entry.label === next.label) {
            return index;
        }

        return -1;
    }

    return -1;
}

export function shouldMergeVoiceTimelineEntry(
    previous: Pick<
        VoiceTimelineEntry,
        'actor' | 'label' | 'text' | 'tone' | 'createdAt'
    >,
    next: VoiceTimelineDraftEntry,
    now = new Date().toISOString(),
) {
    if (previous.actor !== next.actor || previous.label !== next.label) {
        return false;
    }

    if (previous.actor === 'system') {
        return false;
    }

    const previousText = previous.text.trim();
    const nextText = next.text.trim();

    if (!previousText || !nextText) {
        return true;
    }

    const previousTime = Date.parse(previous.createdAt);
    const currentTime = Date.parse(now);
    const withinStreamingWindow =
        Number.isFinite(previousTime) &&
        Number.isFinite(currentTime) &&
        currentTime - previousTime <= 2_500;

    return (
        nextText.startsWith(previousText) ||
        previousText.startsWith(nextText) ||
        isLikelyTranscriptContinuation(previousText, nextText) ||
        withinStreamingWindow ||
        longestCommonPrefixLength(previousText, nextText) >=
            Math.min(previousText.length, nextText.length) * 0.7
    );
}

function isLikelyTranscriptContinuation(previousText: string, nextText: string) {
    if (!previousText || !nextText) {
        return false;
    }

    if (/[.!?…]["')\]]?$/.test(previousText)) {
        return false;
    }

    return /^[a-zäöüß,(]/.test(nextText);
}

export function mergeVoiceTimelineText(previousText: string, nextText: string) {
    const previousTrimmed = previousText.trim();
    const nextTrimmed = nextText.trim();

    if (!previousTrimmed) {
        return nextTrimmed;
    }

    if (!nextTrimmed) {
        return previousTrimmed;
    }

    if (nextTrimmed.startsWith(previousTrimmed)) {
        return nextTrimmed;
    }

    if (previousTrimmed.startsWith(nextTrimmed)) {
        return previousTrimmed;
    }

    const overlap = longestSuffixPrefixOverlap(previousTrimmed, nextTrimmed);
    if (overlap >= 3) {
        return `${previousTrimmed}${nextTrimmed.slice(overlap)}`.trim();
    }

    const joiner = shouldJoinWithoutSpace(previousTrimmed, nextTrimmed)
        ? ''
        : ' ';
    return `${previousTrimmed}${joiner}${nextTrimmed}`.trim();
}

function longestSuffixPrefixOverlap(left: string, right: string) {
    const maxLength = Math.min(left.length, right.length);

    for (let size = maxLength; size > 0; size -= 1) {
        if (left.slice(-size) === right.slice(0, size)) {
            return size;
        }
    }

    return 0;
}

function shouldJoinWithoutSpace(left: string, right: string) {
    return /[\s([{„"']$/.test(left) || /^[,.;:!?)}\]"'”]/.test(right);
}

function longestCommonPrefixLength(left: string, right: string) {
    const maxLength = Math.min(left.length, right.length);
    let index = 0;

    while (index < maxLength && left[index] === right[index]) {
        index += 1;
    }

    return index;
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
