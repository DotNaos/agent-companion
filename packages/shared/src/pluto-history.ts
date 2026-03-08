import { z } from "zod";
import { plutoMessageSchema, plutoVoiceSessionStatusSchema, toolNameSchema } from "./schemas.js";

export const plutoVoiceSessionHistoryPersistedEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("input_transcription"),
    turnId: z.number().int().positive(),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("output_transcription"),
    turnId: z.number().int().positive(),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("output_turn_complete"),
    turnId: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("tool_call"),
    toolName: toolNameSchema,
    summary: z.string().min(1),
    toolCallId: z.string().min(1).nullable().default(null),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolName: toolNameSchema,
    summary: z.string().min(1),
    ok: z.boolean(),
    toolCallId: z.string().min(1).nullable().default(null),
  }),
  z.object({
    type: z.literal("approval_requested"),
    approvalId: z.string().min(1),
    toolName: toolNameSchema,
    summary: z.string().min(1),
  }),
  z.object({
    type: z.literal("approval_resolved"),
    approvalId: z.string().min(1),
    toolName: toolNameSchema,
    decision: z.enum(["approved", "denied"]),
  }),
  z.object({
    type: z.literal("status"),
    status: plutoVoiceSessionStatusSchema,
    waitingForInput: z.boolean().optional(),
    interrupted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal("closed"),
    reason: z.string().nullable().default(null),
  }),
]);

export const plutoVoiceSessionHistoryEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text_input"),
    id: z.string().min(1),
    sessionId: z.string().min(1),
    createdAt: z.string(),
    clientId: z.string().min(1),
    text: z.string().trim().min(1).max(4_000),
  }),
  z.object({
    kind: z.literal("message"),
    id: z.string().min(1),
    sessionId: z.string().min(1),
    createdAt: z.string(),
    message: plutoMessageSchema,
  }),
  z.object({
    kind: z.literal("stream_event"),
    id: z.string().min(1),
    sessionId: z.string().min(1),
    createdAt: z.string(),
    event: plutoVoiceSessionHistoryPersistedEventSchema,
  }),
]);

export const plutoVoiceSessionHistoryListOutputSchema = z.object({
  sessionId: z.string().min(1),
  entries: z.array(plutoVoiceSessionHistoryEntrySchema),
});

export const plutoVoiceSessionHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).default(200),
});

export type PlutoVoiceSessionHistoryPersistedEvent = z.infer<typeof plutoVoiceSessionHistoryPersistedEventSchema>;
export type PlutoVoiceSessionHistoryEntry = z.infer<typeof plutoVoiceSessionHistoryEntrySchema>;
export type PlutoVoiceSessionHistoryListOutput = z.infer<typeof plutoVoiceSessionHistoryListOutputSchema>;
export type PlutoVoiceSessionHistoryQuery = z.infer<typeof plutoVoiceSessionHistoryQuerySchema>;
