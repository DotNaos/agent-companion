import type {
  ActivityEvent,
  AgentCompanionConfig,
  ApprovalRequest,
  PlutoVoiceSessionSummary,
} from "@agent-companion/shared";
import { ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Bootstrap } from "../app-shared.js";
import { formatRelativeTime, formatSessionStatus } from "../app-shared.js";
import { cn } from "../lib/utils.js";
import { PlutoVoiceSessionConsole } from "./PlutoVoiceSessionConsole.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card.js";
import { Switch } from "./ui/switch.js";

type DashboardViewProps = Readonly<{
  bootstrap: Bootstrap | null;
  draftConfig: AgentCompanionConfig | null;
  approvals: ApprovalRequest[];
  activity: ActivityEvent[];
  plutoTriggerPending: boolean;
  plutoSessionActionPending: string | null;
  localSessionClients: Record<string, string>;
  activeVoiceSessionId: string | null;
  activeVoiceSessionClientId: string | null;
  apiBase: string;
  desktopToken?: string;
  onShowPermissions: () => void;
  onShowApprovals: () => void;
  onShowActivity: () => void;
  onToggleTunnel: () => void | Promise<void>;
  onTriggerPlutoCommentary: () => void | Promise<void>;
  onCreatePlutoVoiceSession: () => void | Promise<void>;
  onJoinPlutoVoiceSession: (
    session: PlutoVoiceSessionSummary,
  ) => void | Promise<void>;
  onJoinPlutoVoiceSessionAs: (
    session: PlutoVoiceSessionSummary,
    role: "speaker" | "observer",
  ) => void | Promise<void>;
  onClosePlutoVoiceSession: (sessionId: string) => void | Promise<void>;
  onUpdateDraftConfig: (
    updater: (current: AgentCompanionConfig) => AgentCompanionConfig,
  ) => void;
  onVoiceError: (message: string) => void;
  onVoiceInfo: (message: string) => void;
}>;

