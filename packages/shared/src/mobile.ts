import { z } from "zod";
import { plutoMessageSchema, plutoStateSchema, plutoVoiceSessionSummarySchema, runnerStatusSchema } from "./schemas.js";

export const mobileDeviceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(120),
  platform: z.string().min(1).max(80).nullable().default(null),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  revokedAt: z.string().nullable().default(null),
});

export const mobileDeviceStoreSchema = z.object({
  version: z.literal(1).default(1),
  devices: z.array(mobileDeviceSchema).default([]),
});

export const mobilePairingCodeCreateOutputSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.string(),
});

export const mobileAuthExchangeInputSchema = z.object({
  code: z.string().trim().min(1).max(64),
  device: z.object({
    label: z.string().trim().min(1).max(120),
    platform: z.string().trim().min(1).max(80).optional(),
  }),
});

export const mobileAuthExchangeOutputSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string(),
  device: mobileDeviceSchema,
});

export const mobilePlutoHistoryOutputSchema = z.object({
  history: z.array(plutoMessageSchema),
});

export const mobileBootstrapOutputSchema = z.object({
  runner: runnerStatusSchema,
  pluto: plutoStateSchema,
  plutoVoiceSessions: z.array(plutoVoiceSessionSummarySchema),
  desktop: z.object({
    runnerRunning: z.boolean(),
    tunnelRunning: z.boolean(),
    publicAdminUrl: z.string().nullable(),
    publicMcpUrl: z.string().nullable(),
  }),
});

export type MobileDevice = z.infer<typeof mobileDeviceSchema>;
export type MobileDeviceStore = z.infer<typeof mobileDeviceStoreSchema>;
export type MobilePairingCodeCreateOutput = z.infer<typeof mobilePairingCodeCreateOutputSchema>;
export type MobileAuthExchangeInput = z.infer<typeof mobileAuthExchangeInputSchema>;
export type MobileAuthExchangeOutput = z.infer<typeof mobileAuthExchangeOutputSchema>;
export type MobilePlutoHistoryOutput = z.infer<typeof mobilePlutoHistoryOutputSchema>;
export type MobileBootstrapOutput = z.infer<typeof mobileBootstrapOutputSchema>;
