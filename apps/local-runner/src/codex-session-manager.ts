import { Codex, type Thread, type ThreadEvent } from "@openai/codex-sdk";

export interface CodexSessionManagerOptions {
  baseUrl?: string;
  model: string;
  workingDirectory: string;
  speechServerUrl?: string | null;
}

export interface CodexTurnStream {
  events: AsyncGenerator<ThreadEvent>;
  threadId: string | null;
}

type CodexConfigObject = {
  [key: string]: string | number | boolean | CodexConfigObject | Array<string | number | boolean | CodexConfigObject>;
};

export class CodexSessionManager {
  private readonly baseUrl: string | undefined;
  private readonly model: string;
  private readonly workingDirectory: string;
  private readonly speechServerUrl: string | null;
  private thread: Thread | null = null;
  private threadId: string | null = null;
  private audioEnabled = false;
  private client = this.createClient(false);

  constructor(options: CodexSessionManagerOptions) {
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.workingDirectory = options.workingDirectory;
    this.speechServerUrl = options.speechServerUrl ?? null;
  }

  getThreadId() {
    return this.threadId;
  }

  setThreadId(threadId: string | null) {
    this.threadId = threadId;
    this.thread = null;
  }

  setAudioEnabled(enabled: boolean) {
    if (this.audioEnabled === enabled) {
      return;
    }
    this.audioEnabled = enabled;
    this.client = this.createClient(enabled);
    this.thread = null;
  }

  async runTurn(prompt: string, signal?: AbortSignal): Promise<CodexTurnStream> {
    this.assertCanRun();
    const thread = this.ensureThread();
    const streamed = await thread.runStreamed(prompt, { signal });
    return {
      threadId: this.threadId,
      events: this.trackThread(streamed.events),
    };
  }

  private ensureThread() {
    if (this.thread) {
      return this.thread;
    }

    const threadOptions = {
      model: this.model,
      workingDirectory: this.workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access" as const,
      networkAccessEnabled: true,
      approvalPolicy: "never" as const,
    };

    this.thread = this.threadId
      ? this.client.resumeThread(this.threadId, threadOptions)
      : this.client.startThread(threadOptions);
    return this.thread;
  }

  private assertCanRun() {
    if (process.env.VITEST) {
      throw new Error("Codex is not configured for Pluto voice sessions");
    }
  }

  private createClient(audioEnabled: boolean) {
    return new Codex({
      baseUrl: this.baseUrl,
      env: buildCodexEnvironment(process.env),
      config: buildCodexConfig(audioEnabled, this.speechServerUrl),
    });
  }

  private async *trackThread(events: AsyncGenerator<ThreadEvent>) {
    for await (const event of events) {
      if (event.type === "thread.started") {
        this.threadId = event.thread_id;
      }
      yield event;
    }
  }
}

export function buildCodexEnvironment(env: NodeJS.ProcessEnv) {
  const nextEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (key === "CODEX_API_KEY" || key === "OPENAI_API_KEY") {
      continue;
    }
    nextEnv[key] = value;
  }

  return nextEnv;
}

function buildCodexConfig(audioEnabled: boolean, speechServerUrl: string | null): CodexConfigObject {
  const config: CodexConfigObject = {
    developer_instructions: buildDeveloperInstructions(audioEnabled),
    history: {
      persistence: "save-all",
    },
  };

  if (audioEnabled && speechServerUrl) {
    config.mcp_servers = {
      pluto_voice: {
        url: speechServerUrl,
        enabled: true,
        required: false,
        tool_timeout_sec: 120,
        enabled_tools: ["speak_to_user"],
      },
    };
  }

  return config;
}

function buildDeveloperInstructions(audioEnabled: boolean) {
  const base = [
    "You are Codex, acting as the reasoning engine behind Pluto voice chat.",
    "The user may speak or type. Solve the request directly and use your normal coding and agent capabilities.",
    "Keep visible assistant text concise and high-signal because the desktop UI streams it live.",
    "Follow AGENTS.md and installed skills as your source of truth for workflows.",
  ];

  if (!audioEnabled) {
    return [
      ...base,
      "Audio output is disabled for this session.",
      "Do not call speak_to_user.",
      "Reply normally in text.",
    ].join(" ");
  }

  return [
    ...base,
    "Audio output is enabled for this session.",
    "For every final user-facing answer, call speak_to_user.",
    "If a voice turn takes more than a few seconds or needs multiple tool steps, call speak_to_user with kind=progress to keep the user informed about what you are doing and what you are waiting for.",
    "Do not stay silent for a long stretch during voice interactions.",
    "Use mode=plain when the text should be spoken verbatim.",
    "Use mode=summarize only when the answer is long and needs to be compressed for speech without dropping actions, risks, or blockers.",
    "Use kind=progress only for meaningful progress updates, not for every internal step.",
    "Keep direct assistant text as the canonical visible transcript, but rely on speak_to_user for what the user hears.",
  ].join(" ");
}