export function DashboardView({
  bootstrap,
  draftConfig,
  approvals,
  activity,
  plutoTriggerPending,
  plutoSessionActionPending,
  localSessionClients,
  activeVoiceSessionId,
  activeVoiceSessionClientId,
  apiBase,
  desktopToken,
  onShowPermissions,
  onShowApprovals,
  onShowActivity,
  onToggleTunnel,
  onTriggerPlutoCommentary,
  onCreatePlutoVoiceSession,
  onJoinPlutoVoiceSession,
  onJoinPlutoVoiceSessionAs,
  onClosePlutoVoiceSession,
  onUpdateDraftConfig,
  onVoiceError,
  onVoiceInfo,
}: DashboardViewProps) {
  const runnerState = getRunnerState(bootstrap);
  const plutoVoiceSessions = bootstrap?.runner.plutoVoiceSessions ?? [];

  return (
    <div className="grid auto-rows-min gap-4 md:grid-cols-3">
      <Card className="md:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-slate-400">
            Runner Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold">{runnerState}</div>
        </CardContent>
      </Card>

      <Card className="md:col-span-1">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium text-slate-400">
            Tunnel Status
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div className="text-2xl font-semibold">
            {bootstrap?.desktop.tunnelRunning ? "Running" : "Stopped"}
          </div>
          <Button
            variant={bootstrap?.desktop.tunnelRunning ? "outline" : "default"}
            size="sm"
            onClick={() => void onToggleTunnel()}
          >
            {bootstrap?.desktop.tunnelRunning ? "Stop Tunnel" : "Start Tunnel"}
          </Button>
        </CardContent>
      </Card>

      <DashboardNavCard
        title="Permissions"
        description="Configure allowed paths and rules"
        onClick={onShowPermissions}
      >
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge
            variant="secondary"
            className="border-white/10 bg-black/40 text-slate-300"
          >
            {draftConfig?.mcpAccessMode || "..."} mode
          </Badge>
          <Badge
            variant="secondary"
            className="border-white/10 bg-black/40 text-slate-300"
          >
            {draftConfig?.allowedPaths.length ?? 0} paths
          </Badge>
        </div>
      </DashboardNavCard>

      <DashboardNavCard
        title="Approvals"
        description="Review pending tool requests"
        onClick={onShowApprovals}
        className={
          approvals.length > 0
            ? "border-amber-500/30 bg-amber-500/10 hover:border-amber-500/50"
            : undefined
        }
      >
        <div className="mt-4 text-3xl font-light">
          {approvals.length}{" "}
          <span className="text-sm font-normal text-slate-400">pending</span>
        </div>
      </DashboardNavCard>

      <DashboardNavCard
        title="Live Activity"
        description="Recent events and logs"
        onClick={onShowActivity}
      >
        {activity.length > 0 ? (
          <div className="mt-4 truncate rounded-lg border border-white/5 bg-black/40 p-2 font-mono text-xs text-slate-300">
            {activity.at(-1)?.message ?? "No recent activity"}
          </div>
        ) : (
          <div className="mt-4 text-sm text-slate-500">No logs recorded</div>
        )}
      </DashboardNavCard>

      <Card className="border-white/10 bg-white/5 md:col-span-3">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">Pluto Voice Desktop</CardTitle>
          <CardDescription>
            Local secretary mode and shared voice-session registry.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.8fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <h3 className="px-1 text-sm font-medium text-slate-200">
              Settings
            </h3>
            <div className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/20 text-sm">
              <div className="flex items-center justify-between border-b border-white/5 p-4">
                <div className="flex items-center gap-3">
                  <div
                    className={cn(
                      "h-2 w-2 rounded-full",
                      bootstrap?.runner.pluto.available
                        ? "bg-emerald-400"
                        : "bg-rose-500",
                    )}
                  />
                  <div>
                    <div className="font-medium text-slate-200">
                      Commentary AI
                    </div>
                    <div className="text-xs text-slate-500">
                      {bootstrap?.runner.pluto.available
                        ? "Gemini is ready"
                        : "Gemini is offline"}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-8 bg-white/5 text-xs hover:bg-white/10"
                  onClick={() => void onTriggerPlutoCommentary()}
                  disabled={
                    plutoTriggerPending ||
                    !bootstrap?.runner.pluto.available ||
                    bootstrap?.runner.pluto.pending
                  }
                >
                  {plutoTriggerPending ? "Generating…" : "Force comment"}
                </Button>
              </div>

              <div className="flex items-center justify-between border-b border-white/5 p-4">
                <div>
                  <div className="font-medium text-slate-200">
                    Auto-Commentary
                  </div>
                  <div className="text-xs text-slate-500">
                    {draftConfig?.pluto.autoCommentaryEnabled
                      ? `Chimes in every ${Math.round((draftConfig.pluto.commentaryIntervalMs ?? 30_000) / 1000)}s`
                      : "Only speaks when asked"}
                  </div>
                </div>
                <Switch
                  checked={draftConfig?.pluto.autoCommentaryEnabled ?? false}
                  onCheckedChange={(checked) =>
                    onUpdateDraftConfig((current) => ({
                      ...current,
                      pluto: {
                        ...current.pluto,
                        autoCommentaryEnabled: checked,
                      },
                    }))
                  }
                />
              </div>

              <div className="flex items-center justify-between p-4">
                <div>
                  <div className="font-medium text-slate-200">Voice Output</div>
                  <div className="text-xs text-slate-500">
                    {draftConfig?.pluto.muted
                      ? "Pluto is muted"
                      : "Pluto speaks out loud"}
                  </div>
                </div>
                <Switch
                  checked={!(draftConfig?.pluto.muted ?? false)}
                  onCheckedChange={(checked) =>
                    onUpdateDraftConfig((current) => ({
                      ...current,
                      pluto: {
                        ...current.pluto,
                        muted: !checked,
                      },
                    }))
                  }
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between px-1">
              <div>
                <h3 className="text-sm font-medium text-slate-200">
                  Live Sessions
                </h3>
                <p className="mt-0.5 text-xs text-slate-400">
                  Collaborate with Pluto across devices.
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => void onCreatePlutoVoiceSession()}
                disabled={plutoSessionActionPending === "create"}
                className="h-8 bg-emerald-500 px-4 text-xs font-medium text-slate-950 transition-colors hover:bg-emerald-400"
              >
                {plutoSessionActionPending === "create"
                  ? "Starting…"
                  : "Start session"}
              </Button>
            </div>

            <div className="flex flex-col gap-3">
              {plutoVoiceSessions.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 p-8 text-center">
                  <div className="text-sm text-slate-400">
                    No active voice sessions.
                  </div>
                </div>
              ) : (
                plutoVoiceSessions.map((session) => (
                  <VoiceSessionCard
                    key={session.id}
                    session={session}
                    knownClientId={localSessionClients[session.id] ?? null}
                    isSelectedSession={session.id === activeVoiceSessionId}
                    isBusy={isSessionBusy(plutoSessionActionPending, session.id)}
                    onJoinSession={onJoinPlutoVoiceSession}
                    onJoinSessionAs={onJoinPlutoVoiceSessionAs}
                    onCloseSession={onClosePlutoVoiceSession}
                  />
                ))
              )}
            </div>

            {activeVoiceSessionId ? (
              <div className="mt-2">
                <div className="mb-3 rounded-2xl border border-dashed border-emerald-400/20 bg-emerald-400/5 p-3 text-xs text-slate-300">
                  Controls mirrored from the desktop avatar — configure audio
                  devices here.
                </div>
                <PlutoVoiceSessionConsole
                  apiBase={apiBase}
                  desktopToken={desktopToken}
                  sessionId={activeVoiceSessionId}
                  clientId={activeVoiceSessionClientId}
                  sessions={plutoVoiceSessions}
                  variant="panel"
                  onError={onVoiceError}
                  onInfo={onVoiceInfo}
                />
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

type DashboardNavCardProps = Readonly<{
  title: string;
  description: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}>;

function DashboardNavCard({
  title,
  description,
  className,
  onClick,
  children,
}: DashboardNavCardProps) {
  return (
    <Card
      className={cn(
        "group flex cursor-pointer flex-col border-white/10 bg-white/5 transition-colors hover:border-white/30 md:col-span-1",
        className,
      )}
      onClick={onClick}
    >
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-lg">
          {title}
          <ChevronRight className="h-4 w-4 text-slate-500 transition-colors group-hover:text-white" />
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-end">
        {children}
      </CardContent>
    </Card>
  );
}

type VoiceSessionCardProps = Readonly<{
  session: PlutoVoiceSessionSummary;
  knownClientId: string | null;
  isSelectedSession: boolean;
  isBusy: boolean;
  onJoinSession: (session: PlutoVoiceSessionSummary) => void | Promise<void>;
  onJoinSessionAs: (
    session: PlutoVoiceSessionSummary,
    role: "speaker" | "observer",
  ) => void | Promise<void>;
  onCloseSession: (sessionId: string) => void | Promise<void>;
}>;

function VoiceSessionCard({
  session,
  knownClientId,
  isSelectedSession,
  isBusy,
  onJoinSession,
  onJoinSessionAs,
  onCloseSession,
}: VoiceSessionCardProps) {
  const isCurrentSpeaker =
    Boolean(knownClientId) && session.speakerClientId === knownClientId;
  const isSpeakerOccupiedByOtherClient = Boolean(
    session.speakerClientId && session.speakerClientId !== knownClientId,
  );
  const observerButtonLabel = getObserverButtonLabel(isBusy, knownClientId);
  const micStatus = getMicStatus(
    isCurrentSpeaker,
    isSpeakerOccupiedByOtherClient,
    knownClientId,
  );

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-3 overflow-hidden rounded-2xl border p-4 transition-colors",
        isSelectedSession
          ? "border-emerald-500/40 bg-emerald-500/10"
          : "border-white/10 bg-white/5 hover:bg-white/10",
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "h-2 w-2 shrink-0 rounded-full",
                isSelectedSession
                  ? "animate-pulse bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]"
                  : "bg-white/20",
              )}
            />
            <span className="truncate text-sm font-semibold text-slate-100">
              {session.title ?? "Untitled session"}
            </span>
            {session.speakerClientId ? (
              <Badge
                variant="secondary"
                className="hidden h-4 shrink-0 rounded-full border-emerald-400/20 bg-black/40 px-2 py-0 text-[10px] font-semibold uppercase text-emerald-400 sm:inline-flex"
              >
                Mic active
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-slate-400">
            <span className="truncate">Host: {session.host.label}</span>
            <span className="opacity-50">·</span>
            <span>Active {formatRelativeTime(session.lastActivityAt)}</span>
            <span className="opacity-50">·</span>
            <span
              className={cn(
                session.status === "idle" ? "text-slate-500" : "text-emerald-400",
              )}
            >
              {formatSessionStatus(session.status)}
            </span>
          </div>
          <div className="mt-1 line-clamp-2 text-xs text-slate-400">
            {micStatus}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <Button
              variant={isSelectedSession ? "outline" : "secondary"}
              size="sm"
              className={cn(
                "h-8 text-xs",
                isSelectedSession &&
                  "border-emerald-500/30 font-medium text-emerald-400",
              )}
              onClick={() =>
                knownClientId
                  ? void onJoinSession(session)
                  : void onJoinSessionAs(session, "observer")
              }
              disabled={isBusy}
            >
              {observerButtonLabel}
            </Button>

            {!isSpeakerOccupiedByOtherClient && !isCurrentSpeaker ? (
              <Button
                variant="default"
                size="sm"
                className="hidden h-8 bg-white text-xs text-black hover:bg-slate-200 sm:inline-flex"
                onClick={() => void onJoinSessionAs(session, "speaker")}
                disabled={isBusy}
              >
                Take mic
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-slate-500 hover:bg-rose-400/10 hover:text-rose-400"
              onClick={() => void onCloseSession(session.id)}
              disabled={isBusy}
              title="Close session"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function getRunnerState(bootstrap: Bootstrap | null) {
  if (!bootstrap?.desktop.runnerRunning) {
    return "Offline";
  }
  if (bootstrap.runner.status.connectedToRemote) {
    return "Connected";
  }
  return "Starting";
}

function isSessionBusy(pendingKey: string | null, sessionId: string) {
  return (
    pendingKey === sessionId ||
    pendingKey === `${sessionId}:speaker` ||
    pendingKey === `${sessionId}:observer` ||
    pendingKey === `${sessionId}:close`
  );
}

function getObserverButtonLabel(isBusy: boolean, knownClientId: string | null) {
  if (isBusy) {
    return "...";
  }
  return knownClientId ? "Controls" : "Listen";
}

function getMicStatus(
  isCurrentSpeaker: boolean,
  isSpeakerOccupiedByOtherClient: boolean,
  knownClientId: string | null,
) {
  if (isCurrentSpeaker) {
    return "You have the mic.";
  }
  if (isSpeakerOccupiedByOtherClient) {
    return "Someone else has the mic.";
  }
  if (knownClientId) {
    return "You are observing.";
  }
  return "Mic is open. Join as speaker to talk.";
}
