import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { AgentCompanionConfig, ActivityEvent, ApprovalRequest, RunnerStatus } from "@agent-companion/shared";
import { Button, buttonVariants } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";

type Bootstrap = {
  runner: {
    status: RunnerStatus;
    config: AgentCompanionConfig | null;
    activity: ActivityEvent[];
    approvals: ApprovalRequest[];
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

type Mode = "desktop" | "overlay" | "admin" | "login";

const CAPABILITIES = ["read", "write", "search", "list", "execute-tasks", "run-command"] as const;

export function App() {
  const mode = (document.body.dataset.mode as Mode | undefined) ?? "desktop";
  const desktopToken = new URLSearchParams(window.location.search).get("desktopToken") ?? undefined;
  const apiBase = mode === "admin" || mode === "login" ? "/api/admin" : "/api/desktop";
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [draftConfig, setDraftConfig] = useState<AgentCompanionConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

  useEffect(() => {
    void fetchBootstrap();

    const streamPath =
      mode === "admin" || mode === "login"
        ? "/api/admin/stream"
        : `/api/desktop/stream?desktopToken=${encodeURIComponent(desktopToken ?? "")}`;
    const streamUrl = new URL(streamPath, window.location.origin);
    streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(streamUrl);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as { type: string; data: Bootstrap };
      if (message.type === "bootstrap") {
        setBootstrap(message.data);
        setDraftConfig(message.data.runner.config);
      }
    });
    socket.addEventListener("error", () => {
      if (mode === "admin") {
        setError("Realtime stream unavailable. The admin API may require login.");
      }
    });
    return () => socket.close();
  }, [apiBase, desktopToken, mode]);

  const activity = bootstrap?.runner.activity ?? [];
  const approvals = bootstrap?.runner.approvals ?? [];

  if (mode === "overlay") {
    return <OverlayView bootstrap={bootstrap} desktopToken={desktopToken} />;
  }

  if (mode === "login") {
    return <LoginView />;
  }

  return (
    <div className={`app-shell ${mode}`}>
      <header className="hero">
        <div>
          <p className="eyebrow">agent-companion</p>
          <h1>{mode === "admin" ? "Remote Admin" : "Desktop Companion"}</h1>
          <p className="lede">
            Secure relay visibility, path permissions, command policy, and approval control for the local runner.
          </p>
        </div>
        <div className="hero-actions">
          <Button variant="secondary" onClick={() => setShowSetupGuide(true)}>
            Open Setup Guide
          </Button>
          {mode === "admin" ? (
            <a className={buttonVariants({ variant: "secondary" })} href="/auth/login/google">
              Sign In With Google
            </a>
          ) : null}
          {mode === "admin" ? (
            <Button
              variant="ghost"
              onClick={async () => {
                await fetch("/auth/logout", { method: "POST" });
                window.location.href = "/login";
              }}
            >
              Sign Out
            </Button>
          ) : null}
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      {statusMessage ? <div className="banner">{statusMessage}</div> : null}
      {!bootstrap?.desktop.tunnelRunning || !bootstrap?.desktop.publicMcpUrl ? (
        <div className="banner info">
          Finish the ChatGPT MCP setup before linking the app in ChatGPT.
          <Button variant="ghost" size="sm" className="inline-action" onClick={() => setShowSetupGuide(true)}>
            View steps
          </Button>
        </div>
      ) : null}

      <section className="summary-grid">
        <MetricCard
          title="Runner"
          value={
            bootstrap?.desktop.runnerRunning
              ? bootstrap?.runner.status.connectedToRemote
                ? "Connected"
                : "Starting"
              : "Offline"
          }
        />
        <MetricCard
          title="Tunnel"
          value={bootstrap?.desktop.tunnelRunning ? "Running" : "Stopped"}
          actionLabel={bootstrap?.desktop.tunnelRunning ? "Stop Tunnel" : "Start Tunnel"}
          onAction={toggleTunnel}
        />
      </section>

      <div className="layout-grid">
        <section className="panel config-panel">
          <PanelHeader title="Permission Model" subtitle="Projects root, manual path grants, task allowlists, and run_command policy." />
          {draftConfig ? (
            <>
              <label className="field">
                <span>Projects Root</span>
                <Input
                  value={draftConfig.projectsRoot ?? ""}
                  onChange={(event) =>
                    setDraftConfig({ ...draftConfig, projectsRoot: event.target.value || null })
                  }
                  placeholder="/Users/you/projects"
                />
              </label>

              <h3>Allowed Paths</h3>
              <div className="stack">
                {draftConfig.allowedPaths.map((entry) => (
                  <div key={entry.id} className="path-card">
                    <div className="path-card-top">
                      <Input
                        value={entry.label}
                        onChange={(event) => updatePathEntry(entry.id, { label: event.target.value })}
                      />
                      <Button variant="ghost" onClick={() => removePathEntry(entry.id)}>
                        Remove
                      </Button>
                    </div>
                    <Input
                      value={entry.path}
                      onChange={(event) => updatePathEntry(entry.id, { path: event.target.value })}
                      placeholder="/absolute/path"
                    />
                    <div className="toggle-row">
                      {CAPABILITIES.map((capability) => (
                        <label key={capability} className="toggle">
                          <input
                            type="checkbox"
                            checked={entry.capabilities[capability]}
                            onChange={(event) =>
                              updatePathEntry(entry.id, {
                                capabilities: {
                                  ...entry.capabilities,
                                  [capability]: event.target.checked,
                                },
                              })
                            }
                          />
                          <span>{capability}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
                <Button variant="secondary" onClick={addPathEntry}>
                  Add Allowed Path
                </Button>
              </div>

              <EditorList
                title="Allowed Repo Tasks"
                items={draftConfig.tasks}
                onChange={(tasks) => setDraftConfig({ ...draftConfig, tasks })}
              />
              <EditorList
                title="Allowed Dev Server Tasks"
                items={draftConfig.devServerTasks}
                onChange={(devServerTasks) => setDraftConfig({ ...draftConfig, devServerTasks })}
              />
              <RunCommandRulesEditor
                rules={draftConfig.runCommandRules}
                onChange={(runCommandRules) => setDraftConfig({ ...draftConfig, runCommandRules })}
              />
              <label className="field">
                <span>Allowed Remote Admin Origins</span>
                <Textarea
                  rows={3}
                  value={draftConfig.auth.allowedOrigins.join("\n")}
                  onChange={(event) =>
                    setDraftConfig({
                      ...draftConfig,
                      auth: {
                        ...draftConfig.auth,
                        allowedOrigins: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean),
                      },
                    })
                  }
                />
              </label>

              <Button onClick={saveConfig}>
                Save Configuration
              </Button>
            </>
          ) : (
            <p className="muted">
              {bootstrap?.desktop.runnerRunning
                ? "Runner is starting. Configuration will appear once the local service answers."
                : (bootstrap?.desktop.runnerLastError ?? "Runner is offline. Start it from the Runner card above.")}
            </p>
          )}
        </section>

        <section className="panel approvals-panel">
          <PanelHeader title="Pending Approvals" subtitle="Approve once, deny, or persist the requested permission." />
          <div className="stack">
            {approvals.length === 0 ? <p className="muted">No approvals are waiting.</p> : null}
            {approvals.map((approval) => (
              <div key={approval.id} className="approval-card">
                <div>
                  <strong>{approval.toolName}</strong>
                  <p>{approval.summary}</p>
                </div>
                <pre>{JSON.stringify(approval.payload, null, 2)}</pre>
                <div className="action-row">
                  <Button onClick={() => decideApproval(approval.id, "approved", false)}>
                    Approve Once
                  </Button>
                  <Button variant="secondary" onClick={() => decideApproval(approval.id, "approved", true)}>
                    Approve + Remember
                  </Button>
                  <Button variant="ghost" onClick={() => decideApproval(approval.id, "denied", false)}>
                    Deny
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel activity-panel">
          <PanelHeader title="Live Activity" subtitle="Auth, tool calls, writes, command execution, and process lifecycle events." />
          <div className="activity-feed">
            {activity.slice().reverse().map((entry) => (
              <article key={entry.id} className={`activity-entry ${entry.level}`}>
                <div className="activity-head">
                  <span>{entry.type}</span>
                  <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                </div>
                <p>{entry.message}</p>
                {Object.keys(entry.data).length > 0 ? <pre>{JSON.stringify(entry.data, null, 2)}</pre> : null}
              </article>
            ))}
          </div>
        </section>
      </div>

      {showSetupGuide ? (
        <SetupGuideModal
          onClose={() => setShowSetupGuide(false)}
          publicAdminUrl={bootstrap?.desktop.publicAdminUrl ?? null}
          publicMcpUrl={bootstrap?.desktop.publicMcpUrl ?? null}
          tunnelRunning={bootstrap?.desktop.tunnelRunning ?? false}
        />
      ) : null}
    </div>
  );

  async function fetchBootstrap() {
    try {
      const result = await apiRequest<Bootstrap>("/bootstrap", "GET");
      setBootstrap(result);
      setDraftConfig(result.runner.config);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Bootstrap request failed");
    }
  }

  function addPathEntry() {
    if (!draftConfig) {
      return;
    }
    setDraftConfig({
      ...draftConfig,
      allowedPaths: [
        ...draftConfig.allowedPaths,
        {
          id: crypto.randomUUID(),
          label: "Manual grant",
          path: "",
          kind: "manual",
          enabled: true,
          capabilities: {
            read: true,
            write: false,
            search: true,
            list: true,
            "execute-tasks": false,
            "run-command": false,
          },
        },
      ],
    });
  }

  function updatePathEntry(id: string, patch: Partial<AgentCompanionConfig["allowedPaths"][number]>) {
    if (!draftConfig) {
      return;
    }
    setDraftConfig({
      ...draftConfig,
      allowedPaths: draftConfig.allowedPaths.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)),
    });
  }

  function removePathEntry(id: string) {
    if (!draftConfig) {
      return;
    }
    setDraftConfig({
      ...draftConfig,
      allowedPaths: draftConfig.allowedPaths.filter((entry) => entry.id !== id),
    });
  }

  async function saveConfig() {
    if (!draftConfig) {
      return;
    }
    try {
      await apiRequest("/config", "PUT", draftConfig);
      setStatusMessage("Configuration saved.");
      setTimeout(() => setStatusMessage(null), 2000);
      await fetchBootstrap();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Config update failed");
    }
  }

  async function decideApproval(id: string, decision: "approved" | "denied", remember: boolean) {
    try {
      await apiRequest("/approvals/decision", "POST", { id, decision, remember });
      setStatusMessage(`Approval ${decision}.`);
      setTimeout(() => setStatusMessage(null), 2000);
      await fetchBootstrap();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Approval update failed");
    }
  }

  async function toggleTunnel() {
    try {
      const pathname = bootstrap?.desktop.tunnelRunning ? "/tunnel/stop" : "/tunnel/start";
      const result = await apiRequest<Bootstrap>(pathname, "POST");
      setBootstrap(result);
      setDraftConfig(result.runner.config);
      setStatusMessage(result.desktop.tunnelRunning ? "Tunnel started." : "Tunnel stopped.");
      setTimeout(() => setStatusMessage(null), 2000);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Tunnel update failed");
    }
  }

  async function apiRequest<T = unknown>(pathname: string, method: string, body?: unknown) {
    const headers: Record<string, string> = {};
    if (desktopToken && apiBase === "/api/desktop") {
      headers["x-desktop-token"] = desktopToken;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await fetch(`${apiBase}${pathname}`, {
      method,
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      if (mode === "admin" && response.status === 401) {
        window.location.href = "/login";
      }
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.message ?? `Request failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  }
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
            This guide only covers the tunnel and how to link your MCP server in ChatGPT Apps &amp; Connectors.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-6 grid gap-4">
          <Card className="border-emerald-300/12 bg-[radial-gradient(circle_at_top_left,rgba(112,240,175,0.12),transparent_28%),linear-gradient(180deg,rgba(9,15,25,0.96),rgba(7,11,20,0.96))]">
            <CardHeader>
              <CardTitle className="text-2xl">Use these public URLs</CardTitle>
              <CardDescription>
                In ChatGPT Apps &amp; Connectors, use the MCP server URL. The admin dashboard URL is not the one you
                paste into the app connection.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <SetupUrlField
                label="MCP server URL for ChatGPT"
                value={publicMcpUrl ?? "Not detected yet"}
                disabled={!publicMcpUrl}
              />
              <SetupUrlField
                label="Remote admin URL"
                value={publicAdminUrl ?? "Not detected yet"}
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
        <div className={`setup-check ${done ? "done" : ""}`}>{done ? "Done" : index}</div>
        <div>
          <h3 className="font-['IBM_Plex_Sans'] text-2xl font-semibold text-white">{title}</h3>
          <p className="mt-2 text-base leading-7 text-slate-400">{description}</p>
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
        <Input value={value} readOnly disabled={disabled} className="pr-24 font-mono text-xs sm:text-sm" />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            disabled={disabled}
            onClick={async () => {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
          {value.startsWith("https://") ? (
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "ghost", size: "icon" })}
              aria-disabled={disabled}
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function OverlayView({ bootstrap, desktopToken }: { bootstrap: Bootstrap | null; desktopToken?: string }) {
  const [frameTime, setFrameTime] = useState(() => Date.now());
  const [look, setLook] = useState({ x: 0, y: 0, surprise: 0 });
  const randomnessRef = useRef({ x: 0, y: 0, until: 0 });
  const approvalCount = bootstrap?.runner.approvals.length ?? 0;
  const primaryApproval = bootstrap?.runner.approvals[0] ?? null;
  const runnerRunning = bootstrap?.desktop.runnerRunning ?? false;
  const isConnected = bootstrap?.runner.status.connectedToRemote ?? false;
  const tunnelRunning = bootstrap?.desktop.tunnelRunning ?? false;
  const runningProcesses = bootstrap?.runner.status.runningProcesses ?? 0;
  const latestActivity = bootstrap?.runner.activity.at(-1) ?? null;
  const latestTimestamp = latestActivity ? new Date(latestActivity.timestamp).getTime() : 0;
  const recentAgeMs = latestTimestamp > 0 ? Date.now() - latestTimestamp : Number.POSITIVE_INFINITY;
  const isRecentlyActive = latestTimestamp > 0 && recentAgeMs < 7_500;
  const cursor = bootstrap?.desktop.cursor ?? { x: 0, y: 0, distance: 9999, near: false };

  const avatarState: "idle" | "working" | "alert" | "offline" =
    !runnerRunning || !isConnected
      ? "offline"
      : approvalCount > 0
        ? "alert"
        : runningProcesses > 0 || isRecentlyActive
          ? "working"
          : "idle";
  const isProcessing =
    runningProcesses > 0 ||
    (latestActivity?.type === "tool_call" && recentAgeMs < 1_600);

  useEffect(() => {
    const intervalId = window.setInterval(() => setFrameTime(Date.now()), 80);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      if (now > randomnessRef.current.until) {
        randomnessRef.current = {
          x: (Math.random() - 0.5) * 0.18,
          y: (Math.random() - 0.5) * 0.12,
          until: now + 1400 + Math.random() * 2200,
        };
      }

      const curiousTarget = avatarState === "idle" && cursor.near && !isProcessing ? 1 : 0;
      const targetX =
        avatarState === "offline" || isProcessing
          ? 0
          : (cursor.near ? cursor.x * 0.72 : 0) + (avatarState === "idle" ? randomnessRef.current.x : 0);
      const targetY =
        avatarState === "offline" || isProcessing
          ? 0
          : (cursor.near ? -cursor.y * 0.48 : 0) + (avatarState === "idle" ? randomnessRef.current.y : 0);

      setLook((current) => ({
        x: lerp(current.x, targetX, 0.16),
        y: lerp(current.y, targetY, 0.14),
        surprise: lerp(current.surprise, curiousTarget, 0.08),
      }));
    }, 48);

    return () => window.clearInterval(intervalId);
  }, [avatarState, cursor.near, cursor.x, cursor.y, isProcessing]);

  const phase = frameTime / 1000;
  const curiousCycle = (Math.sin(phase * 0.72) + 1) / 2;
  const curious = avatarState === "idle" && cursor.near && curiousCycle > 0.4;

  async function decideFromOverlay(decision: "approved" | "denied", remember: boolean) {
    if (!primaryApproval) {
      return;
    }
    await fetch("/api/desktop/approvals/decision", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(desktopToken ? { "x-desktop-token": desktopToken } : {}),
      },
      body: JSON.stringify({ id: primaryApproval.id, decision, remember }),
    });
  }

  return (
    <div className="overlay-shell">
      <div className={`pet-dock ${avatarState} ${curious ? "curious" : ""}`}>
        {primaryApproval ? (
          <div className="pet-bubble">
            <div className="pet-bubble-chip">{primaryApproval.toolName}</div>
            <strong>{primaryApproval.summary}</strong>
            <code className="pet-bubble-command">{formatApprovalPreview(primaryApproval.toolName, primaryApproval.payload)}</code>
            <div className="pet-bubble-actions">
              <button className="pet-bubble-button ghost" onClick={() => void decideFromOverlay("denied", false)}>
                Deny
              </button>
              <button className="pet-bubble-button secondary" onClick={() => void decideFromOverlay("approved", true)}>
                Approve + Remember
              </button>
              <button className="pet-bubble-button primary" onClick={() => void decideFromOverlay("approved", false)}>
                Approve Once
              </button>
            </div>
          </div>
        ) : null}
        <PetSphereCanvas
          avatarState={avatarState}
          curious={curious}
          isProcessing={isProcessing}
          look={look}
          phase={phase}
          surprise={look.surprise}
        />
        {avatarState === "offline" ? (
          <div className="pet-sleep" aria-hidden="true">
            <span>Z</span>
            <span>z</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function buildBlink(phase: number, avatarState: "idle" | "working" | "alert" | "offline", curious: boolean) {
  if (curious) {
    return 0.18;
  }
  if (avatarState === "alert") {
    return 0.08 + Math.max(0, Math.sin(phase * 6.8)) * 0.1;
  }
  const cycle = (phase * (avatarState === "working" ? 1.35 : 0.9)) % 4.2;
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

function PetSphereCanvas({
  avatarState,
  curious,
  isProcessing,
  look,
  phase,
  surprise,
}: {
  avatarState: "idle" | "working" | "alert" | "offline";
  curious: boolean;
  isProcessing: boolean;
  look: { x: number; y: number; surprise: number };
  phase: number;
  surprise: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const size = 220;
    if (canvas.width !== size * dpr || canvas.height !== size * dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPetSphere(ctx, { avatarState, curious, isProcessing, look, phase, surprise });
  }, [avatarState, curious, isProcessing, look, phase, surprise]);

  return <canvas ref={canvasRef} className="pet-canvas" aria-hidden="true" />;
}

function drawPetSphere(
  ctx: CanvasRenderingContext2D,
  input: {
    avatarState: "idle" | "working" | "alert" | "offline";
    curious: boolean;
    isProcessing: boolean;
    look: { x: number; y: number; surprise: number };
    phase: number;
    surprise: number;
  },
) {
  const { avatarState, curious, isProcessing, look, phase, surprise } = input;
  const size = 220;
  const cx = 110;
  const cy = 110;
  const radius = 72;
  const yaw = clamp(look.x * 0.9, -0.85, 0.85);
  const pitch = clamp(look.y * 0.7, -0.65, 0.65);
  const palette = getSpherePalette(avatarState);

  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(112, 188, 52, 14, 0, 0, Math.PI * 2);
  ctx.fill();

  renderSphereBody(ctx, cx, cy, radius, yaw, pitch, palette);

  const blink = buildBlink(phase, avatarState, curious);
  const eyeScaleY =
    curious ? 0.62 - surprise * 0.12 : avatarState === "idle" ? Math.max(0.34, 0.82 - blink * 0.52) : Math.max(0.24, 0.92 - blink * 0.72);
  const eyeScaleX = curious ? 1.22 : isProcessing ? 1.05 : 1;
  const mouthCurve = curious ? 1.8 : avatarState === "working" ? 7 : avatarState === "offline" ? 1.8 : 4.5;

  if (avatarState === "alert" || curious) {
    drawBrows(ctx, yaw, pitch, palette.line);
  }

  if (avatarState === "offline") {
    drawSleepEyes(ctx, yaw, pitch, palette.lineMuted);
  } else if (isProcessing) {
    drawBitEyes(ctx, yaw, pitch, palette.line, Math.floor(phase * 8));
  } else {
    drawEye(ctx, { x: -0.27, y: -0.1 }, yaw, pitch, eyeScaleX, eyeScaleY, palette.line);
    drawEye(ctx, { x: 0.27, y: -0.1 }, yaw, pitch, eyeScaleX, eyeScaleY, palette.line);
  }

  if (avatarState === "alert" || curious) {
    drawOpenMouth(ctx, yaw, pitch, curious ? 0.075 : 0.09, curious ? 0.11 : 0.13, palette.line);
  } else {
    drawMouthCurve(ctx, yaw, pitch, mouthCurve, palette.line);
  }
}

function renderSphereBody(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  yaw: number,
  pitch: number,
  palette: { rim: string; line: string; lineMuted: string; shadow: [number, number, number] },
) {
  const offscreen = document.createElement("canvas");
  offscreen.width = radius * 2;
  offscreen.height = radius * 2;
  const offCtx = offscreen.getContext("2d")!;
  const image = offCtx.createImageData(radius * 2, radius * 2);
  const keyLight = normalize3([0.02 + yaw * 0.08, 0.01 + pitch * 0.06, 1]);
  const fillLight = normalize3([0.24, 0.12, 0.96]);
  const rimLight = normalize3([-0.42, 0.04, 0.58]);
  const [shadowR, shadowG, shadowB] = palette.shadow;

  for (let py = -radius; py < radius; py += 1) {
    for (let px = -radius; px < radius; px += 1) {
      const nx = px / radius;
      const ny = py / radius;
      const rr = nx * nx + ny * ny;
      if (rr > 1) {
        continue;
      }
      const nz = Math.sqrt(1 - rr);
      const rotated = rotate3([nx, ny, nz], yaw * 0.9, pitch * 0.8);
      const diffuse = Math.max(0, dot3(rotated, keyLight));
      const fill = Math.max(0, dot3(rotated, fillLight));
      const rim = Math.pow(Math.max(0, dot3(rotated, rimLight)), 7);
      const fresnel = Math.pow(1 - Math.max(0, rotated[2]), 2.8);
      const latitude = 0.5 + 0.5 * rotated[1];
      const specular = Math.pow(Math.max(0, dot3(rotated, normalize3([0.02, -0.02, 1]))), 18) * 28;
      const shade = 0.14 + diffuse * 0.56 + fill * 0.16;
      const tint = 0.34 + latitude * 0.44;

      const base = shadowR + 10 + shade * 22 + rim * 5;
      const green = shadowG + 12 + shade * 20 + tint * 3 + rim * 5 + specular * 0.24;
      const blue = shadowB + 16 + shade * 24 + (1 - latitude) * 7 + fresnel * 12 + specular * 0.36;

      const index = ((py + radius) * radius * 2 + (px + radius)) * 4;
      image.data[index] = clampByte(base);
      image.data[index + 1] = clampByte(green);
      image.data[index + 2] = clampByte(blue);
      image.data[index + 3] = 255;
    }
  }

  offCtx.putImageData(image, 0, 0);
  ctx.drawImage(offscreen, cx - radius, cy - radius, radius * 2, radius * 2);

  ctx.strokeStyle = palette.rim;
  ctx.lineWidth = 6.5;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
}

function drawEye(
  ctx: CanvasRenderingContext2D,
  origin: { x: number; y: number },
  yaw: number,
  pitch: number,
  scaleX: number,
  scaleY: number,
  color: string,
) {
  const point = projectOnSphere(origin.x, origin.y, yaw, pitch);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(point.x, point.y, 9.6 * scaleX * point.scale, 9.6 * scaleY * point.scale, point.rotation, 0, Math.PI * 2);
  ctx.fill();
}

function drawSleepEyes(ctx: CanvasRenderingContext2D, yaw: number, pitch: number, color: string) {
  drawProjectedLine(ctx, sampleSleepEye(-0.27, -0.08), yaw, pitch, color, 4.5);
  drawProjectedLine(ctx, sampleSleepEye(0.27, -0.08), yaw, pitch, color, 4.5);
}

function drawBitEyes(ctx: CanvasRenderingContext2D, yaw: number, pitch: number, color: string, tick: number) {
  const leftPoint = projectOnSphere(-0.27, -0.1, yaw, pitch);
  const rightPoint = projectOnSphere(0.27, -0.1, yaw, pitch);
  const visorY = (leftPoint.y + rightPoint.y) / 2;
  const visorScale = (leftPoint.scale + rightPoint.scale) / 2;
  drawVisorEye(ctx, leftPoint.x, visorY, visorScale, color, tick, 17);
  drawVisorEye(ctx, rightPoint.x, visorY, visorScale, color, tick + 9, 53);
}

function drawVisorEye(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  scale: number,
  color: string,
  tick: number,
  seed: number,
) {
  const width = 30 * scale;
  const height = 11 * scale;
  const radius = height / 2;
  const x = centerX - width / 2;
  const y = centerY - height / 2;
  const sequence = createVisorSequence(seed, 72);
  const fontSize = 13.5 * scale;
  const letterSpacing = 5.2 * scale;
  const charAdvance = fontSize * 0.56 + letterSpacing;
  const textWidth = sequence.length * charAdvance;
  const offset = ((tick * 2.75) % Math.max(1, textWidth)) - textWidth;

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.clip();

  ctx.font = `700 ${fontSize}px "IBM Plex Mono", monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  drawTrackingText(ctx, sequence, x + offset, centerY + 0.5, charAdvance);
  drawTrackingText(ctx, sequence, x + offset + textWidth + width * 0.65, centerY + 0.5, charAdvance);

  const fade = ctx.createLinearGradient(x, 0, x + width, 0);
  fade.addColorStop(0, "rgba(0,0,0,0)");
  fade.addColorStop(0.18, "rgba(0,0,0,1)");
  fade.addColorStop(0.82, "rgba(0,0,0,1)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = fade;
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

function drawBrows(ctx: CanvasRenderingContext2D, yaw: number, pitch: number, color: string) {
  drawProjectedLine(ctx, sampleBrow(-0.3, -0.28, -0.08), yaw, pitch, color, 4.5);
  drawProjectedLine(ctx, sampleBrow(0.12, -0.3, 0.08), yaw, pitch, color, 4.5);
}

function drawMouthCurve(ctx: CanvasRenderingContext2D, yaw: number, pitch: number, curve: number, color: string) {
  const points = Array.from({ length: 16 }, (_, index) => {
    const t = -1 + (index / 15) * 2;
    return {
      x: t * 0.18,
      y: 0.3 - (1 - t * t) * (curve / 120),
    };
  });
  drawProjectedLine(ctx, points, yaw, pitch, color, 5);
}

function drawOpenMouth(
  ctx: CanvasRenderingContext2D,
  yaw: number,
  pitch: number,
  rx: number,
  ry: number,
  color: string,
) {
  const center = projectOnSphere(0, 0.28, yaw, pitch);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(center.x, center.y, rx * 110 * center.scale, ry * 110 * center.scale, center.rotation, 0, Math.PI * 2);
  ctx.fill();
}

function drawProjectedLine(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  yaw: number,
  pitch: number,
  color: string,
  width: number,
) {
  const projected = points.map((point) => projectOnSphere(point.x, point.y, yaw, pitch));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  projected.forEach((point, index) => {
    if (index === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  });
  ctx.stroke();
}

function projectOnSphere(x: number, y: number, yaw: number, pitch: number) {
  const z = Math.sqrt(Math.max(0.001, 1 - x * x - y * y));
  const rotated = rotate3([x, y, z], yaw, pitch);
  const perspective = 1 / (1.28 - rotated[2] * 0.38);
  return {
    x: 110 + rotated[0] * 72 * perspective,
    y: 110 + rotated[1] * 72 * perspective,
    scale: 0.84 + rotated[2] * 0.22,
    rotation: Math.atan2(rotated[1], rotated[0]) * 0.12,
  };
}

function sampleCross(cx: number, cy: number, radius: number, slope: 1 | -1) {
  return [
    { x: cx - radius, y: cy - radius * slope },
    { x: cx + radius, y: cy + radius * slope },
  ];
}

function sampleSleepEye(cx: number, cy: number) {
  return Array.from({ length: 10 }, (_, index) => {
    const t = index / 9;
    const x = cx - 0.08 + t * 0.16;
    const bend = Math.sin(t * Math.PI) * 0.022;
    return { x, y: cy + bend };
  });
}

function sampleBrow(startX: number, startY: number, endOffsetY: number) {
  return [
    { x: startX, y: startY },
    { x: startX + 0.14, y: startY + endOffsetY },
  ];
}

function rotate3([x, y, z]: [number, number, number], yaw: number, pitch: number): [number, number, number] {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const y1 = y * cp - z1 * sp;
  const z2 = y * sp + z1 * cp;
  return [x1, y1, z2];
}

function dot3(a: [number, number, number], b: [number, number, number]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize3([x, y, z]: [number, number, number]): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function drawTrackingText(ctx: CanvasRenderingContext2D, text: string, startX: number, centerY: number, advance: number) {
  for (let index = 0; index < text.length; index += 1) {
    ctx.fillText(text[index] ?? "", startX + index * advance, centerY);
  }
}

function createVisorSequence(seed: number, length: number) {
  let value = seed >>> 0;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    value = (value * 1664525 + 1013904223) >>> 0;
    output += ((value >>> 30) & 1).toString();
  }
  return output;
}

function getSpherePalette(avatarState: "idle" | "working" | "alert" | "offline") {
  if (avatarState === "alert") {
    return {
      rim: "rgba(142, 149, 158, 0.62)",
      line: "rgba(252,245,247,0.98)",
      lineMuted: "rgba(252,245,247,0.72)",
      shadow: [18, 10, 18] as [number, number, number],
    };
  }
  if (avatarState === "offline") {
    return {
      rim: "rgba(126, 133, 145, 0.56)",
      line: "rgba(244,247,250,0.92)",
      lineMuted: "rgba(244,247,250,0.74)",
      shadow: [16, 18, 24] as [number, number, number],
    };
  }
  return {
    rim: "rgba(132, 140, 152, 0.5)",
    line: "rgba(248,250,252,0.98)",
    lineMuted: "rgba(248,250,252,0.44)",
    shadow: [10, 12, 20] as [number, number, number],
  };
}

function formatApprovalPreview(toolName: string, payload: unknown) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (toolName === "run_command") {
      const command = Array.isArray(record.command) ? record.command.join(" ") : "";
      const cwd = typeof record.workingDirectory === "string" ? record.workingDirectory : "";
      return `${cwd} $ ${command}`.trim();
    }
    if (toolName === "run_repo_task" || toolName === "start_dev_server") {
      const cwd = typeof record.projectPath === "string" ? record.projectPath : "";
      const taskId = typeof record.taskId === "string" ? record.taskId : "";
      return `${cwd} • ${taskId}`.trim();
    }
    if ("path" in record && typeof record.path === "string") {
      return record.path;
    }
  }

  const raw = JSON.stringify(payload);
  return raw && raw !== "{}" ? raw : "Approval requested";
}

function LoginView() {
  return (
    <Card className="login-shell">
      <CardHeader className="p-7">
        <p className="eyebrow">agent-companion</p>
        <CardTitle className="text-5xl">Remote admin sign-in required</CardTitle>
        <CardDescription>
          The remote admin interface is protected by Google OAuth and the local admin allowlist. Sign in to manage
          permissions, approvals, and activity from another device.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-7 pb-7 pt-0">
        <a className={buttonVariants({ variant: "default" })} href="/auth/login/google">
          Continue With Google
        </a>
      </CardContent>
    </Card>
  );
}

function MetricCard({
  title,
  value,
  actionLabel,
  onAction,
}: {
  title: string;
  value: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}) {
  return (
    <Card className="metric-card">
      <span>{title}</span>
      <strong>{value}</strong>
      {actionLabel && onAction ? (
        <Button variant="secondary" className="metric-action" onClick={() => void onAction()}>
          {actionLabel}
        </Button>
      ) : null}
    </Card>
  );
}

function PanelHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="panel-header">
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </header>
  );
}

function EditorList({
  title,
  items,
  onChange,
}: {
  title: string;
  items: AgentCompanionConfig["tasks"];
  onChange: (items: AgentCompanionConfig["tasks"]) => void;
}) {
  return (
    <section className="editor-list">
      <h3>{title}</h3>
      {items.map((task) => (
        <div key={task.id} className="editor-row">
          <Input
            value={task.label}
            onChange={(event) =>
              onChange(items.map((entry) => (entry.id === task.id ? { ...entry, label: event.target.value } : entry)))
            }
            placeholder="Label"
          />
          <Input
            value={task.command.join(" ")}
            onChange={(event) =>
              onChange(
                items.map((entry) =>
                  entry.id === task.id
                    ? { ...entry, command: event.target.value.split(" ").map((part) => part.trim()).filter(Boolean) }
                    : entry,
                ),
              )
            }
            placeholder="npm run build"
          />
          <Button variant="ghost" onClick={() => onChange(items.filter((entry) => entry.id !== task.id))}>
            Remove
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        onClick={() =>
          onChange([
            ...items,
            {
              id: crypto.randomUUID(),
              label: "New task",
              command: ["npm", "run", "build"],
              managed: false,
              timeoutMs: 60000,
              outputLimitBytes: 32000,
            },
          ])
        }
      >
        Add Task
      </Button>
    </section>
  );
}

function RunCommandRulesEditor({
  rules,
  onChange,
}: {
  rules: AgentCompanionConfig["runCommandRules"];
  onChange: (rules: AgentCompanionConfig["runCommandRules"]) => void;
}) {
  return (
    <section className="editor-list">
      <h3>`run_command` Policy</h3>
      {rules.map((rule) => (
        <div key={rule.id} className="editor-row">
          <Input
            value={rule.label}
            onChange={(event) =>
              onChange(rules.map((entry) => (entry.id === rule.id ? { ...entry, label: event.target.value } : entry)))
            }
            placeholder="Label"
          />
          <Input
            value={rule.command.join(" ")}
            onChange={(event) =>
              onChange(
                rules.map((entry) =>
                  entry.id === rule.id
                    ? { ...entry, command: event.target.value.split(" ").map((part) => part.trim()).filter(Boolean) }
                    : entry,
                ),
              )
            }
            placeholder="git status"
          />
          <label className="toggle">
            <input
              type="checkbox"
              checked={rule.approvalRequired}
              onChange={(event) =>
                onChange(
                  rules.map((entry) =>
                    entry.id === rule.id ? { ...entry, approvalRequired: event.target.checked } : entry,
                  ),
                )
              }
            />
            <span>Needs approval</span>
          </label>
          <Button variant="ghost" onClick={() => onChange(rules.filter((entry) => entry.id !== rule.id))}>
            Remove
          </Button>
        </div>
      ))}
      <Button
        variant="secondary"
        onClick={() =>
          onChange([
            ...rules,
            {
              id: crypto.randomUUID(),
              label: "New command rule",
              command: ["git", "status"],
              approvalRequired: true,
            },
          ])
        }
      >
        Add Rule
      </Button>
    </section>
  );
}
