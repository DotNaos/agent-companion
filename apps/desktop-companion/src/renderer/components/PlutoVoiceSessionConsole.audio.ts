import { useEffect, useRef, useState } from 'react';
import {
    resetPlutoSpeakingState,
    setPlutoSpeakingState,
} from './PlutoAvatar.js';
import {
    applyOutputDeviceToAudioContext,
    applyOutputDeviceToAudioElement,
} from './PlutoVoiceSessionConsole.devices.js';

type PlaybackHookOptions = Readonly<{
    enabled?: boolean;
    selectedOutputId: string | null;
    onInfo: (message: string) => void;
}>;

type PendingAudioChunk = {
    bytes: Uint8Array;
    mimeType: string;
};

const MAX_PCM_BATCH_DURATION_SECONDS = 0.32;
const PCM_START_BUFFER_SECONDS = 0.18;
const PCM_RESUME_BUFFER_SECONDS = 0.06;
const PCM_SCHEDULE_AHEAD_SECONDS = 0.24;
const PCM_EDGE_FADE_SECONDS = 0.004;

export function usePlutoVoicePlayback({
    enabled = true,
    selectedOutputId,
    onInfo,
}: PlaybackHookOptions) {
    const [isPlaying, setIsPlaying] = useState(false);
    const scheduledPlaybackTimeRef = useRef(0);
    const activePlaybackCountRef = useRef(0);
    const pcmSourcesRef = useRef(new Set<AudioBufferSourceNode>());
    const fallbackAudioRef = useRef<HTMLAudioElement | null>(null);
    const currentPlaybackTurnIdRef = useRef<number | null>(null);
    const completedPlaybackTurnsRef = useRef(new Set<number>());
    const pendingPlaybackTurnsRef = useRef(
        new Map<number, PendingAudioChunk[]>(),
    );
    const startedPcmTurnsRef = useRef(new Set<number>());
    const outputRoutingWarningShownRef = useRef(false);
    const pcmSchedulingRef = useRef<Promise<void> | null>(null);

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

    function stopPlayback() {
        pcmSchedulingRef.current = null;
        scheduledPlaybackTimeRef.current = 0;
        activePlaybackCountRef.current = 0;
        currentPlaybackTurnIdRef.current = null;
        completedPlaybackTurnsRef.current.clear();
        pendingPlaybackTurnsRef.current.clear();
        startedPcmTurnsRef.current.clear();

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

    function enqueueIncomingAudioChunk(
        turnId: number,
        audioBase64: string,
        mimeType: string,
    ) {
        if (!enabled) {
            return;
        }

        const queue = pendingPlaybackTurnsRef.current.get(turnId) ?? [];
        const bytes = decodeBase64(audioBase64);

        if (mimeType.startsWith('audio/pcm')) {
            appendPcmChunk(queue, bytes, mimeType);
        } else {
            queue.push({ bytes, mimeType });
        }

        pendingPlaybackTurnsRef.current.set(turnId, queue);
        maybeAdvancePlaybackTurn();
    }

    function markOutputTurnComplete(turnId: number) {
        if (!enabled) {
            return;
        }

        completedPlaybackTurnsRef.current.add(turnId);
        maybeAdvancePlaybackTurn();
    }

    function maybeAdvancePlaybackTurn() {
        if (!enabled) {
            return;
        }

        if (advanceCurrentPlaybackTurn()) {
            return;
        }

        startNextPlaybackTurn();
    }

    function advanceCurrentPlaybackTurn() {
        const currentTurnId = currentPlaybackTurnIdRef.current;
        if (currentTurnId === null) {
            return false;
        }

        const currentQueue = pendingPlaybackTurnsRef.current.get(currentTurnId);
        if (currentQueue?.length && isPcmChunk(currentQueue[0])) {
            void scheduleQueuedPcmChunks(currentTurnId);
            return true;
        }

        if (currentQueue?.length && activePlaybackCountRef.current === 0) {
            const nextChunk = currentQueue.shift();
            if (!nextChunk) {
                return true;
            }

            if (currentQueue.length === 0) {
                pendingPlaybackTurnsRef.current.delete(currentTurnId);
            }

            void playIncomingAudioChunk(nextChunk.bytes, nextChunk.mimeType);
            return true;
        }

        if (activePlaybackCountRef.current > 0) {
            return true;
        }

        if (
            !completedPlaybackTurnsRef.current.has(currentTurnId) ||
            Boolean(currentQueue?.length)
        ) {
            return true;
        }

        currentPlaybackTurnIdRef.current = null;
        completedPlaybackTurnsRef.current.delete(currentTurnId);
        startedPcmTurnsRef.current.delete(currentTurnId);
        return false;
    }

    function startNextPlaybackTurn() {
        const nextTurnId = [...pendingPlaybackTurnsRef.current.keys()].sort(
            (left, right) => left - right,
        )[0];

        if (nextTurnId === undefined) {
            return;
        }

        const nextQueue = pendingPlaybackTurnsRef.current.get(nextTurnId);
        if (!nextQueue || nextQueue.length === 0) {
            pendingPlaybackTurnsRef.current.delete(nextTurnId);
            return;
        }

        if (isPcmChunk(nextQueue[0])) {
            currentPlaybackTurnIdRef.current = nextTurnId;
            void scheduleQueuedPcmChunks(nextTurnId);
            return;
        }

        const nextChunk = nextQueue?.shift();
        if (!nextQueue || !nextChunk) {
            pendingPlaybackTurnsRef.current.delete(nextTurnId);
            return;
        }

        if (nextQueue.length === 0) {
            pendingPlaybackTurnsRef.current.delete(nextTurnId);
        }

        currentPlaybackTurnIdRef.current = nextTurnId;
        void playIncomingAudioChunk(nextChunk.bytes, nextChunk.mimeType);
    }

    async function scheduleQueuedPcmChunks(turnId: number) {
        if (pcmSchedulingRef.current !== null) {
            return;
        }

        pcmSchedulingRef.current = (async () => {
            const ctx = await ensureAudioContext();
            if (!ctx) {
                return;
            }

            try {
                await applyOutputDeviceToAudioContext(
                    ctx,
                    selectedOutputId,
                    onInfo,
                    outputRoutingWarningShownRef,
                );
            } catch {
                onInfo(
                    'Pluto could not switch the playback device and will stay on the system default output.',
                );
            }

            while (currentPlaybackTurnIdRef.current === turnId) {
                const queue = pendingPlaybackTurnsRef.current.get(turnId);
                if (!queue || queue.length === 0) {
                    break;
                }

                const nextChunk = queue[0];
                if (!nextChunk || !isPcmChunk(nextChunk)) {
                    break;
                }

                const bufferedSeconds = getQueuedPcmDurationSeconds(queue);
                const turnCompleted = completedPlaybackTurnsRef.current.has(turnId);
                const hasStartedTurn = startedPcmTurnsRef.current.has(turnId);
                const scheduleLeadSeconds = Math.max(
                    0,
                    scheduledPlaybackTimeRef.current - ctx.currentTime,
                );
                const minimumBufferedSeconds = hasStartedTurn
                    ? PCM_RESUME_BUFFER_SECONDS
                    : PCM_START_BUFFER_SECONDS;

                if (
                    shouldWaitForMorePcmAudio({
                        activePlaybackCount: activePlaybackCountRef.current,
                        turnCompleted,
                        bufferedSeconds,
                        minimumBufferedSeconds,
                        scheduleLeadSeconds,
                    })
                ) {
                    break;
                }

                queue.shift();
                if (queue.length === 0) {
                    pendingPlaybackTurnsRef.current.delete(turnId);
                }

                schedulePcmChunkWithContext(ctx, nextChunk.bytes, nextChunk.mimeType);
            }
        })().finally(() => {
            pcmSchedulingRef.current = null;
            queueMicrotask(() => {
                maybeAdvancePlaybackTurn();
            });
        });

        await pcmSchedulingRef.current;
    }

    async function playIncomingAudioChunk(bytes: Uint8Array, mimeType: string) {
        if (mimeType.startsWith('audio/pcm')) {
            await playPcmChunk(bytes, mimeType);
            return;
        }
        await playBlobChunk(bytes, mimeType);
    }

    async function playPcmChunk(bytes: Uint8Array, mimeType: string) {
        const ctx = await ensureAudioContext();
        if (!ctx) {
            return;
        }

        try {
            await applyOutputDeviceToAudioContext(
                ctx,
                selectedOutputId,
                onInfo,
                outputRoutingWarningShownRef,
            );
        } catch {
            onInfo(
                'Pluto could not switch the playback device and will stay on the system default output.',
            );
        }

        schedulePcmChunkWithContext(ctx, bytes, mimeType);
    }

    function schedulePcmChunkWithContext(
        ctx: AudioContext,
        bytes: Uint8Array,
        mimeType: string,
    ) {
        if (!enabled) {
            return;
        }

        const sampleRate = parseSampleRate(mimeType, 24_000);
        const frameCount = Math.floor(bytes.length / 2);
        if (frameCount === 0) {
            return;
        }

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
        const gainNode = ctx.createGain();
        source.buffer = buffer;
        source.connect(gainNode);
        gainNode.connect(ctx.destination);
        pcmSourcesRef.current.add(source);

        const edgeFadeDuration = Math.min(
            PCM_EDGE_FADE_SECONDS,
            buffer.duration / 8,
        );
        const activeTurnId = currentPlaybackTurnIdRef.current;
        if (activeTurnId !== null) {
            startedPcmTurnsRef.current.add(activeTurnId);
        }
        const startAt = Math.max(ctx.currentTime, scheduledPlaybackTimeRef.current);
        const endAt = startAt + buffer.duration;
        scheduledPlaybackTimeRef.current = startAt + buffer.duration;
        activePlaybackCountRef.current += 1;
        setIsPlaying(true);
        const speakingLevel =
            frameCount > 0 ? Math.min(1, amplitudeSum / frameCount) : 0;
        setPlutoSpeakingState(true, speakingLevel);

        gainNode.gain.setValueAtTime(0, startAt);
        gainNode.gain.linearRampToValueAtTime(1, startAt + edgeFadeDuration);
        gainNode.gain.setValueAtTime(
            1,
            Math.max(startAt + edgeFadeDuration, endAt - edgeFadeDuration),
        );
        gainNode.gain.linearRampToValueAtTime(0, endAt);

        source.addEventListener('ended', () => {
            pcmSourcesRef.current.delete(source);
            source.disconnect();
            gainNode.disconnect();
            activePlaybackCountRef.current = Math.max(
                0,
                activePlaybackCountRef.current - 1,
            );
            if (activePlaybackCountRef.current === 0) {
                setIsPlaying(false);
                resetPlutoSpeakingState();
                maybeAdvancePlaybackTurn();
            }
        });

        source.start(startAt);
    }

    async function playBlobChunk(bytes: Uint8Array, mimeType: string) {
        const blobBytes = new Uint8Array(bytes.byteLength);
        blobBytes.set(bytes);
        const blob = new Blob([blobBytes.buffer], { type: mimeType });
        const objectUrl = URL.createObjectURL(blob);
        fallbackAudioRef.current?.pause();
        const audio = new Audio(objectUrl);
        fallbackAudioRef.current = audio;
        activePlaybackCountRef.current += 1;

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
            activePlaybackCountRef.current = Math.max(
                0,
                activePlaybackCountRef.current - 1,
            );
            setIsPlaying(false);
            resetPlutoSpeakingState();
            scheduledPlaybackTimeRef.current = 0;
            URL.revokeObjectURL(objectUrl);
            maybeAdvancePlaybackTurn();
        });
        await audio.play().catch(() => {
            activePlaybackCountRef.current = Math.max(
                0,
                activePlaybackCountRef.current - 1,
            );
        });
    }

    return {
        isPlaying,
        enqueueIncomingAudioChunk,
        markOutputTurnComplete,
        stopPlayback,
    };
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

