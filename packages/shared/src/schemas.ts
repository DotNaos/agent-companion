import { z } from "zod";
import { CAPABILITIES, TOOL_NAMES } from "./constants.js";

const capabilityEnum = z.enum(CAPABILITIES);

export const mcpAccessModeSchema = z.enum(["read-only", "default", "full-access"]);

export const capabilityFlagsSchema = z.object({
  read: z.boolean().default(false),
  write: z.boolean().default(false),
  search: z.boolean().default(false),
  list: z.boolean().default(false),
  "execute-tasks": z.boolean().default(false),
  "run-command": z.boolean().default(false),
});

export const toolNameSchema = z.enum(TOOL_NAMES);

export const plutoToneSchema = z.enum([
  "encouraging",
  "humorous",
  "neutral",
  "urgent",
]);

export const plutoDeliverySchema = z.enum([
  "bubble",
  "speak",
  "summarize",
]);

export const plutoConfigSchema = z.object({
  muted: z.boolean().default(false),
  autoCommentaryEnabled: z.boolean().default(false),
  commentaryIntervalMs: z.number().int().min(10_000).max(300_000).default(30_000),
});

export const plutoMessageSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["autonomous", "remote-agent", "system"]),
  delivery: plutoDeliverySchema,
  tone: plutoToneSchema,
  title: z.string().max(120).nullable().default(null),
  text: z.string().min(1).max(8_000),
  createdAt: z.string(),
  expiresAt: z.string().nullable().default(null),
  audioAvailable: z.boolean().default(false),
});

export const plutoStateSchema = z.object({
  available: z.boolean().default(false),
  muted: z.boolean().default(false),
  autoCommentaryEnabled: z.boolean().default(false),
  commentaryIntervalMs: z.number().int().min(10_000).max(300_000).default(30_000),
  model: z.string().min(1),
  pending: z.boolean().default(false),
  lastError: z.string().nullable().default(null),
  activeMessage: plutoMessageSchema.nullable().default(null),
  history: z.array(plutoMessageSchema).default([]),
});

export const plutoVoiceSessionHostSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["local", "aryazos"]),
  label: z.string().min(1),
});

export const plutoVoiceSessionClientSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  platform: z.string().min(1).nullable().default(null),
  joinedAt: z.string(),
  lastSeenAt: z.string(),
  canSendAudio: z.boolean().default(true),
  canReceiveAudio: z.boolean().default(true),
  canObserve: z.boolean().default(true),
});

export const plutoVoiceSessionStatusSchema = z.enum([
  "idle",
  "listening",
  "responding",
  "error",
]);

export const plutoVoiceSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(120).nullable().default(null),
  host: plutoVoiceSessionHostSchema,
  status: plutoVoiceSessionStatusSchema.default("idle"),
  model: z.string().min(1),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  ownerClientId: z.string().min(1).nullable().default(null),
  speakerClientId: z.string().min(1).nullable().default(null),
  clients: z.array(plutoVoiceSessionClientSchema).default([]),
});

export const plutoVoiceSessionSummarySchema = plutoVoiceSessionSchema.pick({
  id: true,
  title: true,
  host: true,
  status: true,
  model: true,
  createdAt: true,
  lastActivityAt: true,
  ownerClientId: true,
  speakerClientId: true,
});

export const plutoVoiceSessionAttachInputSchema = z.object({
  label: z.string().min(1).max(120),
  platform: z.string().min(1).max(80).optional(),
  requestedRole: z.enum(["speaker", "observer"]).default("speaker"),
  canReceiveAudio: z.boolean().default(true),
  canObserve: z.boolean().default(true),
});

export const plutoVoiceSessionCreateInputSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  client: plutoVoiceSessionAttachInputSchema.optional(),
});

export const plutoVoiceSessionCreateOutputSchema = z.object({
  session: plutoVoiceSessionSchema,
  client: plutoVoiceSessionClientSchema.nullable().default(null),
});

