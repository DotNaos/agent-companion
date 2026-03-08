import type {
    ActivityEvent,
    AgentCompanionConfig,
    ApprovalRequest,
    PlutoMessage,
    PlutoState,
    PlutoVoiceSessionAttachOutput,
    PlutoVoiceSessionCreateOutput,
    PlutoVoiceSessionSummary,
    RunnerStatus,
} from '@agent-companion/shared';
import {
    ArrowLeft,
    Check,
    ChevronRight,
    Copy,
    ExternalLink,
    FolderOpen,
    Plus,
    Trash2,
    X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PlutoAvatar, plutoAudioState } from './components/PlutoAvatar.js';
import { PlutoVoiceSessionConsole } from './components/PlutoVoiceSessionConsole.js';
import { Badge } from './components/ui/badge.js';
import { Button, buttonVariants } from './components/ui/button.js';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from './components/ui/card.js';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from './components/ui/dialog.js';
import { Input } from './components/ui/input.js';
import { Label } from './components/ui/label.js';
import { ScrollArea } from './components/ui/scroll-area.js';
import { Textarea } from './components/ui/textarea.js';
import { cn } from './lib/utils.js';

type Bootstrap = {
    runner: {
        status: RunnerStatus;
        config: AgentCompanionConfig | null;
        activity: ActivityEvent[];
        approvals: ApprovalRequest[];
        pluto: PlutoState;
        plutoVoiceSessions: PlutoVoiceSessionSummary[];
    };
    desktop: {
        runnerRunning: boolean;
        runnerLastError: string | null;
        tunnelRunning: boolean;
        publicAdminUrl: string | null;
        publicMcpUrl: string | null;
        cursor: {
            x: number;
            y: number;
            distance: number;
            near: boolean;
        };
    };
};

type Mode = 'desktop' | 'overlay' | 'admin' | 'login';
type MCPAccessMode = AgentCompanionConfig['mcpAccessMode'];
type RunCommandMatchMode =
    AgentCompanionConfig['runCommandRules'][number]['matchMode'];

declare global {
    interface Window {
        agentCompanion?: {
            platform: string;
            selectDirectory?: () => Promise<string | null>;
            setIgnoreMouseEvents?: (ignore: boolean) => void;
            showDashboard?: () => Promise<boolean>;
        };
    }
}

const ACCESS_MODE_OPTIONS: Array<{
    value: MCPAccessMode;
    label: string;
    description: string;
}> = [
    {
        value: 'read-only',
        label: 'Read only',
        description:
            'Can read, search and list files inside the allowed paths.',
    },
    {
        value: 'default',
        label: 'Default',
        description:
            'Can edit files, run tasks and execute only commands that are explicitly allowlisted.',
    },
    {
        value: 'full-access',
        label: 'Full access',
        description:
            'Can use all MCP features inside the allowed paths, including arbitrary commands.',
    },
];

const AUTO_SAVE_DELAY_MS = 900;
const PLUTO_VOICE_SELECTION_STORAGE_KEY =
    'agent-companion.pluto-voice-selection';

type PlutoVoiceSelection = {
    sessionId: string | null;
    clientId: string | null;
};

