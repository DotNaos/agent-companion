import { plutoVoiceSessionAudioChunkSchema, plutoVoiceSessionStreamEventSchema, type PlutoVoiceSessionAudioChunk, type PlutoVoiceSessionStreamEvent } from "@agent-companion/shared";
import { type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import { EndSensitivity, Modality, StartSensitivity, TurnCoverage, type LiveServerMessage } from "@google/genai";
import type { GoogleGenAI } from "@google/genai";
import { randomUUID } from "node:crypto";
import { CodexSessionManager } from "./codex-session-manager.js";
import type { RunnerEnv } from "./env.js";
import {
  buildSpeechPrompt,
  describeAutoProgress,
  extractResponseText,
  resolvePlutoTextModel,
  summarizeCommandResult,
  summarizeFileChange,
  summarizeMcpResult,
} from "./pluto-voice-runtime-helpers.js";

export interface PlutoVoiceSessionRegistration {
  emit: (event: PlutoVoiceSessionStreamEvent) => void;
}

type LiveSessionConnection = Awaited<ReturnType<GoogleGenAI["live"]["connect"]>>;

const speakToUserInputSchema = {
  parse(payload: unknown) {
    const text = typeof (payload as Record<string, unknown>)?.text === "string"
      ? ((payload as Record<string, unknown>).text as string).trim()
      : "";
    const mode = (payload as Record<string, unknown>)?.mode;
    const steer = typeof (payload as Record<string, unknown>)?.steer === "string"
      ? ((payload as Record<string, unknown>).steer as string).trim()
      : undefined;
    const kind = (payload as Record<string, unknown>)?.kind;

    if (!text) {
      throw new Error("speak_to_user requires non-empty text");
    }

    return {
      text,
      mode: mode === "summarize" ? "summarize" : "plain",
      steer,
      kind: kind === "progress" ? "progress" : "final",
    } as const;
  },
};

export class PlutoVoiceSessionRuntime {
  private readonly codex: CodexSessionManager;
  private transcriptionSession: LiveSessionConnection | null = null;
  private connectingTranscription: Promise<LiveSessionConnection> | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private currentTurnAbortController: AbortController | null = null;
  private currentSpeechAbortController: AbortController | null = null;
  private currentVoiceTranscript = "";
  private lastInputTranscript = "";
  private nextInputTurnId = 1;
  private activeInputTurnId: number | null = null;
  private nextOutputTurnId = 1;
  private activeOutputTurnId: number | null = null;
  private currentOutputText = "";
  private spokeThisTurn = false;
  private announcedProgressThisTurn = false;
  private autoProgressTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingProgressMessage: string | null = null;
  private closing = false;

  constructor(
    private readonly ai: GoogleGenAI | null,
    private readonly env: RunnerEnv,
    private readonly sessionId: string,
    private readonly emit: (event: PlutoVoiceSessionStreamEvent) => void,
    private readonly audioEnabledResolver: () => boolean,
  ) {
    this.codex = new CodexSessionManager({
      baseUrl: process.env.OPENAI_BASE_URL?.trim() || undefined,
      model: env.PLUTO_CODEX_MODEL,
      workingDirectory: env.PLUTO_CODEX_WORKING_DIRECTORY,
      speechServerUrl: buildSpeechServerUrl(env.LOCAL_RUNNER_PORT, sessionId),
    });
  }

  async sendAudioChunk(chunk: PlutoVoiceSessionAudioChunk) {
    if (!this.ai) {
      throw new Error("Gemini is not configured for Pluto voice transcription");
    }

    const parsed = plutoVoiceSessionAudioChunkSchema.parse(chunk);
    this.interruptActiveOutput("listening");
    const session = await this.ensureTranscriptionSession();
    this.emitEvent({
      type: "status",
      status: "listening",
    });
    session.sendRealtimeInput({
      audio: {
        data: parsed.audioBase64,
        mimeType: parsed.mimeType,
      },
    });
  }

  async endAudioStream() {
    if (!this.ai) {
      throw new Error("Gemini is not configured for Pluto voice transcription");
    }
    const session = await this.ensureTranscriptionSession();
    session.sendRealtimeInput({
      audioStreamEnd: true,
    });
  }

  async sendTextTurn(text: string) {
    const prompt = text.trim();
    if (!prompt) {
      return;
    }
    this.interruptActiveOutput("listening");
    await this.enqueueTurn(prompt);
  }

  async executeLocalTool(
    toolName: string,
    payload: unknown,
    options: { audioEnabled: boolean },
  ) {
    if (toolName !== "speak_to_user") {
      return {
        ok: false,
        error: {
          code: "UNKNOWN_PLUTO_VOICE_TOOL",
          message: `Unknown Pluto voice tool: ${toolName}`,
        },
      };
    }

    const input = speakToUserInputSchema.parse(payload);
    this.codex.setAudioEnabled(options.audioEnabled);

    if (!options.audioEnabled) {
      return {
        ok: false,
        error: {
          code: "PLUTO_AUDIO_DISABLED",
          message: "Audio output is disabled for this Pluto session.",
        },
      };
    }

    if (!this.ai) {
      return {
        ok: false,
        error: {
          code: "PLUTO_VOICE_UNAVAILABLE",
          message: "Gemini is not configured for Pluto speech delivery.",
        },
      };
    }

    const spokenText =
      input.mode === "summarize"
        ? await this.summarizeForSpeech(input.text, input.steer)
        : input.text;
    const deliveryId = randomUUID();
    this.clearAutoProgressTimer();
    this.emitEvent({
      type: "tool_result",
      toolName: "speak_to_user",
      summary: spokenText,
      ok: true,
      toolCallId: deliveryId,
    });

    await this.streamSpeech(spokenText, input.steer);
    this.spokeThisTurn = input.kind === "final";
    this.announcedProgressThisTurn = true;

    return {
      ok: true,
      data: {
        spokenText,
        deliveryId,
        audioAvailable: true,
        kind: input.kind,
        mode: input.mode,
      },
    };
  }

  close(reason: string | null = "session_closed") {
    this.closing = true;
    this.currentTurnAbortController?.abort();
    this.currentSpeechAbortController?.abort();
    this.transcriptionSession?.close();
    this.transcriptionSession = null;
    this.connectingTranscription = null;
    this.emitEvent({
      type: "closed",
      reason,
    });
  }

  private async ensureTranscriptionSession() {
    if (this.transcriptionSession) {
      return this.transcriptionSession;
    }
    if (this.connectingTranscription) {
      return this.connectingTranscription;
    }
    if (!this.ai) {
      throw new Error("Gemini is not configured for Pluto voice transcription");
    }

    this.connectingTranscription = this.ai.live.connect({
      model: this.env.PLUTO_MODEL,
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          this.handleTranscriptionMessage(message);
        },
        onerror: (event: ErrorEvent) => {
          this.transcriptionSession = null;
          this.connectingTranscription = null;
          this.emitEvent({
            type: "error",
            code: "PLUTO_TRANSCRIPTION_ERROR",
            message: event.message,
          });
        },
        onclose: (event: CloseEvent) => {
          this.transcriptionSession = null;
          this.connectingTranscription = null;
          if (!this.closing) {
            this.emitEvent({
              type: "closed",
              reason: event.reason || null,
            });
          }
          this.closing = false;
        },
      },
      config: {
        responseModalities: [Modality.TEXT],
        systemInstruction: [
          "Transcribe the user's speech verbatim.",
          "Do not answer the user.",
          "Do not add commentary or extra words.",
        ].join(" "),
        inputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 120,
            silenceDurationMs: 700,
          },
          turnCoverage: TurnCoverage.TURN_INCLUDES_ALL_INPUT,
        },
      },
    })
      .then((session) => {
        this.transcriptionSession = session;
        this.connectingTranscription = null;
        return session;
      })
      .catch((error) => {
        this.connectingTranscription = null;
        throw error;
      });

    return this.connectingTranscription;
  }

  private handleTranscriptionMessage(message: LiveServerMessage) {
    const inputTranscription = message.serverContent?.inputTranscription?.text?.trim();
    if (inputTranscription) {
      this.currentVoiceTranscript = inputTranscription;
      if (inputTranscription !== this.lastInputTranscript) {
        if (this.activeInputTurnId === null) {
          this.activeInputTurnId = this.nextInputTurnId;
          this.nextInputTurnId += 1;
        }
        this.lastInputTranscript = inputTranscription;
        this.emitEvent({
          type: "input_transcription",
          turnId: this.activeInputTurnId,
          text: inputTranscription,
        });
      }
    }

    if (message.serverContent?.turnComplete) {
      const finalTranscript = this.currentVoiceTranscript.trim();
      this.currentVoiceTranscript = "";
      this.lastInputTranscript = "";
      this.activeInputTurnId = null;
      if (finalTranscript) {
        void this.enqueueTurn(finalTranscript);
      } else {
        this.emitEvent({
          type: "status",
          status: "idle",
          waitingForInput: true,
        });
      }
    }
  }

  private async enqueueTurn(prompt: string) {
    const nextTurn = this.turnQueue.then(() => this.runTurn(prompt));
    this.turnQueue = nextTurn.catch(() => undefined);
    return nextTurn;
  }

  private async runTurn(prompt: string) {
    this.codex.setAudioEnabled(this.audioEnabledResolver());
    this.currentOutputText = "";
    this.spokeThisTurn = false;
    this.announcedProgressThisTurn = false;
    this.clearAutoProgressTimer();
    this.activeOutputTurnId = this.nextOutputTurnId;
    this.nextOutputTurnId += 1;
    this.currentTurnAbortController = new AbortController();

    try {
      const streamed = await this.codex.runTurn(prompt, this.currentTurnAbortController.signal);
      this.emitEvent({
        type: "status",
        status: "responding",
      });
      for await (const event of streamed.events) {
        await this.handleCodexEvent(event);
      }

      if (this.audioEnabledResolver() && !this.spokeThisTurn && this.currentOutputText.trim()) {
        await this.streamSpeech(this.currentOutputText.trim());
      }

      if (this.activeOutputTurnId !== null) {
        this.emitEvent({
          type: "output_turn_complete",
          turnId: this.activeOutputTurnId,
        });
      }
      this.emitEvent({
        type: "status",
        status: "idle",
        waitingForInput: true,
      });
    } catch (error) {
      if (this.currentTurnAbortController?.signal.aborted) {
        return;
      }
      throw error;
    } finally {
      this.clearAutoProgressTimer();
      this.currentTurnAbortController = null;
      this.currentSpeechAbortController = null;
      this.activeOutputTurnId = null;
    }
  }

  private async handleCodexEvent(event: ThreadEvent) {
    switch (event.type) {
      case "turn.started":
      case "thread.started":
        return;
      case "error":
        this.emitEvent({
          type: "error",
          code: "PLUTO_CODEX_STREAM_ERROR",
          message: event.message,
        });
        return;
      case "turn.failed":
        this.emitEvent({
          type: "error",
          code: "PLUTO_CODEX_TURN_FAILED",
          message: event.error.message,
        });
        return;
      case "turn.completed":
        return;
      case "item.started":
        this.emitToolCall(event.item);
        return;
      case "item.updated":
        return;
      case "item.completed":
        this.emitItemCompletion(event.item);
        return;
    }
  }

  private emitToolCall(item: ThreadItem) {
    switch (item.type) {
      case "command_execution":
        this.emitEvent({
          type: "tool_call",
          toolName: "codex_command",
          summary: item.command,
          toolCallId: item.id,
        });
        this.scheduleAutoProgressUpdate(describeAutoProgress("codex_command", item.command));
        return;
      case "mcp_tool_call":
        if (item.tool === "speak_to_user") {
          return;
        }
        this.emitEvent({
          type: "tool_call",
          toolName: item.tool,
          summary: `${item.server}:${item.tool}`,
          toolCallId: item.id,
        });
        this.scheduleAutoProgressUpdate(describeAutoProgress(item.tool, `${item.server}:${item.tool}`));
        return;
      default:
        return;
    }
  }

  private emitItemCompletion(item: ThreadItem) {
    switch (item.type) {
      case "agent_message": {
        const text = item.text.trim();
        if (!text || this.activeOutputTurnId === null) {
          return;
        }
        this.currentOutputText = text;
        this.emitEvent({
          type: "output_transcription",
          turnId: this.activeOutputTurnId,
          text,
        });
        return;
      }
      case "reasoning": {
        const text = item.text.trim();
        if (!text) {
          return;
        }
        this.emitEvent({
          type: "tool_result",
          toolName: "codex_reasoning",
          summary: text,
          ok: true,
          toolCallId: item.id,
        });
        return;
      }
      case "command_execution":
        this.emitEvent({
          type: "tool_result",
          toolName: "codex_command",
          summary: summarizeCommandResult(item),
          ok: item.status === "completed",
          toolCallId: item.id,
        });
        return;
      case "file_change":
        this.emitEvent({
          type: "tool_result",
          toolName: "codex_patch",
          summary: summarizeFileChange(item),
          ok: item.status === "completed",
          toolCallId: item.id,
        });
        return;
      case "mcp_tool_call":
        if (item.tool === "speak_to_user") {
          return;
        }
        this.emitEvent({
          type: "tool_result",
          toolName: item.tool,
          summary: summarizeMcpResult(item),
          ok: item.status === "completed",
          toolCallId: item.id,
        });
        return;
      case "error":
        this.emitEvent({
          type: "error",
          code: "PLUTO_CODEX_ITEM_ERROR",
          message: item.message,
        });
        return;
      default:
        return;
    }
  }

  private async summarizeForSpeech(text: string, steer?: string) {
    if (!this.ai) {
      return text;
    }

    const response = await this.ai.models.generateContent({
      model: resolvePlutoTextModel(this.env.PLUTO_MODEL),
      contents: [
        [
          "Summarize this answer for speech in 1 to 3 short sentences.",
          "Preserve actions, blockers, risks, and commitments.",
          steer ? `Style instruction: ${steer}` : "",
          `Answer: ${text}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ],
    });
    const summarized = extractResponseText(response).trim();
    return summarized || text;
  }

  private async streamSpeech(text: string, steer?: string) {
    const ai = this.ai;
    if (!ai) {
      throw new Error("Gemini is not configured for Pluto speech delivery");
    }
    if (this.activeOutputTurnId === null) {
      return;
    }

    this.currentSpeechAbortController?.abort();
    this.currentSpeechAbortController = new AbortController();
    const signal = this.currentSpeechAbortController.signal;

    await new Promise<void>((resolve, reject) => {
      let completed = false;

      void ai.live
        .connect({
          model: this.env.PLUTO_MODEL,
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              for (const part of message.serverContent?.modelTurn?.parts ?? []) {
                if (!part.inlineData?.data || signal.aborted) {
                  continue;
                }
                this.emitEvent({
                  type: "audio_chunk",
                  turnId: this.activeOutputTurnId ?? this.nextOutputTurnId,
                  audioBase64: part.inlineData.data,
                  mimeType: part.inlineData.mimeType ?? "audio/pcm;rate=24000",
                });
              }
              if (message.serverContent?.turnComplete) {
                completed = true;
                resolve();
              }
            },
            onerror: (event: ErrorEvent) => {
              if (!signal.aborted) {
                reject(new Error(event.message));
              }
            },
            onclose: (event: CloseEvent) => {
              if (!completed && !signal.aborted) {
                reject(new Error(event.reason || "Speech delivery closed unexpectedly"));
              }
            },
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              languageCode: "de-DE",
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: this.env.PLUTO_VOICE_NAME || "Achird",
                },
              },
            },
          },
        })
        .then((session) => {
          signal.addEventListener(
            "abort",
            () => {
              session.close();
              resolve();
            },
            { once: true },
          );
          session.sendClientContent({
            turns: [
              {
                role: "user",
                parts: [
                  {
                    text: buildSpeechPrompt(text, steer),
                  },
                ],
              },
            ],
            turnComplete: true,
          });
        })
        .catch(reject);
    });
  }

  private interruptActiveOutput(nextStatus: "listening" | "idle") {
    const wasActive = Boolean(this.currentTurnAbortController || this.currentSpeechAbortController);
    this.currentTurnAbortController?.abort();
    this.currentSpeechAbortController?.abort();
    this.clearAutoProgressTimer();
    if (wasActive) {
      this.emitEvent({
        type: "status",
        status: nextStatus,
        interrupted: true,
      });
    }
  }

  private emitEvent(event: PlutoVoiceSessionStreamEvent) {
    this.emit(plutoVoiceSessionStreamEventSchema.parse(event));
  }

  private clearAutoProgressTimer() {
    if (this.autoProgressTimer !== null) {
      globalThis.clearTimeout(this.autoProgressTimer);
      this.autoProgressTimer = null;
    }
    this.pendingProgressMessage = null;
  }

  private scheduleAutoProgressUpdate(message: string | null) {
    if (!message || !this.audioEnabledResolver() || !this.ai || this.spokeThisTurn || this.announcedProgressThisTurn) {
      return;
    }
    this.pendingProgressMessage = message;
    if (this.autoProgressTimer !== null) {
      return;
    }
    this.autoProgressTimer = globalThis.setTimeout(() => {
      this.autoProgressTimer = null;
      const nextMessage = this.pendingProgressMessage?.trim();
      this.pendingProgressMessage = null;
      if (!nextMessage || this.spokeThisTurn || this.announcedProgressThisTurn || this.activeOutputTurnId === null) {
        return;
      }
      this.announcedProgressThisTurn = true;
      this.emitEvent({
        type: "tool_result",
        toolName: "speak_to_user",
        summary: nextMessage,
        ok: true,
        toolCallId: `progress:${this.activeOutputTurnId}`,
      });
      void this.streamSpeech(nextMessage).catch(() => undefined);
    }, 4500);
  }
}

function buildSpeechServerUrl(port: number, sessionId: string) {
  return `http://127.0.0.1:${port}/internal/pluto/sessions/${encodeURIComponent(sessionId)}/codex-mcp`;
}
