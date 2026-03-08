import { Mic, MicOff, Radio } from 'lucide-react';
import type {
    RecordingMode,
    StreamState,
    VoiceConsolePrimaryAction,
    VoiceRoleStatus,
} from './PlutoVoiceSessionConsole.shared.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';

type VoiceChatComposerProps = Readonly<{
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
}>;

export function VoiceChatComposer({
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
}: VoiceChatComposerProps) {
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

export function getVoiceChatInputPlaceholder({
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

export function getRecordingHint(
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

export function getRoleStatus({
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
}>): VoiceRoleStatus | null {
    if (!hasSession) {
        return null;
    }
    if (isSpeaker) {
        return {
            tone: 'accent',
            message:
                'You have the mic. Hit Record, speak, then tap again to send your turn to Pluto.',
        };
    }
    if (hasSpeaker) {
        return {
            tone: 'neutral',
            message: isOverlay
                ? 'You are listening only right now. Open the dashboard and use “Take mic” when the current speaker is done.'
                : 'You are listening only right now. The session card keeps “Take mic” visible and it will enable itself when the mic becomes free.',
        };
    }
    if (canRequestSpeaker) {
        return {
            tone: 'accent',
            message:
                'The mic is free. Tap “Take mic” below to become the speaker.',
        };
    }
    if (hasClient) {
        return {
            tone: 'neutral',
            message:
                'You are attached to the session, but the mic action is not available here yet.',
        };
    }
    return {
        tone: 'neutral',
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
}>): VoiceConsolePrimaryAction {
    if (isTakingMic) {
        return {
            disabled: true,
            label: 'Taking mic…',
            mode: 'take-mic',
        };
    }

    if (isRecording) {
        return {
            disabled: false,
            label: 'Stop & send',
            mode: 'record',
        };
    }

    if (canRequestSpeaker) {
        return {
            disabled: streamState !== 'connected' || !hasSession || !hasClient,
            label: 'Take mic',
            mode: 'take-mic',
        };
    }

    return {
        disabled:
            streamState !== 'connected' ||
            !hasSession ||
            !hasClient ||
            !isSpeaker,
        label: 'Record',
        mode: 'record',
    };
}

export function getLiveMicFeedback(level: number) {
    if (level > 0.5) {
        return 'Yep — I can hear you clearly.';
    }
    if (level > 0.22) {
        return 'I can hear something. Keep talking.';
    }
    return 'Say something — the mic level should jump here.';
}