export function App() {
    const mode = (document.body.dataset.mode as Mode | undefined) ?? 'desktop';
    const desktopToken =
        new URLSearchParams(window.location.search).get('desktopToken') ??
        undefined;
    const apiBase =
        mode === 'admin' || mode === 'login' ? '/api/admin' : '/api/desktop';
    const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
    const [draftConfig, setDraftConfig] = useState<AgentCompanionConfig | null>(
        null,
    );
    const draftDirtyRef = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [plutoTriggerPending, setPlutoTriggerPending] = useState(false);
    const [plutoSessionActionPending, setPlutoSessionActionPending] = useState<
        string | null
    >(null);
    const [localSessionClients, setLocalSessionClients] = useState<
        Record<string, string>
    >({});
    const [activeVoiceSessionId, setActiveVoiceSessionId] = useState<
        string | null
    >(() => readPlutoVoiceSelection().sessionId);
    const [showSetupGuide, setShowSetupGuide] = useState(false);
    const [showFullAccessConfirm, setShowFullAccessConfirm] = useState(false);
    const [currentView, setCurrentView] = useState<
        'dashboard' | 'permissions' | 'approvals' | 'activity'
    >('dashboard');
    const autosaveTimeoutRef = useRef<ReturnType<
        typeof globalThis.setTimeout
    > | null>(null);
    const draftVersionRef = useRef(0);
    const plutoVoiceSessions = bootstrap?.runner.plutoVoiceSessions ?? [];
    const activeVoiceSessionClientId = activeVoiceSessionId
        ? (localSessionClients[activeVoiceSessionId] ?? null)
        : null;

    function replaceDraftConfig(nextConfig: AgentCompanionConfig | null) {
        draftDirtyRef.current = false;
        setDraftConfig(nextConfig);
    }

    function updateDraftConfig(
        updater: (current: AgentCompanionConfig) => AgentCompanionConfig,
    ) {
        setDraftConfig((current) => {
            if (!current) {
                return current;
            }
            draftDirtyRef.current = true;
            draftVersionRef.current += 1;
            return updater(current);
        });
    }

    function syncBootstrap(nextBootstrap: Bootstrap, forceDraft = false) {
        setBootstrap(nextBootstrap);
        if (forceDraft || !draftDirtyRef.current) {
            replaceDraftConfig(nextBootstrap.runner.config);
        }
    }

    function updateAccessMode(nextMode: MCPAccessMode) {
        if (
            nextMode === 'full-access' &&
            draftConfig?.mcpAccessMode !== 'full-access'
        ) {
            setShowFullAccessConfirm(true);
            return;
        }

        updateDraftConfig((current) => ({
            ...current,
            mcpAccessMode: nextMode,
        }));
    }

    function confirmFullAccessMode() {
        setShowFullAccessConfirm(false);
        updateDraftConfig((current) => ({
            ...current,
            mcpAccessMode: 'full-access',
        }));
    }

    useEffect(() => {
        const persistedSelection = readPlutoVoiceSelection();
        if (persistedSelection.sessionId && persistedSelection.clientId) {
            setLocalSessionClients((current) => ({
                ...current,
                [persistedSelection.sessionId!]: persistedSelection.clientId!,
            }));
        }
    }, []);

    useEffect(() => {
        writePlutoVoiceSelection({
            sessionId: activeVoiceSessionId,
            clientId: activeVoiceSessionClientId,
        });
    }, [activeVoiceSessionClientId, activeVoiceSessionId]);

    useEffect(() => {
        void fetchBootstrap();

        const streamPath =
            mode === 'admin' || mode === 'login'
                ? '/api/admin/stream'
                : `/api/desktop/stream?desktopToken=${encodeURIComponent(desktopToken ?? '')}`;
        const streamUrl = new URL(streamPath, window.location.origin);
        streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(streamUrl);
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data) as {
                type: string;
                data: Bootstrap;
            };
            if (message.type === 'bootstrap') {
                syncBootstrap(message.data);
            }
        });
        socket.addEventListener('error', () => {
            if (mode === 'admin') {
                setError(
                    'Realtime stream unavailable. The admin API may require login.',
                );
            }
        });
        return () => socket.close();
    }, [apiBase, desktopToken, mode]);

    useEffect(() => {
        if (
            activeVoiceSessionId &&
            !plutoVoiceSessions.some(
                (session) => session.id === activeVoiceSessionId,
            )
        ) {
            setActiveVoiceSessionId(null);
            writePlutoVoiceSelection({
                sessionId: null,
                clientId: null,
            });
        }
    }, [activeVoiceSessionId, plutoVoiceSessions]);

    useEffect(() => {
        if (!draftConfig || !draftDirtyRef.current) {
            return;
        }

        if (autosaveTimeoutRef.current !== null) {
            globalThis.clearTimeout(autosaveTimeoutRef.current);
        }

        const draftToSave = draftConfig;
        const versionToSave = draftVersionRef.current;

        autosaveTimeoutRef.current = globalThis.setTimeout(() => {
            autosaveTimeoutRef.current = null;
            void saveConfig(draftToSave, versionToSave);
        }, AUTO_SAVE_DELAY_MS);

        return () => {
            if (autosaveTimeoutRef.current !== null) {
                globalThis.clearTimeout(autosaveTimeoutRef.current);
                autosaveTimeoutRef.current = null;
            }
        };
    }, [draftConfig]);

    const activity = bootstrap?.runner.activity ?? [];
    const approvals = bootstrap?.runner.approvals ?? [];
    const desktopBridge = globalThis.window?.agentCompanion;
    const canBrowseDirectories =
        typeof desktopBridge?.selectDirectory === 'function';

    if (mode === 'overlay') {
        return (
            <OverlayView bootstrap={bootstrap} desktopToken={desktopToken} />
        );
    }

    if (mode === 'login') {
        return <LoginView />;
    }

    return (
        <div
            className={cn(
                'min-h-screen w-full bg-slate-950 text-slate-50 font-sans selection:bg-white/30',
                mode,
            )}>
            <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between border-b border-white/10 bg-slate-950/80 px-6 backdrop-blur-md">
                <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                        <span className="text-xs font-semibold tracking-wider text-white uppercase">
                            agent-companion
                        </span>
                        <h1 className="text-2xl! md:text-3xl! font-bold tracking-tight leading-none">
                            {mode === 'admin'
                                ? 'Remote Admin'
                                : 'Desktop Companion'}
                        </h1>
                    </div>
                    <Badge
                        variant="outline"
                        className="ml-2 border-white/10 text-slate-400">
                        {bootstrap?.desktop.runnerRunning
                            ? bootstrap?.runner.status.connectedToRemote
                                ? 'Connected'
                                : 'Starting'
                            : 'Offline'}
                    </Badge>
                </div>

                <div className="flex items-center gap-3">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setShowSetupGuide(true)}>
                        Setup Guide
                    </Button>
                    {mode === 'admin' ? (
                        <>
                            <a
                                className={buttonVariants({
                                    variant: 'secondary',
                                    size: 'sm',
                                })}
                                href="/auth/login/google">
                                Switch Account
                            </a>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={async () => {
                                    await fetch('/auth/logout', {
                                        method: 'POST',
                                    });
                                    window.location.href = '/login';
                                }}>
                                Sign Out
                            </Button>
                        </>
                    ) : null}
                </div>
            </header>

            <main className="container mx-auto max-w-5xl py-8 px-4 grid gap-8">
                {error && (
                    <div className="rounded-3xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
                        {error}
                    </div>
                )}
                {statusMessage && (
                    <div className="rounded-3xl border border-white/20 bg-white/10 p-4 text-sm text-slate-200">
                        {statusMessage}
                    </div>
                )}
                {(!bootstrap?.desktop.tunnelRunning ||
                    !bootstrap?.desktop.publicMcpUrl) && (
                    <div className="flex items-center justify-between rounded-3xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm text-blue-200">
                        <span>
                            Finish the ChatGPT MCP setup before linking the app
                            in ChatGPT.
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-blue-300 hover:text-blue-100 hover:bg-blue-500/20"
                            onClick={() => setShowSetupGuide(true)}>
                            View steps
                        </Button>
                    </div>
                )}

                {currentView === 'dashboard' && (
                    <div className="grid gap-4 md:grid-cols-3 auto-rows-min">
                        <Card className="md:col-span-2">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-medium text-slate-400">
                                    Runner Status
                                </CardTitle>
                            </CardHeader>
                            <CardContent>
                                <div className="text-2xl font-semibold">
                                    {bootstrap?.desktop.runnerRunning
                                        ? bootstrap?.runner.status
                                              .connectedToRemote
                                            ? 'Connected'
                                            : 'Starting'
                                        : 'Offline'}
                                </div>
                            </CardContent>
                        </Card>

                        <Card className="md:col-span-1">
                            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
                                <CardTitle className="text-sm font-medium text-slate-400">
                                    Tunnel Status
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="flex items-center justify-between">
                                <div className="text-2xl font-semibold">
                                    {bootstrap?.desktop.tunnelRunning
                                        ? 'Running'
                                        : 'Stopped'}
                                </div>
                                <Button
                                    variant={
                                        bootstrap?.desktop.tunnelRunning
                                            ? 'outline'
                                            : 'default'
                                    }
                                    size="sm"
                                    onClick={toggleTunnel}>
                                    {bootstrap?.desktop.tunnelRunning
                                        ? 'Stop Tunnel'
                                        : 'Start Tunnel'}
                                </Button>
                            </CardContent>
                        </Card>

                        <Card
                            className="group cursor-pointer hover:border-white/30 transition-colors bg-white/5 border-white/10 flex flex-col md:col-span-1"
                            onClick={() => setCurrentView('permissions')}>
                            <CardHeader>
                                <CardTitle className="text-lg flex items-center justify-between">
                                    Permissions
                                    <ChevronRight className="h-4 w-4 text-slate-500 group-hover:text-white transition-colors" />
                                </CardTitle>
                                <CardDescription>
                                    Configure allowed paths and rules
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="flex-1 flex flex-col justify-end">
                                <div className="flex flex-wrap gap-2 mt-4">
                                    <Badge
                                        variant="secondary"
                                        className="bg-black/40 text-slate-300 border-white/10">
                                        {draftConfig?.mcpAccessMode || '...'}{' '}
                                        mode
                                    </Badge>
                                    <Badge
                                        variant="secondary"
                                        className="bg-black/40 text-slate-300 border-white/10">
                                        {draftConfig?.allowedPaths.length ?? 0}{' '}
                                        paths
                                    </Badge>
                                </div>
                            </CardContent>
                        </Card>

                        <Card
                            className={cn(
                                'group cursor-pointer hover:border-white/30 transition-colors flex flex-col md:col-span-1',
                                approvals.length > 0
                                    ? 'bg-amber-500/10 border-amber-500/30 hover:border-amber-500/50'
                                    : 'bg-white/5 border-white/10',
                            )}
                            onClick={() => setCurrentView('approvals')}>
                            <CardHeader>
                                <CardTitle className="text-lg flex items-center justify-between">
                                    Approvals
                                    <ChevronRight className="h-4 w-4 text-slate-500 group-hover:text-white transition-colors" />
                                </CardTitle>
                                <CardDescription>
                                    Review pending tool requests
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="flex-1 flex flex-col justify-end">
                                <div className="text-3xl font-light mt-4">
                                    {approvals.length}{' '}
                                    <span className="text-sm font-normal text-slate-400">
                                        pending
                                    </span>
                                </div>
                            </CardContent>
                        </Card>

                        <Card
                            className="group cursor-pointer hover:border-white/30 transition-colors bg-white/5 border-white/10 flex flex-col md:col-span-1"
                            onClick={() => setCurrentView('activity')}>
                            <CardHeader>
                                <CardTitle className="text-lg flex items-center justify-between">
                                    Live Activity
                                    <ChevronRight className="h-4 w-4 text-slate-500 group-hover:text-white transition-colors" />
                                </CardTitle>
                                <CardDescription>
                                    Recent events and logs
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="flex-1 flex flex-col justify-end">
                                {activity.length > 0 ? (
                                    <div className="text-xs text-slate-300 truncate font-mono mt-4 bg-black/40 p-2 rounded-lg border border-white/5">
                                        {activity.at(-1)?.message ??
                                            'No recent activity'}
                                    </div>
                                ) : (
                                    <div className="text-sm text-slate-500 mt-4">
                                        No logs recorded
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        <Card className="md:col-span-3 bg-white/5 border-white/10">
                            <CardHeader className="pb-3">
                                <CardTitle className="text-lg">Pluto</CardTitle>
                                <CardDescription>
                                    Local secretary mode with Gemini-based
                                    commentary plus the first shared
                                    voice-session registry for desktop and
                                    future mobile clients.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                                <div className="flex flex-col gap-4">
                                    <div className="flex flex-wrap gap-2">
                                        <Badge
                                            variant="secondary"
                                            className="bg-black/40 text-slate-300 border-white/10">
                                            {bootstrap?.runner.pluto.available
                                                ? 'Gemini ready'
                                                : 'Gemini offline'}
                                        </Badge>
                                        <Badge
                                            variant="secondary"
                                            className="bg-black/40 text-slate-300 border-white/10">
                                            {draftConfig?.pluto.muted
                                                ? 'Muted'
                                                : 'Voice on'}
                                        </Badge>
                                        <Badge
                                            variant="secondary"
                                            className="bg-black/40 text-slate-300 border-white/10">
                                            {draftConfig?.pluto
                                                .autoCommentaryEnabled
                                                ? `Auto every ${Math.round((draftConfig.pluto.commentaryIntervalMs ?? 30_000) / 1000)}s`
                                                : 'Auto commentary off'}
                                        </Badge>
                                        <Badge
                                            variant="secondary"
                                            className="bg-black/40 text-slate-300 border-white/10">
                                            {plutoVoiceSessions.length} voice
                                            session
                                            {plutoVoiceSessions.length === 1
                                                ? ''
                                                : 's'}
                                        </Badge>
                                    </div>
                                    <div className="flex flex-wrap gap-3">
                                        <Button
                                            size="sm"
                                            onClick={() =>
                                                void triggerPlutoCommentary()
                                            }
                                            disabled={
                                                plutoTriggerPending ||
                                                !bootstrap?.runner.pluto
                                                    .available ||
                                                bootstrap?.runner.pluto.pending
                                            }>
                                            {plutoTriggerPending
                                                ? 'Pluto kommentiert…'
                                                : 'Trigger commentary'}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() =>
                                                updateDraftConfig(
                                                    (current) => ({
                                                        ...current,
                                                        pluto: {
                                                            ...current.pluto,
                                                            muted: !current
                                                                .pluto.muted,
                                                        },
                                                    }),
                                                )
                                            }>
                                            {draftConfig?.pluto.muted
                                                ? 'Unmute Pluto'
                                                : 'Mute Pluto'}
                                        </Button>
                                        <Button
                                            variant={
                                                draftConfig?.pluto
                                                    .autoCommentaryEnabled
                                                    ? 'outline'
                                                    : 'default'
                                            }
                                            size="sm"
                                            onClick={() =>
                                                updateDraftConfig(
                                                    (current) => ({
                                                        ...current,
                                                        pluto: {
                                                            ...current.pluto,
                                                            autoCommentaryEnabled:
                                                                !current.pluto
                                                                    .autoCommentaryEnabled,
                                                        },
                                                    }),
                                                )
                                            }>
                                            {draftConfig?.pluto
                                                .autoCommentaryEnabled
                                                ? 'Pause commentary'
                                                : 'Enable commentary'}
                                        </Button>
                                    </div>
                                </div>

                                <div className="rounded-3xl border border-white/10 bg-black/20 p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <h3 className="text-sm font-semibold text-slate-100">
                                                Voice sessions
                                            </h3>
                                            <p className="mt-1 text-xs text-slate-400">
                                                Start a shared Pluto
                                                conversation on desktop now;
                                                iPhone and Watch clients can
                                                dock here later.
                                            </p>
                                        </div>
                                        <Button
                                            size="sm"
                                            onClick={() =>
                                                void createPlutoVoiceSession()
                                            }
                                            disabled={
                                                plutoSessionActionPending ===
                                                'create'
                                            }>
                                            {plutoSessionActionPending ===
                                            'create'
                                                ? 'Starting…'
                                                : 'Start voice session'}
                                        </Button>
                                    </div>

                                    <div className="mt-4 space-y-3">
                                        {plutoVoiceSessions.length === 0 ? (
                                            <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm text-slate-400">
                                                No live Pluto sessions yet. Time
                                                to give the tiny space gremlin a
                                                microphone.
                                            </div>
                                        ) : (
                                            plutoVoiceSessions.map(
                                                (session) => {
                                                    const knownClientId =
                                                        localSessionClients[
                                                            session.id
                                                        ] ?? null;
                                                    const isSelectedSession =
                                                        session.id ===
                                                        activeVoiceSessionId;
                                                    const isCurrentSpeaker =
                                                        Boolean(knownClientId) &&
                                                        session.speakerClientId ===
                                                            knownClientId;
                                                    const isSpeakerOccupiedByOtherClient =
                                                        Boolean(
                                                            session.speakerClientId &&
                                                                session.speakerClientId !==
                                                                    knownClientId,
                                                        );
                                                    const sessionBusyKey =
                                                        plutoSessionActionPending ===
                                                            session.id ||
                                                        plutoSessionActionPending ===
                                                            `${session.id}:speaker` ||
                                                        plutoSessionActionPending ===
                                                            `${session.id}:observer` ||
                                                        plutoSessionActionPending ===
                                                            `${session.id}:close`;
                                                    const speakerButtonLabel =
                                                        sessionBusyKey
                                                            ? 'Working…'
                                                            : isCurrentSpeaker
                                                              ? 'You have the mic'
                                                              : isSpeakerOccupiedByOtherClient
                                                                ? 'Mic taken'
                                                                : knownClientId
                                                                  ? 'Take mic'
                                                                  : 'Join with mic';
                                                    const observerButtonLabel =
                                                        sessionBusyKey
                                                            ? 'Working…'
                                                            : knownClientId
                                                              ? 'Open controls'
                                                              : 'Listen only';
                                                    const roleHint = isCurrentSpeaker
                                                        ? 'You are the active speaker in this session.'
                                                        : isSpeakerOccupiedByOtherClient
                                                          ? 'Another client has the mic right now. You can still open the controls to listen.'
                                                          : knownClientId
                                                            ? 'You are already attached. Hit “Take mic” to speak.'
                                                            : 'No one owns the mic yet. You can join directly as speaker.';

                                                    return (
                                                        <div
                                                            key={session.id}
                                                            className={cn(
                                                                'rounded-2xl border bg-white/5 p-4 transition-colors',
                                                                isSelectedSession
                                                                    ? 'border-emerald-400/60 bg-emerald-500/10 ring-1 ring-emerald-400/40'
                                                                    : 'border-white/10',
                                                            )}>
                                                            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                                                <div className="space-y-2">
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <span className="text-sm font-semibold text-slate-100">
                                                                            {session.title ??
                                                                                'Untitled session'}
                                                                        </span>
                                                                        <Badge
                                                                            variant="secondary"
                                                                            className="bg-black/40 text-slate-300 border-white/10">
                                                                            {formatSessionStatus(
                                                                                session.status,
                                                                            )}
                                                                        </Badge>
                                                                        <Badge
                                                                            variant="secondary"
                                                                            className="bg-black/40 text-slate-300 border-white/10">
                                                                            {session.speakerClientId
                                                                                ? 'Speaker attached'
                                                                                : 'Open mic slot'}
                                                                        </Badge>
                                                                    </div>
                                                                    <div className="text-xs text-slate-400">
                                                                        Host:{' '}
                                                                        {
                                                                            session
                                                                                .host
                                                                                .label
                                                                        }{' '}
                                                                        · Last
                                                                        activity{' '}
                                                                        {formatRelativeTime(
                                                                            session.lastActivityAt,
                                                                        )}
                                                                    </div>
                                                                    <div className="max-w-md text-xs text-slate-500">
                                                                        {roleHint}
                                                                    </div>
                                                                </div>

                                                                <div className="flex flex-wrap gap-2">
                                                                    <Button
                                                                        variant="secondary"
                                                                        size="sm"
                                                                        onClick={() =>
                                                                            knownClientId
                                                                                ? void joinPlutoVoiceSession(
                                                                                      session,
                                                                                  )
                                                                                : void joinPlutoVoiceSessionAs(
                                                                                      session,
                                                                                      'observer',
                                                                                  )
                                                                        }
                                                                        disabled={
                                                                            sessionBusyKey
                                                                        }>
                                                                        {
                                                                            observerButtonLabel
                                                                        }
                                                                    </Button>
                                                                    <Button
                                                                        variant={
                                                                            isCurrentSpeaker
                                                                                ? 'outline'
                                                                                : 'default'
                                                                        }
                                                                        size="sm"
                                                                        onClick={() =>
                                                                            isCurrentSpeaker
                                                                                ? void joinPlutoVoiceSession(
                                                                                      session,
                                                                                  )
                                                                                : void joinPlutoVoiceSessionAs(
                                                                                      session,
                                                                                      'speaker',
                                                                                  )
                                                                        }
                                                                        disabled={
                                                                            sessionBusyKey ||
                                                                            isSpeakerOccupiedByOtherClient
                                                                        }>
                                                                        {
                                                                            speakerButtonLabel
                                                                        }
                                                                    </Button>
                                                                    <Button
                                                                        variant="outline"
                                                                        size="sm"
                                                                        onClick={() =>
                                                                            void closePlutoVoiceSession(
                                                                                session.id,
                                                                            )
                                                                        }
                                                                        disabled={
                                                                            sessionBusyKey
                                                                        }>
                                                                        Close
                                                                    </Button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                },
                                            )
                                        )}
                                    </div>

                                    {activeVoiceSessionId ? (
                                        <div className="mt-4">
                                            <div className="mb-3 rounded-2xl border border-dashed border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                                                Pluto stays talkable beside the
                                                avatar in the overlay — and the
                                                same controls are mirrored here
                                                so device setup and mic testing
                                                are easier to find.
                                            </div>
                                            <PlutoVoiceSessionConsole
                                                apiBase={apiBase}
                                                desktopToken={desktopToken}
                                                sessionId={activeVoiceSessionId}
                                                clientId={
                                                    activeVoiceSessionClientId
                                                }
                                                sessions={plutoVoiceSessions}
                                                variant="panel"
                                                onError={(message) =>
                                                    setError(message)
                                                }
                                                onInfo={(message) => {
                                                    setStatusMessage(message);
                                                    globalThis.setTimeout(
                                                        () =>
                                                            setStatusMessage(
                                                                null,
                                                            ),
                                                        2500,
                                                    );
                                                }}
                                            />
                                        </div>
                                    ) : (
                                        <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-black/20 p-3 text-xs text-slate-400">
                                            Pick a Pluto session to reveal the
                                            full voice setup, microphone test,
                                            and live talk controls here and
                                            beside Pluto in the overlay.
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                    </div>
                )}

                {currentView !== 'dashboard' && (
                    <div className="mb-6">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-slate-400 hover:text-white pl-0"
                            onClick={() => setCurrentView('dashboard')}>
                            <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to
                            Dashboard
                        </Button>
                    </div>
                )}

                {currentView === 'permissions' && (
                    <div className="grid gap-6">
                        {draftConfig ? (
                            <>
                                <Card>
                                    <CardHeader>
                                        <CardTitle>Projects Root</CardTitle>
                                        <CardDescription>
                                            Base directory for your workspace
                                            and development
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <Input
                                            value={
                                                draftConfig.projectsRoot ?? ''
                                            }
                                            onChange={(event) =>
                                                updateDraftConfig(
                                                    (current) => ({
                                                        ...current,
                                                        projectsRoot:
                                                            event.target
                                                                .value || null,
                                                    }),
                                                )
                                            }
                                            placeholder="/Users/you/projects"
                                            className="max-w-xl"
                                        />
                                    </CardContent>
                                </Card>

                                <Card>
                                    <CardHeader>
                                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                                            <div>
                                                <CardTitle>
                                                    Allowed Paths
                                                </CardTitle>
                                                <CardDescription>
                                                    Add directories that the MCP
                                                    may access. The mode below
                                                    applies globally to every
                                                    path in this list.
                                                </CardDescription>
                                            </div>
                                            <Button
                                                variant="secondary"
                                                onClick={addPathEntry}
                                                size="sm">
                                                <Plus className="h-4 w-4 mr-1.5" />{' '}
                                                Add Path
                                            </Button>
                                        </div>
                                        <div className="grid gap-2 md:max-w-sm">
                                            <Label
                                                htmlFor="mcp-access-mode"
                                                className="text-xs text-slate-400">
                                                MCP Access Mode
                                            </Label>
                                            <select
                                                id="mcp-access-mode"
                                                value={
                                                    draftConfig.mcpAccessMode
                                                }
                                                onChange={(event) =>
                                                    updateAccessMode(
                                                        event.target
                                                            .value as MCPAccessMode,
                                                    )
                                                }
                                                className="h-11 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-slate-100 outline-none transition focus:border-white/30">
                                                {ACCESS_MODE_OPTIONS.map(
                                                    (option) => (
                                                        <option
                                                            key={option.value}
                                                            value={
                                                                option.value
                                                            }>
                                                            {option.label}
                                                        </option>
                                                    ),
                                                )}
                                            </select>
                                            <p className="text-xs text-slate-500">
                                                {
                                                    ACCESS_MODE_OPTIONS.find(
                                                        (option) =>
                                                            option.value ===
                                                            draftConfig.mcpAccessMode,
                                                    )?.description
                                                }
                                            </p>
                                        </div>
                                    </CardHeader>
                                    <CardContent className="grid gap-4">
                                        {draftConfig.allowedPaths.length ===
                                        0 ? (
                                            <p className="text-sm text-slate-400">
                                                No paths added yet.
                                            </p>
                                        ) : (
                                            draftConfig.allowedPaths.map(
                                                (entry) => (
                                                    <div
                                                        key={entry.id}
                                                        className="grid gap-3 rounded-3xl border border-white/10 bg-black/20 p-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
                                                        <Input
                                                            value={entry.path}
                                                            onChange={(event) =>
                                                                updatePathValue(
                                                                    entry.id,
                                                                    event.target
                                                                        .value,
                                                                )
                                                            }
                                                            placeholder="/absolute/path/to/allowed/folder"
                                                            className="h-11 bg-slate-900 font-mono text-sm focus:ring-white/20"
                                                        />
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={() =>
                                                                void browseForPath(
                                                                    entry.id,
                                                                )
                                                            }
                                                            disabled={
                                                                !canBrowseDirectories
                                                            }
                                                            className="min-w-28"
                                                            title={
                                                                canBrowseDirectories
                                                                    ? 'Browse for a folder'
                                                                    : 'Folder browsing is only available in the desktop app'
                                                            }>
                                                            <FolderOpen className="mr-1.5 h-4 w-4" />{' '}
                                                            Browse
                                                        </Button>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() =>
                                                                removePathEntry(
                                                                    entry.id,
                                                                )
                                                            }
                                                            className="text-slate-400 hover:text-red-400">
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                ),
                                            )
                                        )}
                                    </CardContent>
                                </Card>

                                <EditorList
                                    title="Allowed Repo Tasks"
                                    items={draftConfig.tasks}
                                    onChange={(tasks) =>
                                        updateDraftConfig((current) => ({
                                            ...current,
                                            tasks,
                                        }))
                                    }
                                />
                                <EditorList
                                    title="Allowed Dev Server Tasks"
                                    items={draftConfig.devServerTasks}
                                    onChange={(devServerTasks) =>
                                        updateDraftConfig((current) => ({
                                            ...current,
                                            devServerTasks,
                                        }))
                                    }
                                />
                                <RunCommandRulesEditor
                                    accessMode={draftConfig.mcpAccessMode}
                                    rules={draftConfig.runCommandRules}
                                    onChange={(runCommandRules) =>
                                        updateDraftConfig((current) => ({
                                            ...current,
                                            runCommandRules,
                                        }))
                                    }
                                />

                                <Card>
                                    <CardHeader>
                                        <CardTitle>
                                            Allowed Remote Admin Origins
                                        </CardTitle>
                                        <CardDescription>
                                            CORS allowed origins
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <Textarea
                                            rows={3}
                                            value={draftConfig.auth.allowedOrigins.join(
                                                '\n',
                                            )}
                                            onChange={(event) =>
                                                updateDraftConfig(
                                                    (current) => ({
                                                        ...current,
                                                        auth: {
                                                            ...current.auth,
                                                            allowedOrigins:
                                                                event.target.value
                                                                    .split('\n')
                                                                    .map(
                                                                        (
                                                                            value,
                                                                        ) =>
                                                                            value.trim(),
                                                                    )
                                                                    .filter(
                                                                        Boolean,
                                                                    ),
                                                        },
                                                    }),
                                                )
                                            }
                                            className="font-mono text-sm focus:ring-white/20"
                                        />
                                    </CardContent>
                                </Card>
                            </>
                        ) : (
                            <Card>
                                <CardContent className="py-12 text-center text-slate-400">
                                    {bootstrap?.desktop.runnerRunning
                                        ? 'Runner is starting. Configuration will appear once the local service answers.'
                                        : (bootstrap?.desktop.runnerLastError ??
                                          'Runner is offline. Start it from the Runner card above.')}
                                </CardContent>
                            </Card>
                        )}
                    </div>
                )}

                {currentView === 'approvals' && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Pending Approvals</CardTitle>
                            <CardDescription>
                                Approve once, deny, or persist the requested
                                permission.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-4">
                            {approvals.length === 0 ? (
                                <div className="rounded-3xl border border-white/10 bg-slate-900/30 p-8 text-center text-slate-400">
                                    No approvals are waiting.
                                </div>
                            ) : (
                                approvals.map((approval) => (
                                    <div
                                        key={approval.id}
                                        className="rounded-3xl border border-white/20 bg-white/5 p-5">
                                        <div className="mb-4">
                                            <h4 className="text-lg font-semibold text-white">
                                                {approval.toolName}
                                            </h4>
                                            <p className="text-sm text-slate-300 mt-1">
                                                {approval.summary}
                                            </p>
                                        </div>
                                        <ScrollArea className="h-32 w-full rounded-2xl bg-black/40 p-3 mb-5 border border-white/10">
                                            <pre className="text-xs font-mono text-slate-400 wrap-break-word whitespace-pre-wrap">
                                                {JSON.stringify(
                                                    approval.payload,
                                                    null,
                                                    2,
                                                )}
                                            </pre>
                                        </ScrollArea>
                                        <div className="flex flex-wrap gap-3">
                                            <Button
                                                onClick={() =>
                                                    decideApproval(
                                                        approval.id,
                                                        'approved',
                                                        false,
                                                    )
                                                }>
                                                Approve Once
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                onClick={() =>
                                                    decideApproval(
                                                        approval.id,
                                                        'approved',
                                                        true,
                                                    )
                                                }>
                                                Approve + Remember
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                onClick={() =>
                                                    decideApproval(
                                                        approval.id,
                                                        'denied',
                                                        false,
                                                    )
                                                }
                                                className="hover:bg-red-500/10 hover:text-red-400">
                                                Deny
                                            </Button>
                                        </div>
                                    </div>
                                ))
                            )}
                        </CardContent>
                    </Card>
                )}

                {currentView === 'activity' && (
                    <Card>
                        <CardHeader>
                            <CardTitle>Live Activity</CardTitle>
                            <CardDescription>
                                Auth, tool calls, writes, command execution, and
                                process lifecycle events.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <ScrollArea className="h-150 w-full rounded-3xl border border-white/10 bg-slate-900/30 p-4">
                                <div className="flex flex-col gap-3">
                                    {activity
                                        .slice()
                                        .reverse()
                                        .map((entry) => (
                                            <article
                                                key={entry.id}
                                                className={cn(
                                                    'rounded-2xl border border-white/10 p-4 transition-colors',
                                                    entry.level === 'error'
                                                        ? 'bg-red-500/5 border-red-500/20'
                                                        : 'bg-white/2 hover:bg-white/4',
                                                )}>
                                                <div className="flex items-center justify-between mb-2">
                                                    <Badge
                                                        variant="outline"
                                                        className={cn(
                                                            'border-white/10 font-mono text-[10px]',
                                                            entry.level ===
                                                                'error'
                                                                ? 'text-red-400 border-red-400/30'
                                                                : 'text-white',
                                                        )}>
                                                        {entry.type}
                                                    </Badge>
                                                    <time className="text-xs text-slate-500 font-mono">
                                                        {new Date(
                                                            entry.timestamp,
                                                        ).toLocaleTimeString()}
                                                    </time>
                                                </div>
                                                <p
                                                    className={cn(
                                                        'text-sm wrap-break-word',
                                                        entry.level === 'error'
                                                            ? 'text-red-200'
                                                            : 'text-slate-200',
                                                    )}>
                                                    {entry.message}
                                                </p>
                                                {Object.keys(entry.data)
                                                    .length > 0 && (
                                                    <div className="mt-3 rounded bg-black/40 p-2 overflow-x-auto">
                                                        <pre className="text-[11px] font-mono text-slate-400 wrap-break-word whitespace-pre-wrap">
                                                            {JSON.stringify(
                                                                entry.data,
                                                                null,
                                                                2,
                                                            )}
                                                        </pre>
                                                    </div>
                                                )}
                                            </article>
                                        ))}
                                    {activity.length === 0 && (
                                        <div className="text-center py-12 text-slate-500">
                                            No activity recorded yet.
                                        </div>
                                    )}
                                </div>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                )}
            </main>

            {showSetupGuide ? (
                <SetupGuideModal
                    onClose={() => setShowSetupGuide(false)}
                    publicAdminUrl={bootstrap?.desktop.publicAdminUrl ?? null}
                    publicMcpUrl={bootstrap?.desktop.publicMcpUrl ?? null}
                    tunnelRunning={bootstrap?.desktop.tunnelRunning ?? false}
                />
            ) : null}

            {showFullAccessConfirm ? (
                <ConfirmFullAccessDialog
                    onCancel={() => setShowFullAccessConfirm(false)}
                    onConfirm={confirmFullAccessMode}
                />
            ) : null}
        </div>
    );

    async function fetchBootstrap() {
        try {
            const result = await apiRequest<Bootstrap>('/bootstrap', 'GET');
            syncBootstrap(result);
            setError(null);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Bootstrap request failed',
            );
        }
    }

    function addPathEntry() {
        if (!draftConfig) {
            return;
        }
        updateDraftConfig((current) => ({
            ...current,
            allowedPaths: [
                ...current.allowedPaths,
                {
                    id: crypto.randomUUID(),
                    label: 'Manual grant',
                    path: '',
                    kind: 'manual',
                    enabled: true,
                    capabilities: {
                        read: true,
                        write: false,
                        search: true,
                        list: true,
                        'execute-tasks': false,
                        'run-command': false,
                    },
                },
            ],
        }));
    }

    function updatePathEntry(
        id: string,
        patch: Partial<AgentCompanionConfig['allowedPaths'][number]>,
    ) {
        if (!draftConfig) {
            return;
        }
        updateDraftConfig((current) => ({
            ...current,
            allowedPaths: current.allowedPaths.map((entry) =>
                entry.id === id ? { ...entry, ...patch } : entry,
            ),
        }));
    }

    function updatePathValue(id: string, nextPath: string) {
        updatePathEntry(id, {
            path: nextPath,
            label: derivePathLabel(nextPath),
        });
    }

    async function browseForPath(id: string) {
        const selectedPath = await desktopBridge?.selectDirectory?.();
        if (!selectedPath) {
            return;
        }
        updatePathValue(id, selectedPath);
    }

    function removePathEntry(id: string) {
        if (!draftConfig) {
            return;
        }
        updateDraftConfig((current) => ({
            ...current,
            allowedPaths: current.allowedPaths.filter(
                (entry) => entry.id !== id,
            ),
        }));
    }

    async function saveConfig(
        configToSave: AgentCompanionConfig,
        versionToSave: number,
    ) {
        try {
            await apiRequest('/config', 'PUT', configToSave);
            const result = await apiRequest<Bootstrap>('/bootstrap', 'GET');

            if (draftVersionRef.current !== versionToSave) {
                syncBootstrap(result);
                return;
            }

            draftDirtyRef.current = false;
            syncBootstrap(result, true);
            setError(null);
            setStatusMessage('Configuration saved automatically.');
            globalThis.setTimeout(() => setStatusMessage(null), 2000);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Config update failed',
            );
        }
    }

    async function decideApproval(
        id: string,
        decision: 'approved' | 'denied',
        remember: boolean,
    ) {
        try {
            await apiRequest('/approvals/decision', 'POST', {
                id,
                decision,
                remember,
            });
            setStatusMessage(`Approval ${decision}.`);
            setTimeout(() => setStatusMessage(null), 2000);
            await fetchBootstrap();
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Approval update failed',
            );
        }
    }

    async function toggleTunnel() {
        try {
            const pathname = bootstrap?.desktop.tunnelRunning
                ? '/tunnel/stop'
                : '/tunnel/start';
            const result = await apiRequest<Bootstrap>(pathname, 'POST');
            syncBootstrap(result);
            setStatusMessage(
                result.desktop.tunnelRunning
                    ? 'Tunnel started.'
                    : 'Tunnel stopped.',
            );
            setTimeout(() => setStatusMessage(null), 2000);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Tunnel update failed',
            );
        }
    }

    async function triggerPlutoCommentary() {
        try {
            setPlutoTriggerPending(true);
            await apiRequest('/pluto/commentary', 'POST', {
                contextHint:
                    'Give one short German comment about what the user is currently doing on screen.',
            });
            await fetchBootstrap();
            setStatusMessage(
                'Pluto is cooking up commentary. Tiny celestial saucepan included.',
            );
            setTimeout(() => setStatusMessage(null), 2500);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Pluto commentary trigger failed',
            );
        } finally {
            setPlutoTriggerPending(false);
        }
    }

    async function createPlutoVoiceSession() {
        try {
            setPlutoSessionActionPending('create');
            const result = await apiRequest<PlutoVoiceSessionCreateOutput>(
                '/pluto/sessions',
                'POST',
                {
                    title: 'Desktop Pluto session',
                    client: {
                        label:
                            mode === 'admin'
                                ? 'Remote Admin'
                                : 'Desktop Companion',
                        platform: desktopBridge?.platform ?? mode,
                        requestedRole: 'speaker',
                    },
                },
            );
            if (result.client) {
                const clientId = result.client.id;
                setLocalSessionClients((current) => ({
                    ...current,
                    [result.session.id]: clientId,
                }));
                setActiveVoiceSessionId(result.session.id);
            }
            await fetchBootstrap();
            setStatusMessage(
                'Pluto voice session started. The mic button is now live.',
            );
            setTimeout(() => setStatusMessage(null), 2500);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Pluto voice session creation failed',
            );
        } finally {
            setPlutoSessionActionPending(null);
        }
    }

    async function joinPlutoVoiceSession(session: PlutoVoiceSessionSummary) {
        if (localSessionClients[session.id]) {
            setActiveVoiceSessionId(session.id);
            setStatusMessage('Reopened Pluto voice console.');
            setTimeout(() => setStatusMessage(null), 2000);
            return;
        }

        try {
            setPlutoSessionActionPending(session.id);
            const result = await apiRequest<PlutoVoiceSessionAttachOutput>(
                `/pluto/sessions/${session.id}/attach`,
                'POST',
                {
                    label:
                        mode === 'admin' ? 'Remote Admin' : 'Desktop Companion',
                    platform: desktopBridge?.platform ?? mode,
                    requestedRole: session.speakerClientId
                        ? 'observer'
                        : 'speaker',
                },
            );
            setLocalSessionClients((current) => ({
                ...current,
                [result.session.id]: result.client.id,
            }));
            setActiveVoiceSessionId(result.session.id);
            await fetchBootstrap();
            setStatusMessage(
                session.speakerClientId
                    ? 'Joined Pluto session as observer.'
                    : 'Joined Pluto session as speaker.',
            );
            setTimeout(() => setStatusMessage(null), 2500);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Pluto voice session join failed',
            );
        } finally {
            setPlutoSessionActionPending(null);
        }
    }

    async function joinPlutoVoiceSessionAs(
        session: PlutoVoiceSessionSummary,
        requestedRole: 'speaker' | 'observer',
    ) {
        const existingClientId = localSessionClients[session.id] ?? null;

        try {
            setPlutoSessionActionPending(`${session.id}:${requestedRole}`);

            if (existingClientId) {
                await apiRequest(
                    `/pluto/sessions/${session.id}/detach`,
                    'POST',
                    { clientId: existingClientId },
                );
                setLocalSessionClients((current) => {
                    const next = { ...current };
                    delete next[session.id];
                    return next;
                });
            }

            const result = await apiRequest<PlutoVoiceSessionAttachOutput>(
                `/pluto/sessions/${session.id}/attach`,
                'POST',
                {
                    label:
                        mode === 'admin' ? 'Remote Admin' : 'Desktop Companion',
                    platform: desktopBridge?.platform ?? mode,
                    requestedRole,
                },
            );
            setLocalSessionClients((current) => ({
                ...current,
                [result.session.id]: result.client.id,
            }));
            setActiveVoiceSessionId(result.session.id);
            await fetchBootstrap();
            setStatusMessage(
                requestedRole === 'speaker'
                    ? 'You now have the mic for this Pluto session.'
                    : 'Opened Pluto session in listen-only mode.',
            );
            setTimeout(() => setStatusMessage(null), 2500);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Pluto voice role change failed',
            );
        } finally {
            setPlutoSessionActionPending(null);
        }
    }

    async function closePlutoVoiceSession(sessionId: string) {
        try {
            setPlutoSessionActionPending(`${sessionId}:close`);
            await apiRequest(`/pluto/sessions/${sessionId}/close`, 'POST');
            setLocalSessionClients((current) => {
                const next = { ...current };
                delete next[sessionId];
                return next;
            });
            if (activeVoiceSessionId === sessionId) {
                setActiveVoiceSessionId(null);
            }
            await fetchBootstrap();
            setStatusMessage(
                'Pluto voice session closed. Curtain gently falls.',
            );
            setTimeout(() => setStatusMessage(null), 2500);
        } catch (requestError) {
            setError(
                requestError instanceof Error
                    ? requestError.message
                    : 'Pluto voice session close failed',
            );
        } finally {
            setPlutoSessionActionPending(null);
        }
    }

    async function apiRequest<T = unknown>(
        pathname: string,
        method: string,
        body?: unknown,
    ) {
        const headers: Record<string, string> = {};
        if (desktopToken && apiBase === '/api/desktop') {
            headers['x-desktop-token'] = desktopToken;
        }
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
        }
        const response = await fetch(`${apiBase}${pathname}`, {
            method,
            credentials: 'include',
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        if (!response.ok) {
            if (mode === 'admin' && response.status === 401) {
                window.location.href = '/login';
            }
            const payload = await response.json().catch(() => null);
            throw new Error(
                payload?.message ??
                    `Request failed with status ${response.status}`,
            );
        }
        return (await response.json()) as T;
    }
}