export async function blobToBase64(blob: Blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }
    return globalThis.btoa(binary);
}

function appendPcmChunk(
    queue: PendingAudioChunk[],
    nextBytes: Uint8Array,
    mimeType: string,
) {
    const sampleRate = parseSampleRate(mimeType, 24_000);
    const maxBatchBytes = Math.max(
        nextBytes.byteLength,
        Math.floor(sampleRate * 2 * MAX_PCM_BATCH_DURATION_SECONDS),
    );
    const previous = queue.at(-1);

    if (previous?.mimeType === mimeType && previous.bytes.byteLength < maxBatchBytes) {
        previous.bytes = concatUint8Arrays(previous.bytes, nextBytes);
        return;
    }

    queue.push({ bytes: nextBytes, mimeType });
}

function concatUint8Arrays(left: Uint8Array, right: Uint8Array) {
    const merged = new Uint8Array(left.byteLength + right.byteLength);
    merged.set(left, 0);
    merged.set(right, left.byteLength);
    return merged;
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

    if (globalState._plutoVoiceAudioCtx?.state === 'closed') {
        globalState._plutoVoiceAudioCtx = undefined;
    }

    if (!globalState._plutoVoiceAudioCtx) {
        globalState._plutoVoiceAudioCtx = new AudioContextCtor();
    }
    if (globalState._plutoVoiceAudioCtx.state === 'suspended') {
        await globalState._plutoVoiceAudioCtx.resume();
    }
    return globalState._plutoVoiceAudioCtx;
}

function isPcmChunk(chunk: PendingAudioChunk | undefined) {
    return Boolean(chunk?.mimeType.startsWith('audio/pcm'));
}

function getQueuedPcmDurationSeconds(queue: PendingAudioChunk[]) {
    let totalFrames = 0;
    let sampleRate = 24_000;

    for (const chunk of queue) {
        if (!isPcmChunk(chunk)) {
            break;
        }

        sampleRate = parseSampleRate(chunk.mimeType, sampleRate);
        totalFrames += Math.floor(chunk.bytes.byteLength / 2);
    }

    return totalFrames / sampleRate;
}

function shouldWaitForMorePcmAudio(input: {
    activePlaybackCount: number;
    turnCompleted: boolean;
    bufferedSeconds: number;
    minimumBufferedSeconds: number;
    scheduleLeadSeconds: number;
}) {
    if (
        input.activePlaybackCount === 0 &&
        !input.turnCompleted &&
        input.bufferedSeconds < input.minimumBufferedSeconds
    ) {
        return true;
    }

    if (
        input.activePlaybackCount > 0 &&
        !input.turnCompleted &&
        input.scheduleLeadSeconds >= PCM_SCHEDULE_AHEAD_SECONDS
    ) {
        return true;
    }

    return false;
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
