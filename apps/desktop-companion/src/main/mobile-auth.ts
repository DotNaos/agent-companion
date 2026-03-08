import {
    AppError,
    FileBackedStore,
    mobileAuthExchangeInputSchema,
    mobileAuthExchangeOutputSchema,
    mobileDeviceSchema,
    mobileDeviceStoreSchema,
    mobilePairingCodeCreateOutputSchema,
    type MobileDevice,
} from "@agent-companion/shared";
import { jwtVerify, SignJWT } from "jose";
import { randomBytes, randomUUID } from "node:crypto";

const encoder = new TextEncoder();
const MOBILE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
const PAIRING_TTL_MS = 5 * 60 * 1000;

interface PairingCodeRecord {
  code: string;
  expiresAt: number;
}

export class MobileAuthManager {
  private readonly store: FileBackedStore<ReturnType<typeof mobileDeviceStoreSchema.parse>>;
  private readonly pairingCodes = new Map<string, PairingCodeRecord>();

  constructor(
    private readonly secret: string,
    storePath: string,
  ) {
    this.store = new FileBackedStore(storePath, mobileDeviceStoreSchema, () => ({
      version: 1,
      devices: [],
    }));
  }

  createPairingCode() {
    const code = generatePairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairingCodes.set(code, { code, expiresAt });
    return mobilePairingCodeCreateOutputSchema.parse({
      code,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  async exchangePairingCode(input: unknown) {
    const parsed = mobileAuthExchangeInputSchema.parse(input);
    const record = this.pairingCodes.get(parsed.code);
    if (!record || record.expiresAt <= Date.now()) {
      this.pairingCodes.delete(parsed.code);
      throw new AppError("INVALID_MOBILE_PAIRING_CODE", "The mobile pairing code is invalid or expired", 401);
    }
    this.pairingCodes.delete(parsed.code);

    const device = this.upsertDevice(parsed.device.label, parsed.device.platform ?? null);
    const expiresAt = new Date(Date.now() + MOBILE_TOKEN_TTL_SECONDS * 1000).toISOString();
    const accessToken = await new SignJWT({
      deviceId: device.id,
      label: device.label,
      platform: device.platform,
      type: "mobile-access",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(`${MOBILE_TOKEN_TTL_SECONDS}s`)
      .sign(encoder.encode(this.secret));

    return mobileAuthExchangeOutputSchema.parse({
      accessToken,
      expiresAt,
      device,
    });
  }

  async verifyAccessToken(token: string) {
    if (!token) {
      throw new AppError("UNAUTHORIZED", "Mobile authentication required", 401);
    }

    const { payload } = await jwtVerify(token, encoder.encode(this.secret));
    if (payload.type !== "mobile-access") {
      throw new AppError("UNAUTHORIZED", "Mobile access token is invalid", 401);
    }
    const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : null;
    if (!deviceId) {
      throw new AppError("UNAUTHORIZED", "Mobile access token is invalid", 401);
    }

    const device = this.store.read().devices.find((entry) => entry.id === deviceId && !entry.revokedAt);
    if (!device) {
      throw new AppError("UNAUTHORIZED", "Mobile device is not registered", 401);
    }

    return this.touchDevice(deviceId);
  }

  private upsertDevice(label: string, platform: string | null) {
    const now = new Date().toISOString();
    let nextDevice: MobileDevice | null = null;
    this.store.update((current) => {
      const existing = current.devices.find((entry) => entry.label === label && entry.platform === platform && !entry.revokedAt);
      if (existing) {
        existing.lastSeenAt = now;
        nextDevice = mobileDeviceSchema.parse(existing);
        return current;
      }
      const created = mobileDeviceSchema.parse({
        id: randomUUID(),
        label,
        platform,
        createdAt: now,
        lastSeenAt: now,
        revokedAt: null,
      });
      current.devices.push(created);
      nextDevice = created;
      return current;
    });
    return nextDevice!;
  }

  private touchDevice(deviceId: string): MobileDevice {
    let touched: MobileDevice | null = null;
    this.store.update((current) => {
      const device = current.devices.find((entry) => entry.id === deviceId && !entry.revokedAt);
      if (!device) {
        throw new AppError("UNAUTHORIZED", "Mobile device is not registered", 401);
      }
      device.lastSeenAt = new Date().toISOString();
      touched = mobileDeviceSchema.parse(device);
      return current;
    });
    return touched!;
  }
}

export function resolveMobileAccessToken(request: {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
}) {
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const queryToken = request.query?.accessToken;
  return typeof queryToken === "string" ? queryToken : "";
}

function generatePairingCode() {
  return randomBytes(4).toString("hex").toUpperCase();
}