export const plutoVoiceSessionListOutputSchema = z.object({
  sessions: z.array(plutoVoiceSessionSummarySchema),
});

export const plutoVoiceSessionGetOutputSchema = z.object({
  session: plutoVoiceSessionSchema,
});

export const plutoVoiceSessionAttachOutputSchema = z.object({
  session: plutoVoiceSessionSchema,
  client: plutoVoiceSessionClientSchema,
});

export const plutoVoiceSessionDetachInputSchema = z.object({
  clientId: z.string().min(1),
});

export const plutoVoiceSessionDetachOutputSchema = z.object({
  session: plutoVoiceSessionSchema,
  detachedClientId: z.string().min(1),
});

export const plutoVoiceSessionCloseOutputSchema = z.object({
  closedSessionId: z.string().min(1),
});

export const plutoVoiceSessionAudioChunkSchema = z.object({
  clientId: z.string().min(1),
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1).default("audio/pcm;rate=16000"),
});

export const plutoVoiceSessionAudioStreamEndInputSchema = z.object({
  clientId: z.string().min(1),
});

export const plutoVoiceSessionTextInputSchema = z.object({
  clientId: z.string().min(1),
  text: z.string().trim().min(1).max(4_000),
});

export const plutoVoiceSessionStreamClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("audio_chunk"),
    chunk: plutoVoiceSessionAudioChunkSchema,
  }),
  z.object({
    type: z.literal("audio_stream_end"),
    clientId: z.string().min(1),
  }),
  z.object({
    type: z.literal("text_input"),
    input: plutoVoiceSessionTextInputSchema,
  }),
  z.object({
    type: z.literal("ping"),
  }),
]);

export const plutoVoiceSessionStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session_snapshot"),
    session: plutoVoiceSessionSchema,
  }),
  z.object({
    type: z.literal("session_updated"),
    session: plutoVoiceSessionSchema,
  }),
  z.object({
    type: z.literal("input_transcription"),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("output_transcription"),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("audio_chunk"),
    audioBase64: z.string().min(1),
    mimeType: z.string().min(1),
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

export const plutoVoiceSessionEventEnvelopeSchema = z.object({
  sessionId: z.string().min(1),
  event: plutoVoiceSessionStreamEventSchema,
});

export const allowedPathSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  path: z.string().min(1),
  kind: z.enum(["projects", "manual"]),
  enabled: z.boolean().default(true),
  capabilities: capabilityFlagsSchema,
});

export const taskDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  managed: z.boolean().default(false),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000),
  outputLimitBytes: z.number().int().positive().max(256_000).default(32_000),
});

export const runCommandRuleSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
  matchMode: z.enum(["exact", "prefix"]).default("exact"),
  approvalRequired: z.boolean().default(true),
});

export const approvalPolicySchema = z.object({
  toolApprovals: z
    .object({
      health_check: z.boolean().optional(),
      list_projects: z.boolean().optional(),
      create_project: z.boolean().optional(),
      list_directory: z.boolean().optional(),
      search_files: z.boolean().optional(),
      read_file: z.boolean().optional(),
      write_file: z.boolean().optional(),
      start_dev_server: z.boolean().optional(),
      stop_dev_server: z.boolean().optional(),
      get_logs: z.boolean().optional(),
      run_repo_task: z.boolean().optional(),
      run_command: z.boolean().optional(),
      create_todo_list: z.boolean().optional(),
      update_todo_item: z.boolean().optional(),
      list_todo_items: z.boolean().optional(),
      notify_pluto: z.boolean().optional(),
    })
    .default({}),
  alwaysRequireApprovalForSensitiveTools: z.boolean().default(true),
});

export const authConfigSchema = z.object({
  adminEmail: z.string().email(),
  allowedGoogleClientIds: z.array(z.string().min(1)).default([]),
  allowedOrigins: z.array(z.string().url()).default([]),
});

