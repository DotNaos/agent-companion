import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
    formatApprovalPreview,
    getVisiblePlutoMessage,
    readPlutoVoiceSelection,
    type Bootstrap,
    type PlutoVoiceSelection,
} from '../app-shared.js';
import {
    PlutoAvatar,
    plutoAudioState,
    resetPlutoSpeakingState,
    setPlutoSpeakingState,
} from './PlutoAvatar.js';
import { PlutoVoiceSessionConsole } from './PlutoVoiceSessionConsole.js';

type OverlayViewProps = Readonly<{
    bootstrap: Bootstrap | null;
    desktopToken?: string;
}>;

type AvatarState = 'idle' | 'working' | 'alert' | 'offline';

type AudioGlobal = typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
    _plutoAudioCtx?: AudioContext;
    _plutoAnalyser?: AnalyserNode;
};

const ACTIVE_OVERLAY_FRAME_INTERVAL_MS = 80;
const IDLE_OVERLAY_FRAME_INTERVAL_MS = 350;
const OVERLAY_AUDIO_ANALYSER_INTERVAL_MS = 80;

export function OverlayView({ bootstrap, desktopToken }: OverlayViewProps) {
    const [voiceSelection, setVoiceSelection] = useState<PlutoVoiceSelection>(
        () => readPlutoVoiceSelection(),
    );
    const [frameTime, setFrameTime] = useState(() => Date.now());
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [msgStartTime, setMsgStartTime] = useState(0);
    const [lastMsgId, setLastMsgId] = useState<string | null>(null);
    const approvalCount = bootstrap?.runner.approvals.length ?? 0;
    const primaryApproval = bootstrap?.runner.approvals[0] ?? null;
    const activePlutoMessage = getVisiblePlutoMessage(
        bootstrap?.runner.pluto.activeMessage ?? null,
    );
    const runnerRunning = bootstrap?.desktop.runnerRunning ?? false;
    const isConnected = bootstrap?.runner.status.connectedToRemote ?? false;
    const runningProcesses = bootstrap?.runner.status.runningProcesses ?? 0;
    const plutoPending = bootstrap?.runner.pluto.pending ?? false;
    const latestActivity = bootstrap?.runner.activity.at(-1) ?? null;
    const latestTimestamp = latestActivity
        ? new Date(latestActivity.timestamp).getTime()
        : 0;
    const recentAgeMs =
        latestTimestamp > 0
            ? Date.now() - latestTimestamp
            : Number.POSITIVE_INFINITY;
    const isRecentlyActive = latestTimestamp > 0 && recentAgeMs < 7_500;
    const cursor = bootstrap?.desktop.cursor ?? {
        x: 0,
        y: 0,
        distance: 9999,
        near: false,
    };
    const plutoVoiceSessions = bootstrap?.runner.plutoVoiceSessions ?? [];
    const avatarState = resolveAvatarState(
        runnerRunning,
        isConnected,
        approvalCount,
        runningProcesses,
        isRecentlyActive,
        plutoPending,
    );
    const isProcessing =
        runningProcesses > 0 ||
        plutoPending ||
        (latestActivity?.type === 'tool_call' && recentAgeMs < 1_600);
    const lastPlayedMessageRef = useRef<string | null>(null);

    useEffect(() => {
        const syncSelection = () => {
            setVoiceSelection(readPlutoVoiceSelection());
        };

        globalThis.addEventListener('storage', syncSelection);
        return () => {
            globalThis.removeEventListener('storage', syncSelection);
        };
    }, []);

    useEffect(() => {
        if (activePlutoMessage?.id && activePlutoMessage.id !== lastMsgId) {
            setLastMsgId(activePlutoMessage.id);
            setMsgStartTime(Date.now());
        }
    }, [activePlutoMessage?.id, lastMsgId]);

    const streamProgressChars =
        activePlutoMessage && msgStartTime
            ? Math.floor((frameTime - msgStartTime) / 25)
            : 0;
    const streamedText = activePlutoMessage
        ? activePlutoMessage.text.slice(0, Math.max(0, streamProgressChars))
        : '';

    const shouldAnimateOverlayFrame =
        Boolean(activePlutoMessage) ||
        isSpeaking ||
        isProcessing ||
        approvalCount > 0 ||
        cursor.near;

    useEffect(() => {
        const intervalMs = shouldAnimateOverlayFrame
            ? ACTIVE_OVERLAY_FRAME_INTERVAL_MS
            : IDLE_OVERLAY_FRAME_INTERVAL_MS;
        const intervalId = globalThis.setInterval(() => {
            setFrameTime(Date.now());
        }, intervalMs);
        return () => globalThis.clearInterval(intervalId);
    }, [shouldAnimateOverlayFrame]);

    useEffect(() => {
        if (
            !activePlutoMessage?.audioAvailable ||
            bootstrap?.runner.pluto.muted ||
            lastPlayedMessageRef.current === activePlutoMessage.id
        ) {
            return;
        }

        let objectUrl: string | null = null;
        let cancelled = false;

        void (async () => {
            const response = await fetch(
                `/api/desktop/pluto/audio/${encodeURIComponent(activePlutoMessage.id)}`,
                {
                    headers: desktopToken
                        ? { 'x-desktop-token': desktopToken }
                        : undefined,
                },
            ).catch(() => null);

            if (!response?.ok || cancelled) {
                return;
            }

            const blob = await response.blob();
            if (cancelled) {
                return;
            }

            objectUrl = URL.createObjectURL(blob);
            const audio = new Audio(objectUrl);
            bindAudioState(audio, () => cancelled, setIsSpeaking);
            bindAudioAnalyser(audio, () => cancelled);

            await audio.play().catch(() => undefined);
            lastPlayedMessageRef.current = activePlutoMessage.id;
        })();

        return () => {
            cancelled = true;
            setIsSpeaking(false);
            resetPlutoSpeakingState();
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [
        activePlutoMessage?.audioAvailable,
        activePlutoMessage?.id,
        bootstrap?.runner.pluto.muted,
        desktopToken,
    ]);

    const phase = frameTime / 1000;
    const curiousCycle = (Math.sin(phase * 0.72) + 1) / 2;
    const curious = avatarState === 'idle' && cursor.near && curiousCycle > 0.4;

    async function decideFromOverlay(
        decision: 'approved' | 'denied',
        remember: boolean,
    ) {
        if (!primaryApproval) {
            return;
        }
        await fetch('/api/desktop/approvals/decision', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(desktopToken ? { 'x-desktop-token': desktopToken } : {}),
            },
            body: JSON.stringify({
                id: primaryApproval.id,
                decision,
                remember,
            }),
        });
    }

    let bubbleContent: ReactElement | null = null;
    if (primaryApproval) {
        bubbleContent = (
            <div className="pet-bubble">
                <div className="pet-bubble-chip">
                    {primaryApproval.toolName}
                </div>
                <strong>{primaryApproval.summary}</strong>
                <code className="pet-bubble-command">
                    {formatApprovalPreview(
                        primaryApproval.toolName,
                        primaryApproval.payload,
                    )}
                </code>
                <div className="pet-bubble-actions">
                    <button
                        className="pet-bubble-button ghost"
                        onClick={() => void decideFromOverlay('denied', false)}>
                        Deny
                    </button>
                    <button
                        className="pet-bubble-button secondary"
                        onClick={() =>
                            void decideFromOverlay('approved', true)
                        }>
                        Approve + Remember
                    </button>
                    <button
                        className="pet-bubble-button primary"
                        onClick={() =>
                            void decideFromOverlay('approved', false)
                        }>
                        Approve Once
                    </button>
                </div>
            </div>
        );
    } else if (activePlutoMessage) {
        bubbleContent = (
            <div className="pet-bubble passive">
                <div className="pet-bubble-header">
                    <strong>{activePlutoMessage.title ?? 'Pluto'}</strong>
                </div>
                <p>{streamedText}</p>
            </div>
        );
    }

    return (
        <div className="overlay-shell">
            <div
                className={['pet-dock', avatarState, curious ? 'curious' : '']
                    .filter(Boolean)
                    .join(' ')}>
                {bubbleContent}
                {voiceSelection.sessionId ? (
                    <div className="pet-bubble max-w-88 overflow-hidden">
                        <PlutoVoiceSessionConsole
                            apiBase="/api/desktop"
                            desktopToken={desktopToken}
                            sessionId={voiceSelection.sessionId}
                            clientId={voiceSelection.clientId}
                            sessions={plutoVoiceSessions}
                            variant="overlay"
                            onError={() => undefined}
                            onInfo={() => undefined}
                        />
                    </div>
                ) : null}
                <button
                    type="button"
                    className="pluto-hit-target"
                    aria-label="Open Pluto dashboard"
                    onClick={() => {
                        globalThis.window.agentCompanion?.showDashboard?.();
                    }}>
                    <PlutoAvatar
                        avatarState={avatarState}
                        cursor={cursor}
                        isProcessing={isProcessing}
                        isSpeaking={isSpeaking}
                        curious={curious}
                        phase={phase}
                        blink={buildBlink(phase, avatarState, curious)}
                    />
                </button>
                {avatarState === 'offline' ? (
                    <div className="pet-sleep" aria-hidden="true">
                        <span>Z</span>
                        <span>z</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

function resolveAvatarState(
    runnerRunning: boolean,
    isConnected: boolean,
    approvalCount: number,
    runningProcesses: number,
    isRecentlyActive: boolean,
    plutoPending: boolean,
): AvatarState {
    if (!runnerRunning || !isConnected) {
        return 'offline';
    }
    if (approvalCount > 0) {
        return 'alert';
    }
    if (runningProcesses > 0 || isRecentlyActive || plutoPending) {
        return 'working';
    }
    return 'idle';
}

function buildBlink(phase: number, avatarState: AvatarState, curious: boolean) {
    if (curious) {
        return 0.18;
    }
    if (avatarState === 'alert') {
        return 0.08 + Math.max(0, Math.sin(phase * 6.8)) * 0.1;
    }
    const cycle = (phase * (avatarState === 'working' ? 1.35 : 0.9)) % 4.2;
    if (cycle < 3.72) {
        return 0;
    }
    const progress = (cycle - 3.72) / 0.48;
    return Math.sin(progress * Math.PI);
}

function bindAudioState(
    audio: HTMLAudioElement,
    isCancelled: () => boolean,
    setIsSpeaking: (value: boolean) => void,
) {
    const onSpeaking = (speaking: boolean) => {
        if (isCancelled()) {
            return;
        }
        setIsSpeaking(speaking);
        setPlutoSpeakingState(speaking, plutoAudioState.volume);
    };

    audio.addEventListener('play', () => onSpeaking(true));
    audio.addEventListener('ended', () => onSpeaking(false));
    audio.addEventListener('pause', () => onSpeaking(false));
}

function bindAudioAnalyser(
    audio: HTMLAudioElement,
    isCancelled: () => boolean,
) {
    const globals = globalThis as AudioGlobal;
    let volumeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

    const connectAnalyser = () => {
        try {
            let ctx = globals._plutoAudioCtx;
            if (!ctx) {
                const AudioContextCtor =
                    globalThis.AudioContext ?? globals.webkitAudioContext;
                if (!AudioContextCtor) {
                    return;
                }
                ctx = new AudioContextCtor();
                globals._plutoAudioCtx = ctx;
            }
            if (ctx.state === 'suspended') {
                void ctx.resume();
            }

            let analyser = globals._plutoAnalyser;
            if (!analyser) {
                analyser = ctx.createAnalyser();
                analyser.fftSize = 256;
                globals._plutoAnalyser = analyser;
            }

            if (
                !(audio as HTMLAudioElement & { _hasSourceConnected?: boolean })
                    ._hasSourceConnected
            ) {
                const source = ctx.createMediaElementSource(audio);
                source.connect(analyser);
                analyser.connect(ctx.destination);
                (
                    audio as HTMLAudioElement & {
                        _hasSourceConnected?: boolean;
                    }
                )._hasSourceConnected = true;
            }

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const updateVolume = () => {
                if (audio.paused || audio.ended || isCancelled()) {
                    if (volumeTimer !== null) {
                        globalThis.clearTimeout(volumeTimer);
                        volumeTimer = null;
                    }
                    resetPlutoSpeakingState();
                    return;
                }

                analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (const value of dataArray) {
                    sum += value;
                }
                const average = sum / dataArray.length;
                setPlutoSpeakingState(true, average / 255);

                volumeTimer = globalThis.setTimeout(
                    updateVolume,
                    OVERLAY_AUDIO_ANALYSER_INTERVAL_MS,
                );
            };

            updateVolume();
        } catch (error) {
            console.error('Audio analyser failed:', error);
        }
    };

    audio.addEventListener('play', connectAnalyser);
    audio.addEventListener('ended', () => {
        if (volumeTimer !== null) {
            globalThis.clearTimeout(volumeTimer);
            volumeTimer = null;
        }
    });
    audio.addEventListener('pause', () => {
        if (volumeTimer !== null) {
            globalThis.clearTimeout(volumeTimer);
            volumeTimer = null;
        }
    });
}
