import type {
    ActivityEvent,
    AgentCompanionConfig,
    ApprovalRequest,
    PlutoVoiceSessionAttachOutput,
    PlutoVoiceSessionCreateOutput,
    PlutoVoiceSessionSummary,
} from '@agent-companion/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    type Bootstrap,
    type MCPAccessMode,
    type Mode,
    derivePathLabel,
    readPlutoVoiceSelection,
    writePlutoVoiceSelection,
} from './app-shared.js';
import { ActivityView } from './components/ActivityView.js';
import {
    ConfirmFullAccessDialog,
    SetupGuideModal,
} from './components/AppDialogs.js';
import { ApprovalsView } from './components/ApprovalsView.js';
import { DashboardView } from './components/DashboardView.js';
import { LoginView } from './components/LoginView.js';
import { OverlayView } from './components/OverlayView.js';
import { PermissionsView } from './components/PermissionsView.js';
import { Badge } from './components/ui/badge.js';
import { Button } from './components/ui/button.js';
import { cn } from './lib/utils.js';

const AUTO_SAVE_DELAY_MS = 900;

type MainView = 'dashboard' | 'permissions' | 'approvals' | 'activity';

export function App() {
    const mode = (document.body.dataset.mode as Mode | undefined) ?? 'desktop';
    const desktopToken =
        new URLSearchParams(globalThis.location.search).get('desktopToken') ??
        undefined;
    const apiBase =
        mode === 'admin' || mode === 'login' ? '/api/admin' : '/api/desktop';

    const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
    const [draftConfig, setDraftConfig] = useState<AgentCompanionConfig | null>(
        null,
    );
    const draftDirtyRef = useRef(false);
    const draftVersionRef = useRef(0);
    const autosaveTimeoutRef = useRef<ReturnType<
        typeof globalThis.setTimeout
    > | null>(null);

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
    const [currentView, setCurrentView] = useState<MainView>('dashboard');

    const plutoVoiceSessions = bootstrap?.runner.plutoVoiceSessions ?? [];
    const activity: ActivityEvent[] = bootstrap?.runner.activity ?? [];
    const approvals: ApprovalRequest[] = bootstrap?.runner.approvals ?? [];
    const desktopBridge = globalThis.window?.agentCompanion;
    const canBrowseDirectories =
        typeof desktopBridge?.selectDirectory === 'function';
    const activeVoiceSessionClientId = activeVoiceSessionId
        ? (localSessionClients[activeVoiceSessionId] ?? null)
        : null;
    const runnerBadgeLabel = getRunnerBadgeLabel(bootstrap);

    const handleVoiceError = useCallback((message: string) => {
        setError(message);
    }, []);

    const showTemporaryStatus = useCallback(
        (message: string, duration = 2000) => {
            setStatusMessage(message);
            globalThis.setTimeout(() => setStatusMessage(null), duration);
        },
        [],
    );

    const handleVoiceInfo = useCallback(
        (message: string) => {
            showTemporaryStatus(message, 2500);
        },
        [showTemporaryStatus],
    );

    useEffect(() => {
        const persistedSelection = readPlutoVoiceSelection();
        const { sessionId, clientId } = persistedSelection;
        if (sessionId && clientId) {
            setLocalSessionClients((current) => ({
                ...current,
                [sessionId]: clientId,
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
        const streamUrl = new URL(streamPath, globalThis.location.origin);
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
    }, [desktopToken, mode]);

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
                'min-h-screen w-full bg-slate-950 font-sans text-slate-50 selection:bg-white/30',
                mode,
            )}>
            <header className="sticky top-0 z-40 flex h-16 shrink-0 items-center justify-between border-b border-white/10 bg-slate-950/80 px-6 backdrop-blur-md">
                <div className="flex items-center gap-4">
                    <div className="flex flex-col">
                        <span className="text-xs font-semibold uppercase tracking-wider text-white">
                            agent-companion
                        </span>
                        <h1 className="text-2xl! font-bold leading-none tracking-tight md:text-3xl!">
                            {mode === 'admin'
                                ? 'Remote Admin'
                                : 'Desktop Companion'}
                        </h1>
                    </div>
                    <Badge
                        variant="outline"
                        className="ml-2 border-white/10 text-slate-400">
                        {runnerBadgeLabel}
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
                                className="inline-flex h-9 items-center justify-center rounded-full border border-white/10 bg-white/5 px-4 text-sm font-medium text-slate-100 transition hover:bg-white/10"
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
                                    globalThis.location.href = '/login';
                                }}>
                                Sign Out
                            </Button>
                        </>
                    ) : null}
                </div>
            </header>

            <main className="container mx-auto grid min-w-0 max-w-5xl gap-8 px-4 py-8">
                {error ? (
                    <div className="rounded-3xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
                        {error}
                    </div>
                ) : null}

                {statusMessage ? (
                    <div className="rounded-3xl border border-white/20 bg-white/10 p-4 text-sm text-slate-200">
                        {statusMessage}
                    </div>
                ) : null}

                {!bootstrap?.desktop.tunnelRunning ||
                !bootstrap?.desktop.publicMcpUrl ? (
                    <div className="flex items-center justify-between rounded-3xl border border-blue-500/20 bg-blue-500/5 p-4 text-sm text-blue-200">
                        <span>
                            Finish the ChatGPT MCP setup before linking the app
                            in ChatGPT.
                        </span>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-blue-300 hover:bg-blue-500/20 hover:text-blue-100"
                            onClick={() => setShowSetupGuide(true)}>
                            View steps
                        </Button>
                    </div>
                ) : null}

                {currentView === 'dashboard' ? (
                    <DashboardView
                        bootstrap={bootstrap}
                        draftConfig={draftConfig}
                        approvals={approvals}
                        activity={activity}
                        plutoTriggerPending={plutoTriggerPending}
                        plutoSessionActionPending={plutoSessionActionPending}
                        localSessionClients={localSessionClients}
                        activeVoiceSessionId={activeVoiceSessionId}
                        activeVoiceSessionClientId={activeVoiceSessionClientId}
                        apiBase={apiBase}
                        desktopToken={desktopToken}
                        onShowPermissions={() => setCurrentView('permissions')}
                        onShowApprovals={() => setCurrentView('approvals')}
                        onShowActivity={() => setCurrentView('activity')}
                        onToggleTunnel={toggleTunnel}
                        onTriggerPlutoCommentary={triggerPlutoCommentary}
                        onCreatePlutoVoiceSession={createPlutoVoiceSession}
                        onJoinPlutoVoiceSession={joinPlutoVoiceSession}
                        onJoinPlutoVoiceSessionAs={joinPlutoVoiceSessionAs}
                        onClosePlutoVoiceSession={closePlutoVoiceSession}
                        onUpdateDraftConfig={updateDraftConfig}
                        onVoiceError={handleVoiceError}
                        onVoiceInfo={handleVoiceInfo}
                    />
                ) : null}

                {currentView === 'permissions' ? (
                    <PermissionsView
                        bootstrap={bootstrap}
                        draftConfig={draftConfig}
                        canBrowseDirectories={canBrowseDirectories}
                        onBack={() => setCurrentView('dashboard')}
                        onAddPathEntry={addPathEntry}
                        onUpdateAccessMode={updateAccessMode}
                        onUpdateDraftConfig={updateDraftConfig}
                        onUpdatePathValue={updatePathValue}
                        onBrowseForPath={browseForPath}
                        onRemovePathEntry={removePathEntry}
                    />
                ) : null}

                {currentView === 'approvals' ? (
                    <>
                        <BackButton
                            onClick={() => setCurrentView('dashboard')}
                        />
                        <ApprovalsView
                            approvals={approvals}
                            onDecideApproval={decideApproval}
                        />
                    </>
                ) : null}

                {currentView === 'activity' ? (
                    <>
                        <BackButton
                            onClick={() => setCurrentView('dashboard')}
                        />
                        <ActivityView activity={activity} />
                    </>
                ) : null}
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
            showTemporaryStatus('Configuration saved automatically.');
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
            showTemporaryStatus(`Approval ${decision}.`);
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
            showTemporaryStatus(
                result.desktop.tunnelRunning
                    ? 'Tunnel started.'
                    : 'Tunnel stopped.',
            );
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
            showTemporaryStatus(
                'Pluto is cooking up commentary. Tiny celestial saucepan included.',
                2500,
            );
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

    function getPlutoVoiceUnavailableMessage() {
        return (
            bootstrap?.runner.pluto.lastError ??
            'Gemini is offline for Pluto voice. Add GEMINI_API_KEY to your secrets env and restart the local runner.'
        );
    }

    function ensurePlutoVoiceAvailable() {
        if (bootstrap?.runner.pluto.available) {
            return true;
        }

        setError(getPlutoVoiceUnavailableMessage());
        return false;
    }

    async function createPlutoVoiceSession() {
        if (!ensurePlutoVoiceAvailable()) {
            return;
        }

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
            showTemporaryStatus(
                'Pluto voice session started. The mic button is now live.',
                2500,
            );
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
            showTemporaryStatus('Reopened Pluto voice console.');
            return;
        }

        if (!session.speakerClientId && !ensurePlutoVoiceAvailable()) {
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
            showTemporaryStatus(
                session.speakerClientId
                    ? 'Joined Pluto session as observer.'
                    : 'Joined Pluto session as speaker.',
                2500,
            );
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
        if (requestedRole === 'speaker' && !ensurePlutoVoiceAvailable()) {
            return;
        }

        const existingClientId = localSessionClients[session.id] ?? null;

        try {
            setPlutoSessionActionPending(`${session.id}:${requestedRole}`);

            if (existingClientId) {
                await apiRequest(
                    `/pluto/sessions/${session.id}/detach`,
                    'POST',
                    {
                        clientId: existingClientId,
                    },
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
            showTemporaryStatus(
                requestedRole === 'speaker'
                    ? 'You now have the mic for this Pluto session.'
                    : 'Opened Pluto session in listen-only mode.',
                2500,
            );
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
            showTemporaryStatus(
                'Pluto voice session closed. Curtain gently falls.',
                2500,
            );
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

        let serializedBody: string | undefined;
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            serializedBody = JSON.stringify(body);
        }

        const response = await fetch(`${apiBase}${pathname}`, {
            method,
            credentials: 'include',
            headers,
            body: serializedBody,
        });

        if (!response.ok) {
            if (mode === 'admin' && response.status === 401) {
                globalThis.location.href = '/login';
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

type BackButtonProps = Readonly<{
    onClick: () => void;
}>;

function BackButton({ onClick }: BackButtonProps) {
    return (
        <div className="mb-6">
            <Button
                variant="ghost"
                size="sm"
                className="pl-0 text-slate-400 hover:text-white"
                onClick={onClick}>
                ← Back to Dashboard
            </Button>
        </div>
    );
}

function getRunnerBadgeLabel(bootstrap: Bootstrap | null) {
    if (!bootstrap?.desktop.runnerRunning) {
        return 'Offline';
    }
    if (bootstrap.runner.status.connectedToRemote) {
        return 'Connected';
    }
    return 'Starting';
}