export const agentCompanionConfigSchema = z.object({
  version: z.literal(1).default(1),
  projectsRoot: z.string().nullable().default(null),
  mcpAccessMode: mcpAccessModeSchema.default("default"),
  pluto: plutoConfigSchema.default({
    muted: false,
    autoCommentaryEnabled: false,
    commentaryIntervalMs: 30_000,
  }),
  allowedPaths: z.array(allowedPathSchema).default([]),
  tasks: z.array(taskDefinitionSchema).default([]),
  devServerTasks: z.array(taskDefinitionSchema).default([]),
  runCommandRules: z.array(runCommandRuleSchema).default([]),
  approvalPolicy: approvalPolicySchema.default({
    toolApprovals: {},
    alwaysRequireApprovalForSensitiveTools: true,
  }),
  auth: authConfigSchema,
});

export const userStoreSchema = z.object({
  version: z.literal(1).default(1),
  users: z.array(
    z.object({
      id: z.string().min(1),
      email: z.string().email(),
      role: z.enum(["admin"]),
      googleSubject: z.string().optional(),
    }),
  ),
});

export const healthCheckInputSchema = z.object({});
export const healthCheckOutputSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
});

export const listProjectsInputSchema = z.object({});
export const listProjectsOutputSchema = z.object({
  projectsRoot: z.string().nullable(),
  projects: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
    }),
  ),
});

export const createProjectInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9._-]+$/),
});
export const createProjectOutputSchema = z.object({
  created: z.boolean(),
  path: z.string(),
});

export const listDirectoryInputSchema = z.object({
  path: z.string().min(1),
});
export const listDirectoryOutputSchema = z.object({
  path: z.string(),
  entries: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      type: z.enum(["file", "directory"]),
    }),
  ),
});

export const searchFilesInputSchema = z.object({
  path: z.string().min(1),
  query: z.string().min(1).max(200),
  maxResults: z.number().int().positive().max(100).default(20),
});
export const searchFilesOutputSchema = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      snippet: z.string(),
    }),
  ),
});

export const readFileInputSchema = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(131_072).default(32_000),
});
export const readFileOutputSchema = z.object({
  path: z.string(),
  content: z.string(),
  truncated: z.boolean(),
});

export const writeFileInputSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(131_072),
});
export const writeFileOutputSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
});

export const startDevServerInputSchema = z.object({
  projectPath: z.string().min(1),
  taskId: z.string().min(1),
});
export const startDevServerOutputSchema = z.object({
  processId: z.string(),
  taskId: z.string(),
});

export const stopDevServerInputSchema = z.object({
  processId: z.string().min(1),
});
export const stopDevServerOutputSchema = z.object({
  processId: z.string(),
  stopped: z.boolean(),
});

export const getLogsInputSchema = z.object({
  processId: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
});
export const getLogsOutputSchema = z.object({
  entries: z.array(
    z.object({
      processId: z.string().optional(),
      timestamp: z.string(),
      level: z.enum(["info", "error"]),
      message: z.string(),
    }),
  ),
});

export const runRepoTaskInputSchema = z.object({
  projectPath: z.string().min(1),
  taskId: z.string().min(1),
});
export const runRepoTaskOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});

export const runCommandInputSchema = z.object({
  workingDirectory: z.string().min(1),
  command: z.array(z.string().min(1)).min(1),
});
export const runCommandOutputSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  approvedViaRule: z.string(),
});

export const createTodoListInputSchema = z.object({
  title: z.string().min(1).max(120),
  items: z.array(z.string().min(1).max(240)).max(25).default([]),
});
export const createTodoListOutputSchema = z.object({
  listId: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      completed: z.boolean(),
    }),
  ),
});

export const updateTodoItemInputSchema = z.object({
  listId: z.string().min(1),
  itemId: z.string().min(1),
  text: z.string().min(1).max(240).optional(),
  completed: z.boolean().optional(),
});
export const updateTodoItemOutputSchema = z.object({
  updated: z.boolean(),
});

export const listTodoItemsInputSchema = z.object({
  listId: z.string().optional(),
});
export const listTodoItemsOutputSchema = z.object({
  lists: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      items: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          completed: z.boolean(),
        }),
      ),
    }),
  ),
});

