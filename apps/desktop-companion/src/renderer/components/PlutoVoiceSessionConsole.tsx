import { Expand, Mic, MicOff, Radio, Volume2 } from 'lucide-react';
import { useEffect } from 'react';
import { VoiceChatComposer } from './PlutoVoiceSessionConsole.controls.js';
import { VoiceConsoleSupportPanel } from './PlutoVoiceSessionConsole.device-panel.js';
import type { PlutoVoiceSessionConsoleProps } from './PlutoVoiceSessionConsole.shared.js';
import {
    deriveOverlayBubblePreviewHistory,
    renderVoiceTimeline,
} from './PlutoVoiceSessionConsole.timeline.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from './ui/dialog.js';
import { ScrollArea } from './ui/scroll-area.js';
import { usePlutoVoiceSessionConsole } from './usePlutoVoiceSessionConsole.js';

export function PlutoVoiceSessionConsole(props: PlutoVoiceSessionConsoleProps) {
    const {
        activeStatusMessage,
        audioDevices,
        canRequestSpeaker,
        expandedScrollAreaRef,
        inlineNotice,
        inputPlaceholder,
        isChatExpanded,
        isOverlay,
        isPlaying,
        isRecording,
        isSpeaker,
        isTakingMic,
        liveMicFeedback,
        micLevel,
        panelScrollAreaRef,
        primaryAction,
        recordingHint,
        recordingMode,
        remoteSpeechActive,
        roleStatus,
        sessionId,
        setIsChatExpanded,
        setTextDraft,
        streamState,
        submitTextDraft,
        textDraft,
        timeline,
        toggleRecording,
        requestMic,
        visibleTimeline,
    } = usePlutoVoiceSessionConsole(props);

    const isToolCalling =
        activeStatusMessage?.startsWith('Codex uses ') ?? false;

    useEffect(() => {
        props.onOverlayPreviewChange?.(
            deriveOverlayBubblePreviewHistory(timeline, 2),
        );
    }, [props.onOverlayPreviewChange, timeline]);

    useEffect(() => {
        props.onOverlayActivityChange?.({
            isSpeaking: isPlaying || remoteSpeechActive,
            isToolCalling,
        });
    }, [isPlaying, isToolCalling, props.onOverlayActivityChange, remoteSpeechActive]);

    if (isOverlay) {
        return (
            <div className="flex w-full flex-col gap-2 text-left">
                {visibleTimeline.length > 0
                    ? renderVoiceTimeline(visibleTimeline, true)
                    : null}
            </div>
        );
    }

    return (
        <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4">
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
                <StatusBadges streamState={streamState} isPlaying={isPlaying} />
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
                activeStatusMessage={activeStatusMessage}
                isRecording={isRecording}
                liveMicFeedback={liveMicFeedback}
                micLevel={micLevel}
                inlineNotice={inlineNotice}
                canEnumerateDevices={audioDevices.canEnumerateDevices}
                isOverlay={false}
                availableInputs={audioDevices.availableInputs}
                availableOutputs={audioDevices.availableOutputs}
                selectedInputId={audioDevices.selectedInputId}
                selectedOutputId={audioDevices.selectedOutputId}
                canRouteOutputDevice={audioDevices.canRouteOutputDevice}
                inputDeviceHint={audioDevices.inputDeviceHint}
                onSelectInput={audioDevices.setSelectedInputId}
                onSelectOutput={audioDevices.setSelectedOutputId}
            />

            <ScrollArea
                ref={panelScrollAreaRef}
                className="mt-4 h-56 rounded-2xl border border-white/10 bg-black/30 p-3">
                {renderVoiceTimeline(visibleTimeline, false)}
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
                                <StatusBadges
                                    streamState={streamState}
                                    isPlaying={isPlaying}
                                />
                            </div>
                            {activeStatusMessage ? (
                                <div className="mb-4 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-300">
                                    {activeStatusMessage}
                                </div>
                            ) : null}
                            <ScrollArea
                                ref={expandedScrollAreaRef}
                                className="min-h-0 flex-1 rounded-2xl border border-white/10 bg-black/25 p-4">
                                {renderVoiceTimeline(timeline, false)}
                            </ScrollArea>
                        </div>
                        <VoiceChatComposer
                            canRequestSpeaker={canRequestSpeaker}
                            canSend={Boolean(
                                sessionId && props.clientId && isSpeaker,
                            )}
                            draft={textDraft}
                            inputDisabled={
                                !sessionId || !props.clientId || !isSpeaker
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
                            placeholder={inputPlaceholder}
                        />
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function StatusBadges({
    streamState,
    isPlaying,
}: Readonly<{
    streamState: 'idle' | 'connecting' | 'connected' | 'closed';
    isPlaying: boolean;
}>) {
    return (
        <>
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
        </>
    );
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

export {
    createPcmChunkBlob,
    encodePcm16Chunk,
    getPlutoPcmMimeType
} from './PlutoVoiceSessionConsole.audio.js';
export { getVoiceConsolePrimaryAction } from './PlutoVoiceSessionConsole.controls.js';
export {
    appendVoiceTimelineEntry,
    deriveLatestOverlayBubble,
    deriveOverlayBubblePreviewHistory,
    getVoiceTimelineLayout,
    mergeVoiceTimelineText,
    shouldMergeVoiceTimelineEntry
} from './PlutoVoiceSessionConsole.timeline.js';
