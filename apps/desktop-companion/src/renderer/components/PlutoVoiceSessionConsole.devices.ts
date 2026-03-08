import { useEffect, useMemo, useState } from 'react';
import {
    PLUTO_AUDIO_INPUT_STORAGE_KEY,
    PLUTO_AUDIO_OUTPUT_STORAGE_KEY,
} from './PlutoVoiceSessionConsole.shared.js';

type DeviceHookOptions = Readonly<{
    isRecording: boolean;
    onInfo: (message: string) => void;
}>;

export function usePlutoAudioDevices({
    isRecording,
    onInfo,
}: DeviceHookOptions) {
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

    const canEnumerateDevices = Boolean(
        globalThis.navigator?.mediaDevices?.enumerateDevices,
    );
    const canRouteOutputDevice = useMemo(
        () => supportsOutputDeviceSelection(),
        [],
    );
    const inputDeviceHint = getInputDeviceHint({
        canEnumerateDevices,
        availableInputs,
        isRecording,
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

    function selectInput(nextValue: string | null) {
        setSelectedInputId(nextValue);
        onInfo(
            nextValue
                ? 'Microphone preference updated for Pluto voice chat.'
                : 'Microphone set to the system default input.',
        );
    }

    function selectOutput(nextValue: string | null) {
        setSelectedOutputId(nextValue);
        onInfo(
            nextValue
                ? 'Playback device preference updated for Pluto voice chat.'
                : 'Playback set to the system default output.',
        );
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

    return {
        availableInputs,
        availableOutputs,
        selectedInputId,
        selectedOutputId,
        canEnumerateDevices,
        canRouteOutputDevice,
        inputDeviceHint,
        refreshAudioDevices,
        setSelectedInputId: selectInput,
        setSelectedOutputId: selectOutput,
    };
}

export function supportsOutputDeviceSelection() {
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

export async function applyOutputDeviceToAudioContext(
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
        try {
            if (contextWithSink.sinkId !== targetDeviceId) {
                await contextWithSink.setSinkId(targetDeviceId);
            }
            return;
        } catch {
            if (!warningShownRef.current) {
                warningShownRef.current = true;
                onInfo(
                    'Pluto could not open the selected playback device and will use the system default output instead.',
                );
            }
            return;
        }
    }

    if (deviceId && !warningShownRef.current) {
        warningShownRef.current = true;
        onInfo(
            'Playback device selection is not supported here; Pluto will use the system default output.',
        );
    }
}

export async function applyOutputDeviceToAudioElement(
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
        try {
            await audioWithSink.setSinkId(targetDeviceId);
            return;
        } catch {
            if (!warningShownRef.current) {
                warningShownRef.current = true;
                onInfo(
                    'Pluto could not open the selected playback device and will use the system default output instead.',
                );
            }
            return;
        }
    }

    if (deviceId && !warningShownRef.current) {
        warningShownRef.current = true;
        onInfo(
            'Playback device selection is not supported here; Pluto will use the system default output.',
        );
    }
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
