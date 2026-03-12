import type { PlutoVoiceSessionSummary } from '@agent-companion/shared';

export type VoiceTimelineEntry = {
	id: string;
	label: string;
	text: string;
	details?: string;
	actor: 'you' | 'pluto' | 'system';
	tone: 'neutral' | 'accent' | 'error';
	createdAt: string;
	turnId?: number;
	overlayBubble?: boolean;
};

export type VoiceTimelineDraftEntry = Omit<
	VoiceTimelineEntry,
	'id' | 'createdAt'
>;

export type OverlayBubblePreview = {
	id: string;
	actor: VoiceTimelineEntry['actor'];
	title: string;
	text: string;
	tone: VoiceTimelineEntry['tone'];
};

export type OverlayConversationActivity = {
	isSpeaking: boolean;
	isToolCalling: boolean;
};

export type StreamState = 'idle' | 'connecting' | 'connected' | 'closed';
export type RecordingMode = 'push-to-talk' | 'live';

export type PlutoAudioCapture = {
	stop: () => void;
};

export type VoiceConsoleInlineNotice = {
	tone: 'neutral' | 'accent' | 'error';
	message: string;
};

export type VoiceRoleStatus = {
	tone: 'neutral' | 'accent';
	message: string;
};

export type VoiceConsolePrimaryAction = {
	disabled: boolean;
	label: string;
	mode: 'take-mic' | 'record';
};

export type PlutoVoiceSessionConsoleProps = Readonly<{
	apiBase: string;
	desktopToken?: string;
	sessionId: string | null;
	clientId: string | null;
	sessions: PlutoVoiceSessionSummary[];
	variant?: 'panel' | 'overlay';
	onOverlayPreviewChange?: (previews: OverlayBubblePreview[]) => void;
	onOverlayActivityChange?: (
		activity: OverlayConversationActivity,
	) => void;
	onRequestSpeaker?: (sessionId: string) => Promise<void> | void;
	onError: (message: string) => void;
	onInfo: (message: string) => void;
}>;

export const PLUTO_AUDIO_INPUT_STORAGE_KEY =
	'agent-companion.pluto-audio-input';
export const PLUTO_AUDIO_OUTPUT_STORAGE_KEY =
	'agent-companion.pluto-audio-output';
