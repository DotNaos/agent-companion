import {
    AppError,
    FileBackedStore,
    plutoVoiceSessionHistoryEntrySchema,
    plutoVoiceSessionHistoryListOutputSchema,
    plutoVoiceSessionHistoryPersistedEventSchema,
    type PlutoMessage,
    type PlutoVoiceSessionHistoryEntry,
    type PlutoVoiceSessionHistoryListOutput,
    type PlutoVoiceSessionHistoryPersistedEvent,
    type PlutoVoiceSessionStreamEvent,
} from "@agent-companion/shared";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const MAX_HISTORY_ENTRIES_PER_SESSION = 500;

const plutoVoiceSessionHistoryStoreSchema = z.object({
  version: z.literal(1).default(1),
  sessions: z.array(
    z.object({
      sessionId: z.string().min(1),
      updatedAt: z.string(),
      entries: z.array(plutoVoiceSessionHistoryEntrySchema).default([]),
    }),
  ).default([]),
});

export class PlutoVoiceSessionHistoryStore {
  private readonly store: FileBackedStore<z.infer<typeof plutoVoiceSessionHistoryStoreSchema>>;

  constructor(filePath: string) {
    this.store = new FileBackedStore(filePath, plutoVoiceSessionHistoryStoreSchema, () => ({
      version: 1,
      sessions: [],
    }));
  }

  ensureSession(sessionId: string) {
    this.store.update((current) => {
      if (!current.sessions.some((entry) => entry.sessionId === sessionId)) {
        current.sessions.push({
          sessionId,
          updatedAt: new Date().toISOString(),
          entries: [],
        });
      }
      return current;
    });
  }

  listSessionHistory(sessionId: string, limit = 200): PlutoVoiceSessionHistoryListOutput {
    const session = this.store.read().sessions.find((entry) => entry.sessionId === sessionId);
    if (!session) {
      throw new AppError("PLUTO_SESSION_HISTORY_NOT_FOUND", "Pluto voice session history not found", 404);
    }

    return plutoVoiceSessionHistoryListOutputSchema.parse({
      sessionId,
      entries: session.entries.slice(-limit),
    });
  }

  appendTextInput(sessionId: string, clientId: string, text: string) {
    this.appendEntry(sessionId, {
      kind: "text_input",
      id: randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      clientId,
      text,
    });
  }

  appendMessage(sessionId: string, message: PlutoMessage) {
    this.appendEntry(sessionId, {
      kind: "message",
      id: randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      message,
    });
  }

  appendStreamEvent(sessionId: string, event: PlutoVoiceSessionStreamEvent) {
    const persistedEvent = toPersistedHistoryEvent(event);
    if (!persistedEvent) {
      return;
    }

    this.appendEntry(sessionId, {
      kind: "stream_event",
      id: randomUUID(),
      sessionId,
      createdAt: new Date().toISOString(),
      event: persistedEvent,
    });
  }

  private appendEntry(sessionId: string, entry: PlutoVoiceSessionHistoryEntry) {
    this.store.update((current) => {
      let session = current.sessions.find((record) => record.sessionId === sessionId);
      if (!session) {
        session = {
          sessionId,
          updatedAt: new Date().toISOString(),
          entries: [],
        };
        current.sessions.push(session);
      }

      session.updatedAt = new Date().toISOString();
      session.entries.push(plutoVoiceSessionHistoryEntrySchema.parse(entry));
      if (session.entries.length > MAX_HISTORY_ENTRIES_PER_SESSION) {
        session.entries.splice(0, session.entries.length - MAX_HISTORY_ENTRIES_PER_SESSION);
      }
      return current;
    });
  }
}

function toPersistedHistoryEvent(
  event: PlutoVoiceSessionStreamEvent,
): PlutoVoiceSessionHistoryPersistedEvent | null {
  switch (event.type) {
    case "audio_chunk":
    case "session_snapshot":
    case "session_updated":
      return null;
    case "input_transcription":
    case "output_transcription":
    case "output_turn_complete":
    case "tool_call":
    case "tool_result":
    case "approval_requested":
    case "approval_resolved":
    case "status":
    case "error":
    case "closed":
      return plutoVoiceSessionHistoryPersistedEventSchema.parse(event);
  }
}