function formatSessionStatus(status: PlutoVoiceSessionSummary['status']) {
    switch (status) {
        case 'idle':
            return 'Idle';
        case 'listening':
            return 'Listening';
        case 'responding':
            return 'Responding';
        case 'error':
            return 'Error';
    }
}

function formatRelativeTime(timestamp: string) {
    const deltaMs = Date.now() - new Date(timestamp).getTime();
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
        return 'just now';
    }

    const seconds = Math.floor(deltaMs / 1000);
    if (seconds < 10) {
        return 'just now';
    }
    if (seconds < 60) {
        return `${seconds}s ago`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }

    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function ConfirmFullAccessDialog({
    onCancel,
    onConfirm,
}: {
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>Enable full access?</DialogTitle>
                    <DialogDescription>
                        Full access allows arbitrary commands and broader MCP
                        capabilities inside every allowed path. Only enable it
                        when you fully trust this setup.
                    </DialogDescription>
                </DialogHeader>

                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4 text-sm text-amber-100">
                    This applies globally to every allowed path in the list.
                </div>

                <div className="flex justify-end gap-3">
                    <Button variant="secondary" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        onClick={onConfirm}
                        className="bg-white text-black hover:bg-slate-200">
                        Confirm full access
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function SetupGuideModal({
    onClose,
    publicAdminUrl,
    publicMcpUrl,
    tunnelRunning,
}: {
    onClose: () => void;
    publicAdminUrl: string | null;
    publicMcpUrl: string | null;
    tunnelRunning: boolean;
}) {
    return (
        <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
            <DialogContent className="setup-modal">
                <DialogHeader className="pr-10">
                    <p className="eyebrow">agent-companion</p>
                    <DialogTitle>ChatGPT MCP Setup</DialogTitle>
                    <DialogDescription>
                        This guide only covers the tunnel and how to link your
                        MCP server in ChatGPT Apps &amp; Connectors.
                    </DialogDescription>
                </DialogHeader>

                <div className="mt-6 grid gap-4">
                    <Card className="border-white/10 bg-slate-900/50">
                        <CardHeader>
                            <CardTitle className="text-2xl">
                                Use these public URLs
                            </CardTitle>
                            <CardDescription>
                                In ChatGPT Apps &amp; Connectors, use the MCP
                                server URL. The admin dashboard URL is not the
                                one you paste into the app connection.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="grid gap-3">
                            <SetupUrlField
                                label="MCP server URL for ChatGPT"
                                value={publicMcpUrl ?? 'Not detected yet'}
                                disabled={!publicMcpUrl}
                            />
                            <SetupUrlField
                                label="Remote admin URL"
                                value={publicAdminUrl ?? 'Not detected yet'}
                                disabled={!publicAdminUrl}
                            />
                        </CardContent>
                    </Card>

                    <SetupStep
                        index={1}
                        done={tunnelRunning}
                        title="Start the tunnel"
                        description="Use the Tunnel card in the dashboard. It should switch to Running and keep the MCP host reachable from the public Internet."
                    />
                    <SetupStep
                        index={2}
                        title="Open ChatGPT Apps & Connectors"
                        description="Create or import a custom remote MCP server in ChatGPT. The URL you paste there is the MCP server URL shown above."
                    />
                    <SetupStep
                        index={3}
                        title="Paste the MCP hostname"
                        description="Use the MCP URL exactly as shown. Do not use the admin dashboard URL for the ChatGPT app connection."
                    />
                    <SetupStep
                        index={4}
                        title="Complete the auth flow"
                        description="When ChatGPT connects, sign in and approve access so ChatGPT can reach your remote MCP server."
                    />
                    <SetupStep
                        index={5}
                        title="Connect from ChatGPT"
                        description="After the app is linked on ChatGPT web, you can use the same connection in chat and in compatible clients like the API Playground."
                    />
                    <SetupStep
                        index={6}
                        title="Keep OAuth and review redirects in mind"
                        description="For a ChatGPT app flow, ChatGPT will use its own OAuth redirect URL shown in the app management page. Your auth server must allowlist that redirect in addition to your local Google setup."
                    />
                    <SetupStep
                        index={7}
                        title="Verify the full flow"
                        description="Run a simple prompt in ChatGPT after linking the app and confirm that the remote MCP server is reachable and can answer tool calls."
                    />

                    <div className="flex justify-end pt-2">
                        <Button variant="secondary" onClick={onClose}>
                            Close
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function SetupStep({
    index,
    title,
    description,
    done = false,
}: {
    index: number;
    title: string;
    description: string;
    done?: boolean;
}) {
    return (
        <Card className="bg-slate-950/50">
            <CardContent className="grid grid-cols-[52px_1fr] gap-4 p-5">
                <div className={`setup-check ${done ? 'done' : ''}`}>
                    {done ? 'Done' : index}
                </div>
                <div>
                    <h3 className="font-['IBM_Plex_Sans'] text-2xl font-semibold text-white">
                        {title}
                    </h3>
                    <p className="mt-2 text-base leading-7 text-slate-400">
                        {description}
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}

function SetupUrlField({
    label,
    value,
    disabled,
}: {
    label: string;
    value: string;
    disabled?: boolean;
}) {
    const [copied, setCopied] = useState(false);

    return (
        <div className="grid gap-2">
            <span className="text-sm font-medium text-slate-200">{label}</span>
            <div className="relative">
                <Input
                    value={value}
                    readOnly
                    disabled={disabled}
                    className="pr-24 font-mono text-xs sm:text-sm"
                />
                <div className="absolute inset-y-0 right-2 flex items-center gap-1">
                    <Button
                        variant="ghost"
                        size="icon"
                        disabled={disabled}
                        onClick={async () => {
                            await navigator.clipboard.writeText(value);
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1400);
                        }}>
                        {copied ? (
                            <Check className="h-4 w-4" />
                        ) : (
                            <Copy className="h-4 w-4" />
                        )}
                    </Button>
                    {value.startsWith('https://') ? (
                        <a
                            href={value}
                            target="_blank"
                            rel="noreferrer"
                            className={buttonVariants({
                                variant: 'ghost',
                                size: 'icon',
                            })}
                            aria-disabled={disabled}>
                            <ExternalLink className="h-4 w-4" />
                        </a>
                    ) : null}
                </div>
            </div>
        </div>
    );
}

function OverlayView({
    bootstrap,
    desktopToken,
}: {
    bootstrap: Bootstrap | null;
    desktopToken?: string;
}) {
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

    const avatarState: 'idle' | 'working' | 'alert' | 'offline' =
        !runnerRunning || !isConnected
            ? 'offline'
            : approvalCount > 0
              ? 'alert'
              : runningProcesses > 0 || isRecentlyActive || plutoPending
                ? 'working'
                : 'idle';
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

    useEffect(() => {
        const intervalId = globalThis.setInterval(
            () => setFrameTime(Date.now()),
            80,
        );
        return () => globalThis.clearInterval(intervalId);
    }, []);

    useEffect(() => {
        if (
            !activePlutoMessage ||
            !activePlutoMessage.audioAvailable ||
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

            audio.addEventListener('play', () => {
                if (!cancelled) {
                    setIsSpeaking(true);
                    if (plutoAudioState) {
                        plutoAudioState.isSpeaking = true;
                    }
                }
            });
            audio.addEventListener('ended', () => {
                if (!cancelled) {
                    setIsSpeaking(false);
                    if (plutoAudioState) {
                        plutoAudioState.isSpeaking = false;
                        plutoAudioState.volume = 0;
                    }
                }
            });
            audio.addEventListener('pause', () => {
                if (!cancelled) {
                    setIsSpeaking(false);
                    if (plutoAudioState) {
                        plutoAudioState.isSpeaking = false;
                        plutoAudioState.volume = 0;
                    }
                }
            });

            // Web Audio API to analyze frequency data and map to plutoAudioState
            let audioSource: MediaElementAudioSourceNode | undefined;
            const maybeConnectAnalyser = () => {
                try {
                    // Important: createMediaElementSource can be called only once per HTMLMediaElement.
                    // We also need to construct an AudioContext upon user gesture. A play event is fine.
                    const win = window as any;
                    let ctx: AudioContext = win._plutoAudioCtx;
                    if (!ctx) {
                        ctx = new (
                            window.AudioContext ||
                            (window as any).webkitAudioContext
                        )();
                        win._plutoAudioCtx = ctx;
                    }
                    if (ctx.state === 'suspended') {
                        void ctx.resume();
                    }

                    let analyser: AnalyserNode = win._plutoAnalyser;
                    if (!analyser) {
                        analyser = ctx.createAnalyser();
                        analyser.fftSize = 256; // Fast and simple
                        win._plutoAnalyser = analyser;
                    }

                    // We only create the source node once per audio element, since they are singletons here
                    if (!(audio as any)._hasSourceConnected) {
                        audioSource = ctx.createMediaElementSource(audio);
                        audioSource.connect(analyser);
                        analyser.connect(ctx.destination);
                        (audio as any)._hasSourceConnected = true;
                    }

                    const dataArray = new Uint8Array(
                        analyser.frequencyBinCount,
                    );

                    // The volume update loop
                    const updateVolume = () => {
                        if (audio.paused || audio.ended || cancelled) {
                            if (plutoAudioState) {
                                plutoAudioState.volume = 0;
                            }
                            return;
                        }

                        analyser.getByteFrequencyData(dataArray);

                        // Calculate RMS or simple average
                        let sum = 0;
                        for (let i = 0; i < dataArray.length; i++) {
                            sum += dataArray[i];
                        }
                        const average = sum / dataArray.length;

                        // Map 0-255 to 0.0-1.0
                        const normalizedVolume = average / 255.0;
                        if (plutoAudioState) {
                            plutoAudioState.volume = normalizedVolume;
                        }

                        requestAnimationFrame(updateVolume);
                    };

                    // kick it off
                    updateVolume();
                } catch (e) {
                    console.error('Audio analyser failed:', e);
                }
            };

            audio.addEventListener('play', maybeConnectAnalyser);

            await audio.play().catch(() => undefined);
            lastPlayedMessageRef.current = activePlutoMessage.id;
        })();

        return () => {
            cancelled = true;
            setIsSpeaking(false);
            if (plutoAudioState) {
                plutoAudioState.isSpeaking = false;
                plutoAudioState.volume = 0;
            }
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

    return (
        <div className="overlay-shell">
            <div
                className={`pet-dock ${avatarState} ${curious ? 'curious' : ''}`}>
                {primaryApproval ? (
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
                                onClick={() =>
                                    void decideFromOverlay('denied', false)
                                }>
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
                ) : activePlutoMessage ? (
                    <div className="pet-bubble passive">
                        <div className="pet-bubble-header">
                            <strong>
                                {activePlutoMessage.title ?? 'Pluto'}
                            </strong>
                        </div>
                        <p>{streamedText}</p>
                    </div>
                ) : null}
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
                    onClick={() =>
                        void globalThis.window.agentCompanion?.showDashboard?.()
                    }>
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

function buildBlink(
    phase: number,
    avatarState: 'idle' | 'working' | 'alert' | 'offline',
    curious: boolean,
) {
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

function lerp(current: number, target: number, alpha: number) {
    return current + (target - current) * alpha;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function formatApprovalPreview(toolName: string, payload: unknown) {
    if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if (toolName === 'run_command') {
            const command = Array.isArray(record.command)
                ? record.command.join(' ')
                : '';
            const cwd =
                typeof record.workingDirectory === 'string'
                    ? record.workingDirectory
                    : '';
            return `${cwd} $ ${command}`.trim();
        }
        if (toolName === 'run_repo_task' || toolName === 'start_dev_server') {
            const cwd =
                typeof record.projectPath === 'string'
                    ? record.projectPath
                    : '';
            const taskId =
                typeof record.taskId === 'string' ? record.taskId : '';
            return `${cwd} • ${taskId}`.trim();
        }
        if ('path' in record && typeof record.path === 'string') {
            return record.path;
        }
    }

    const raw = JSON.stringify(payload);
    return raw && raw !== '{}' ? raw : 'Approval requested';
}

function getVisiblePlutoMessage(message: PlutoMessage | null) {
    if (!message?.expiresAt) {
        return message;
    }
    return new Date(message.expiresAt).getTime() > Date.now() ? message : null;
}

function describePlutoChip(message: PlutoMessage) {
    if (message.source === 'autonomous') {
        return message.audioAvailable ? 'pluto live' : 'pluto note';
    }
    if (message.delivery === 'summarize') {
        return 'secretary mode';
    }
    return message.audioAvailable ? 'remote relay' : 'message relay';
}

function LoginView() {
    return (
        <Card className="login-shell">
            <CardHeader className="p-7">
                <p className="eyebrow">agent-companion</p>
                <CardTitle className="text-5xl">
                    Remote admin sign-in required
                </CardTitle>
                <CardDescription>
                    The remote admin interface is protected by Google OAuth and
                    the local admin allowlist. Sign in to manage permissions,
                    approvals, and activity from another device.
                </CardDescription>
            </CardHeader>
            <CardContent className="px-7 pb-7 pt-0">
                <a
                    className={buttonVariants({ variant: 'default' })}
                    href="/auth/login/google">
                    Continue With Google
                </a>
            </CardContent>
        </Card>
    );
}

function EditorList({
    title,
    items,
    onChange,
}: {
    title: string;
    items: AgentCompanionConfig['tasks'];
    onChange: (items: AgentCompanionConfig['tasks']) => void;
}) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
                {items.map((task) => (
                    <div key={task.id} className="flex items-center gap-3">
                        <Input
                            value={task.label}
                            onChange={(event) =>
                                onChange(
                                    items.map((entry) =>
                                        entry.id === task.id
                                            ? {
                                                  ...entry,
                                                  label: event.target.value,
                                              }
                                            : entry,
                                    ),
                                )
                            }
                            placeholder="Label"
                            className="w-1/3 h-9 bg-white/5 focus:ring-white/20"
                        />
                        <Input
                            value={task.command.join(' ')}
                            onChange={(event) =>
                                onChange(
                                    items.map((entry) =>
                                        entry.id === task.id
                                            ? {
                                                  ...entry,
                                                  command: event.target.value
                                                      .split(' ')
                                                      .map((part) =>
                                                          part.trim(),
                                                      )
                                                      .filter(Boolean),
                                              }
                                            : entry,
                                    ),
                                )
                            }
                            placeholder="npm run build"
                            className="flex-1 font-mono text-sm h-9 bg-white/5 focus:ring-white/20"
                        />
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                                onChange(
                                    items.filter(
                                        (entry) => entry.id !== task.id,
                                    ),
                                )
                            }
                            className="text-slate-500 hover:text-red-400 shrink-0 h-9 w-9">
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                ))}
                <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 w-fit border-dashed border-white/20 hover:border-white/40 hover:bg-white/5 text-slate-300 rounded-full"
                    onClick={() =>
                        onChange([
                            ...items,
                            {
                                id: crypto.randomUUID(),
                                label: 'New task',
                                command: ['npm', 'run', 'build'],
                                managed: false,
                                timeoutMs: 60000,
                                outputLimitBytes: 32000,
                            },
                        ])
                    }>
                    <Plus className="h-4 w-4 mr-1.5" /> Add Task
                </Button>
            </CardContent>
        </Card>
    );
}

function RunCommandRulesEditor({
    accessMode,
    rules,
    onChange,
}: {
    accessMode: MCPAccessMode;
    rules: AgentCompanionConfig['runCommandRules'];
    onChange: (rules: AgentCompanionConfig['runCommandRules']) => void;
}) {
    const [inputValue, setInputValue] = useState('');
    const [inputMode, setInputMode] = useState<RunCommandMatchMode>('prefix');

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && inputValue.trim()) {
            e.preventDefault();
            const parts = inputValue.trim().split(' ').filter(Boolean);
            onChange([
                ...rules,
                {
                    id: crypto.randomUUID(),
                    label: inputValue.trim(),
                    command: parts,
                    matchMode: inputMode,
                    approvalRequired: false,
                },
            ]);
            setInputValue('');
        }
    };

    return (
        <div className="flex flex-col md:flex-row gap-6 items-start py-4">
            <div className="md:w-1/3 pt-2">
                <h3 className="text-base font-medium text-slate-100 mb-1">
                    Command Allowlist
                </h3>
                <p className="text-sm text-slate-400">
                    {accessMode === 'read-only'
                        ? 'Read-only mode disables command execution entirely.'
                        : accessMode === 'full-access'
                          ? 'Full access mode allows any command inside the allowed paths. The allowlist below is kept for when you switch back to Default.'
                          : 'Choose whether a rule should allow one exact command or an entire base/namespace such as pnpm or docker compose.'}
                </p>
            </div>

            <div className="md:w-2/3 w-full bg-white/5 border border-white/10 rounded-2xl p-4 flex flex-wrap gap-2 items-center">
                {rules.map((rule) => {
                    const cmdString = `${rule.command.join(' ')}${rule.matchMode === 'prefix' ? ' *' : ''}`;
                    return (
                        <div
                            key={rule.id}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-transparent border border-white/20 rounded-lg text-sm text-slate-300 hover:text-slate-100 min-w-0">
                            <span className="truncate">{cmdString}</span>
                            <button
                                type="button"
                                onClick={() =>
                                    onChange(
                                        rules.filter(
                                            (entry) => entry.id !== rule.id,
                                        ),
                                    )
                                }
                                className="text-slate-500 hover:text-white shrink-0 ml-1">
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    );
                })}
                <select
                    value={inputMode}
                    onChange={(event) =>
                        setInputMode(event.target.value as RunCommandMatchMode)
                    }
                    className="h-8 rounded-full border border-white/10 bg-black/40 px-3 text-xs text-slate-200 outline-none"
                    disabled={accessMode === 'read-only'}>
                    <option value="prefix">Base / Namespace</option>
                    <option value="exact">Exact command</option>
                </select>
                <input
                    type="text"
                    className="flex-1 min-w-35 h-8 bg-transparent border-none text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-0 px-2"
                    placeholder={
                        inputMode === 'prefix'
                            ? 'Add base command or namespace (e.g. pnpm or docker compose) ...'
                            : 'Add exact command (e.g. pnpm install) ...'
                    }
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    disabled={accessMode === 'read-only'}
                />
            </div>
        </div>
    );
}

function derivePathLabel(inputPath: string) {
    const normalized = inputPath.trim().replace(/[\\/]+$/, '');
    if (!normalized) {
        return 'Manual grant';
    }
    const parts = normalized.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? normalized;
}

function readPlutoVoiceSelection(): PlutoVoiceSelection {
    if (typeof globalThis.localStorage === 'undefined') {
        return {
            sessionId: null,
            clientId: null,
        };
    }

    try {
        const raw = globalThis.localStorage.getItem(
            PLUTO_VOICE_SELECTION_STORAGE_KEY,
        );
        if (!raw) {
            return {
                sessionId: null,
                clientId: null,
            };
        }
        const parsed = JSON.parse(raw) as PlutoVoiceSelection;
        return {
            sessionId:
                typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
            clientId:
                typeof parsed.clientId === 'string' ? parsed.clientId : null,
        };
    } catch {
        return {
            sessionId: null,
            clientId: null,
        };
    }
}

function writePlutoVoiceSelection(selection: PlutoVoiceSelection) {
    if (typeof globalThis.localStorage === 'undefined') {
        return;
    }

    globalThis.localStorage.setItem(
        PLUTO_VOICE_SELECTION_STORAGE_KEY,
        JSON.stringify(selection),
    );
}