export const notifyPlutoInputSchema = z.object({
  message: z.string().min(1).max(4_000),
  context: z.string().max(20_000).optional(),
  title: z.string().max(120).optional(),
  delivery: plutoDeliverySchema.default("bubble"),
  tone: plutoToneSchema.default("encouraging"),
});

export const notifyPlutoOutputSchema = z.object({
  messageId: z.string().min(1),
  text: z.string().min(1),
  delivery: plutoDeliverySchema,
  audioAvailable: z.boolean(),
  usedFallback: z.boolean().default(false),
});

export const plutoCommentaryInputSchema = z.object({
  screenshotBase64: z.string().min(1),
  mimeType: z.string().min(1).default("image/png"),
  contextHint: z.string().max(1_000).optional(),
});

export const plutoCommentaryOutputSchema = notifyPlutoOutputSchema;

export const toolInputSchemas = {
  health_check: healthCheckInputSchema,
  list_projects: listProjectsInputSchema,
  create_project: createProjectInputSchema,
  list_directory: listDirectoryInputSchema,
  search_files: searchFilesInputSchema,
  read_file: readFileInputSchema,
  write_file: writeFileInputSchema,
  start_dev_server: startDevServerInputSchema,
  stop_dev_server: stopDevServerInputSchema,
  get_logs: getLogsInputSchema,
  run_repo_task: runRepoTaskInputSchema,
  run_command: runCommandInputSchema,
  create_todo_list: createTodoListInputSchema,
  update_todo_item: updateTodoItemInputSchema,
  list_todo_items: listTodoItemsInputSchema,
  notify_pluto: notifyPlutoInputSchema,
} as const;

export const toolOutputSchemas = {
  health_check: healthCheckOutputSchema,
  list_projects: listProjectsOutputSchema,
  create_project: createProjectOutputSchema,
  list_directory: listDirectoryOutputSchema,
  search_files: searchFilesOutputSchema,
  read_file: readFileOutputSchema,
  write_file: writeFileOutputSchema,
  start_dev_server: startDevServerOutputSchema,
  stop_dev_server: stopDevServerOutputSchema,
  get_logs: getLogsOutputSchema,
  run_repo_task: runRepoTaskOutputSchema,
  run_command: runCommandOutputSchema,
  create_todo_list: createTodoListOutputSchema,
  update_todo_item: updateTodoItemOutputSchema,
  list_todo_items: listTodoItemsOutputSchema,
  notify_pluto: notifyPlutoOutputSchema,
} as const;

export const toolResultEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
});

export const relayRequestSchema = z.object({
  requestId: z.string().min(1),
  toolName: toolNameSchema,
  payload: z.unknown(),
  actor: z.object({
    email: z.string().email(),
    subject: z.string().min(1),
  }),
});

export const relayResponseSchema = z.object({
  requestId: z.string().min(1),
  result: toolResultEnvelopeSchema,
});

export const approvalRequestSchema = z.object({
  id: z.string().min(1),
  toolName: toolNameSchema,
  actorEmail: z.string().email(),
  summary: z.string().min(1),
  payload: z.unknown(),
  createdAt: z.string(),
  status: z.enum(["pending", "approved", "denied"]),
});

export const approvalDecisionSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approved", "denied"]),
  remember: z.boolean().default(false),
});

export const activityEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string(),
  level: z.enum(["info", "warn", "error"]),
  type: z.enum([
    "auth",
    "tool_call",
    "approval",
    "pluto",
    "process",
    "file_write",
    "command",
    "error",
    "status",
  ]),
  message: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});

export const runnerStatusSchema = z.object({
  connectedToRemote: z.boolean(),
  lastSeenAt: z.string().nullable(),
  pendingApprovals: z.number().int().nonnegative(),
  runningProcesses: z.number().int().nonnegative(),
});

