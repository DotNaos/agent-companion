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
    selectedOutputId: string | null;
    onInfo: (message: string) => void;
}>;

type PendingAudioChunk = {
    audioBase64: string;
    mimeType: string;
};

export function usePlutoVoicePlayback({
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
    const outputRoutingWarningShownRef = useRef(false);

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
        scheduledPlaybackTimeRef.current = 0;
        activePlaybackCountRef.current = 0;
        currentPlaybackTurnIdRef.current = null;
        completedPlaybackTurnsRef.current.clear();
        pendingPlaybackTurnsRef.current.clear();

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
        const queue = pendingPlaybackTurnsRef.current.get(turnId) ?? [];
        queue.push({ audioBase64, mimeType });
        pendingPlaybackTurnsRef.current.set(turnId, queue);
        maybeAdvancePlaybackTurn();
    }

    function markOutputTurnComplete(turnId: number) {
        completedPlaybackTurnsRef.current.add(turnId);
        maybeAdvancePlaybackTurn();
    }

    function maybeAdvancePlaybackTurn() {
        const currentTurnId = currentPlaybackTurnIdRef.current;

        if (currentTurnId !== null) {
            const currentQueue =
                pendingPlaybackTurnsRef.current.get(currentTurnId);
            if (
                currentQueue &&
                currentQueue.length > 0 &&
                activePlaybackCountRef.current === 0
            ) {
                const nextChunk = currentQueue.shift();
                if (!nextChunk) {
                    return;
                }
                if (currentQueue.length === 0) {
                    pendingPlaybackTurnsRef.current.delete(currentTurnId);
                }
                void playIncomingAudioChunk(
                    nextChunk.audioBase64,
                    nextChunk.mimeType,
                );
                return;
            }

            if (activePlaybackCountRef.current > 0) {
                return;
            }

            if (
                !completedPlaybackTurnsRef.current.has(currentTurnId) ||
                (currentQueue && currentQueue.length > 0)
            ) {
                return;
            }

            currentPlaybackTurnIdRef.current = null;
            completedPlaybackTurnsRef.current.delete(currentTurnId);
        }

        const nextTurnId = [...pendingPlaybackTurnsRef.current.keys()].sort(
            (left, right) => left - right,
        )[0];

        if (nextTurnId === undefined) {
            return;
        }

        const nextQueue = pendingPlaybackTurnsRef.current.get(nextTurnId);
        const nextChunk = nextQueue?.shift();
        if (!nextQueue || !nextChunk) {
            pendingPlaybackTurnsRef.current.delete(nextTurnId);
            return;
        }

        if (nextQueue.length === 0) {
            pendingPlaybackTurnsRef.current.delete(nextTurnId);
        }

        currentPlaybackTurnIdRef.current = nextTurnId;
        void playIncomingAudioChunk(nextChunk.audioBase64, nextChunk.mimeType);
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
        activePlaybackCountRef.current += 1;
        setIsPlaying(true);
        setPlutoSpeakingState(true, Math.min(1, amplitudeSum / frameCount));

        source.addEventListener('ended', () => {
            pcmSourcesRef.current.delete(source);
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

    async function playBlobChunk(base64: string, mimeType: string) {
        const bytes = decodeBase64(base64);
        const blob = new Blob([bytes], { type: mimeType });
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
