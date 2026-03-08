import type { Dispatch, SetStateAction } from 'react';
import { blobToBase64, createPcmChunkBlob, getPlutoPcmMimeType } from './PlutoVoiceSessionConsole.audio.js';
import type {
    PlutoAudioCapture,
    RecordingMode,
    VoiceTimelineEntry,
} from './PlutoVoiceSessionConsole.shared.js';

const PLUTO_AUDIO_CAPTURE_WORKLET_NAME = 'pluto-audio-capture';
const PLUTO_AUDIO_CAPTURE_WORKLET_URL = new URL(
    './PlutoVoiceSessionConsole.capture.worklet.ts',
    import.meta.url,
).href;
const PLUTO_AUDIO_CAPTURE_CHUNK_FRAMES = 2048;

type AudioCaptureGraph = {
    dispose: () => void;
    flush?: () => Promise<void>;
};

export async function sendPlutoAudioChunk({
    chunk,
    currentClientId,
    fallbackMimeType,
    socketRef,
}: Readonly<{
    chunk: Blob;
    currentClientId: string;
    fallbackMimeType: string;
    socketRef: { current: WebSocket | null };
}>) {
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

export async function togglePlutoRecording({
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
        const mimeType = getPlutoPcmMimeType(audioContext.sampleRate);
        const captureGraph = await createAudioCaptureGraph({
            audioContext,
            currentClientId: clientId,
            mimeType,
            sendAudioChunk,
            source,
        });
        let stopping = false;

        const stopCapture = () => {
            if (stopping) {
                return;
            }

            stopping = true;
            void finalizeCapture({
                audioCaptureRef,
                audioContext,
                captureGraph,
                clientId,
                setIsRecording,
                setRecordingMode,
                socketRef,
                stopMediaStream,
            });
        };
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

export function stopPlutoRecording(
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

async function finalizeCapture({
    audioCaptureRef,
    audioContext,
    captureGraph,
    clientId,
    setIsRecording,
    setRecordingMode,
    socketRef,
    stopMediaStream,
}: Readonly<{
    audioCaptureRef: { current: PlutoAudioCapture | null };
    audioContext: AudioContext;
    captureGraph: AudioCaptureGraph;
    clientId: string;
    setIsRecording: Dispatch<SetStateAction<boolean>>;
    setRecordingMode: Dispatch<SetStateAction<RecordingMode | null>>;
    socketRef: { current: WebSocket | null };
    stopMediaStream: () => void;
}>) {
    await captureGraph.flush?.().catch(() => undefined);
    captureGraph.dispose();
    audioCaptureRef.current = null;
    setIsRecording(false);
    setRecordingMode(null);
    stopMediaStream();
    await audioContext.close().catch(() => undefined);

    if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(
            JSON.stringify({
                type: 'audio_stream_end',
                clientId,
            }),
        );
    }
}

async function createAudioCaptureGraph({
    audioContext,
    currentClientId,
    mimeType,
    sendAudioChunk,
    source,
}: Readonly<{
    audioContext: AudioContext;
    currentClientId: string;
    mimeType: string;
    sendAudioChunk: (
        currentClientId: string,
        chunk: Blob,
        fallbackMimeType: string,
    ) => Promise<void>;
    source: MediaStreamAudioSourceNode;
}>): Promise<AudioCaptureGraph> {
    if (canUseAudioWorklet(audioContext)) {
        try {
            await audioContext.audioWorklet.addModule(
                PLUTO_AUDIO_CAPTURE_WORKLET_URL,
            );
            return createAudioWorkletCaptureGraph({
                audioContext,
                currentClientId,
                mimeType,
                sendAudioChunk,
                source,
            });
        } catch {
            // Fall back to ScriptProcessorNode when AudioWorklet isn't usable.
        }
    }

    return createScriptProcessorCaptureGraph({
        audioContext,
        currentClientId,
        mimeType,
        sendAudioChunk,
        source,
    });
}

function canUseAudioWorklet(audioContext: AudioContext) {
    return (
        typeof AudioWorkletNode === 'function' &&
        typeof audioContext.audioWorklet?.addModule === 'function'
    );
}

function createAudioWorkletCaptureGraph({
    audioContext,
    currentClientId,
    mimeType,
    sendAudioChunk,
    source,
}: Readonly<{
    audioContext: AudioContext;
    currentClientId: string;
    mimeType: string;
    sendAudioChunk: (
        currentClientId: string,
        chunk: Blob,
        fallbackMimeType: string,
    ) => Promise<void>;
    source: MediaStreamAudioSourceNode;
}>): AudioCaptureGraph {
    const workletNode = new AudioWorkletNode(
        audioContext,
        PLUTO_AUDIO_CAPTURE_WORKLET_NAME,
        {
            channelCount: 1,
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
                chunkFrames: PLUTO_AUDIO_CAPTURE_CHUNK_FRAMES,
            },
        },
    );
    const silenceGain = audioContext.createGain();
    silenceGain.gain.value = 0;

    const flushWaiters = new Set<() => void>();
    workletNode.port.onmessage = (event) => {
        if (event.data instanceof Float32Array) {
            const chunk = createPcmChunkBlob(event.data, audioContext.sampleRate);
            void sendAudioChunk(currentClientId, chunk, mimeType);
            return;
        }

        if (event.data?.type === 'flush-complete') {
            for (const resolve of flushWaiters) {
                resolve();
            }
            flushWaiters.clear();
        }
    };

    source.connect(workletNode);
    workletNode.connect(silenceGain);
    silenceGain.connect(audioContext.destination);

    return {
        dispose: () => {
            workletNode.port.onmessage = null;
            source.disconnect();
            workletNode.disconnect();
            silenceGain.disconnect();
        },
        flush: () =>
            new Promise((resolve) => {
                const timeout = globalThis.setTimeout(() => {
                    flushWaiters.delete(done);
                    resolve();
                }, 200);

                const done = () => {
                    globalThis.clearTimeout(timeout);
                    flushWaiters.delete(done);
                    resolve();
                };

                flushWaiters.add(done);
                workletNode.port.postMessage({ type: 'flush' });
            }),
    };
}

function createScriptProcessorCaptureGraph({
    audioContext,
    currentClientId,
    mimeType,
    sendAudioChunk,
    source,
}: Readonly<{
    audioContext: AudioContext;
    currentClientId: string;
    mimeType: string;
    sendAudioChunk: (
        currentClientId: string,
        chunk: Blob,
        fallbackMimeType: string,
    ) => Promise<void>;
    source: MediaStreamAudioSourceNode;
}>): AudioCaptureGraph {
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        if (input.length === 0) {
            return;
        }

        const chunk = createPcmChunkBlob(
            new Float32Array(input),
            audioContext.sampleRate,
        );
        void sendAudioChunk(currentClientId, chunk, mimeType);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    return {
        dispose: () => {
            processor.onaudioprocess = null;
            source.disconnect();
            processor.disconnect();
        },
    };
}
