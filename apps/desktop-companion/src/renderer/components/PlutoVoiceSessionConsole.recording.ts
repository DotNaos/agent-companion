import type { Dispatch, SetStateAction } from 'react';
import { blobToBase64, createPcmChunkBlob, getPlutoPcmMimeType } from './PlutoVoiceSessionConsole.audio.js';
import type {
    PlutoAudioCapture,
    RecordingMode,
    VoiceTimelineEntry,
} from './PlutoVoiceSessionConsole.shared.js';

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