export type Capability = z.infer<typeof capabilityEnum>;
export type CapabilityFlags = z.infer<typeof capabilityFlagsSchema>;
export type MCPAccessMode = z.infer<typeof mcpAccessModeSchema>;
export type ToolName = z.infer<typeof toolNameSchema>;
export type PlutoTone = z.infer<typeof plutoToneSchema>;
export type PlutoDelivery = z.infer<typeof plutoDeliverySchema>;
export type PlutoConfig = z.infer<typeof plutoConfigSchema>;
export type PlutoMessage = z.infer<typeof plutoMessageSchema>;
export type PlutoState = z.infer<typeof plutoStateSchema>;
export type PlutoVoiceSessionHost = z.infer<typeof plutoVoiceSessionHostSchema>;
export type PlutoVoiceSessionClient = z.infer<typeof plutoVoiceSessionClientSchema>;
export type PlutoVoiceSessionStatus = z.infer<typeof plutoVoiceSessionStatusSchema>;
export type PlutoVoiceSession = z.infer<typeof plutoVoiceSessionSchema>;
export type PlutoVoiceSessionSummary = z.infer<typeof plutoVoiceSessionSummarySchema>;
export type AllowedPath = z.infer<typeof allowedPathSchema>;
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;
export type RunCommandRule = z.infer<typeof runCommandRuleSchema>;
export type AgentCompanionConfig = z.infer<typeof agentCompanionConfigSchema>;
export type UserStore = z.infer<typeof userStoreSchema>;
export type RelayRequest = z.infer<typeof relayRequestSchema>;
export type RelayResponse = z.infer<typeof relayResponseSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ActivityEvent = z.infer<typeof activityEventSchema>;
export type RunnerStatus = z.infer<typeof runnerStatusSchema>;
export type NotifyPlutoInput = z.infer<typeof notifyPlutoInputSchema>;
export type NotifyPlutoOutput = z.infer<typeof notifyPlutoOutputSchema>;
export type PlutoCommentaryInput = z.infer<typeof plutoCommentaryInputSchema>;
export type PlutoCommentaryOutput = z.infer<typeof plutoCommentaryOutputSchema>;
export type PlutoVoiceSessionCreateInput = z.infer<typeof plutoVoiceSessionCreateInputSchema>;
export type PlutoVoiceSessionCreateOutput = z.infer<typeof plutoVoiceSessionCreateOutputSchema>;
export type PlutoVoiceSessionListOutput = z.infer<typeof plutoVoiceSessionListOutputSchema>;
export type PlutoVoiceSessionGetOutput = z.infer<typeof plutoVoiceSessionGetOutputSchema>;
export type PlutoVoiceSessionAttachInput = z.infer<typeof plutoVoiceSessionAttachInputSchema>;
export type PlutoVoiceSessionAttachOutput = z.infer<typeof plutoVoiceSessionAttachOutputSchema>;
export type PlutoVoiceSessionDetachInput = z.infer<typeof plutoVoiceSessionDetachInputSchema>;
export type PlutoVoiceSessionDetachOutput = z.infer<typeof plutoVoiceSessionDetachOutputSchema>;
export type PlutoVoiceSessionCloseOutput = z.infer<typeof plutoVoiceSessionCloseOutputSchema>;
export type PlutoVoiceSessionAudioChunk = z.infer<typeof plutoVoiceSessionAudioChunkSchema>;
export type PlutoVoiceSessionAudioStreamEndInput = z.infer<typeof plutoVoiceSessionAudioStreamEndInputSchema>;
export type PlutoVoiceSessionTextInput = z.infer<typeof plutoVoiceSessionTextInputSchema>;
export type PlutoVoiceSessionStreamClientMessage = z.infer<typeof plutoVoiceSessionStreamClientMessageSchema>;
export type PlutoVoiceSessionStreamEvent = z.infer<typeof plutoVoiceSessionStreamEventSchema>;
export type PlutoVoiceSessionEventEnvelope = z.infer<typeof plutoVoiceSessionEventEnvelopeSchema>;
