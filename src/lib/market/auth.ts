/**
 * Upstox session management.
 *
 * Upstox access tokens are day-scoped: every token expires at 03:30 IST
 * the following morning, so the operator re-authenticates each trading
 * day. The token is validated against the live Upstox profile endpoint
 * before it is accepted, persisted in Postgres (surviving restarts and
 * redeploys) and cached in-process.
 *
 * The raw token never leaves the server — status responses carry only
 * masked metadata.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { withSchema } from "@/db/bootstrap";
import { upstoxSessions } from "@/db/schema";
import { comparePasscode, maskToken, tokenExpiryFrom } from "./token";

export { maskToken, tokenExpiryFrom };

const ROW_ID = "current";
const PROFILE_URL = "https://api.upstox.com/v2/user/profile";

export interface SessionStatus {
  authenticated: boolean;
  source: "database" | "environment" | "none";
  userName?: string | null;
  email?: string | null;
  userId?: string | null;
  broker?: string | null;
  tokenMask?: string;
  expiresAt?: string;
  expiresInMinutes?: number;
  /** true when a stored token exists but has passed its 03:30 IST expiry */
  expired?: boolean;
  passcodeRequired: boolean;
  message: string;
}

export interface UpstoxProfile {
  userId: string | null;
  userName: string | null;
  email: string | null;
  broker: string | null;
}

/** Verifies a token against the live Upstox profile endpoint. */
export async function verifyToken(token: string): Promise<UpstoxProfile> {
  const res = await fetch(PROFILE_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Upstox rejected this access token (401). Generate a fresh token and try again.");
  }
  if (!res.ok) {
    throw new Error(`Upstox profile check failed with HTTP ${res.status}. Token not saved.`);
  }
  const json = (await res.json()) as {
    status?: string;
    data?: { user_id?: string; user_name?: string; email?: string; broker?: string };
  };
  if (json.status !== "success" || !json.data) {
    throw new Error("Unexpected Upstox profile response. Token not saved.");
  }
  return {
    userId: json.data.user_id ?? null,
    userName: json.data.user_name ?? null,
    email: json.data.email ?? null,
    broker: json.data.broker ?? null,
  };
}

/* ------------------------------------------------------------------ */

interface CachedSession {
  token: string;
  expiresAt: number;
  profile: UpstoxProfile;
}
let cache: CachedSession | null = null;
let cacheReadAt = 0;
const CACHE_TTL = 30_000;

async function readRow() {
  const rows = await withSchema(() =>
    db.select().from(upstoxSessions).where(eq(upstoxSessions.id, ROW_ID)).limit(1),
  );
  return rows[0] ?? null;
}

/** Saves a verified token, replacing any previous session. */
export async function saveToken(token: string): Promise<SessionStatus> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Access token is empty.");
  const profile = await verifyToken(trimmed);
  const expiresAt = tokenExpiryFrom();
  await withSchema(async () => {
    await db
      .insert(upstoxSessions)
      .values({
        id: ROW_ID,
        accessToken: trimmed,
        userId: profile.userId,
        userName: profile.userName,
        email: profile.email,
        broker: profile.broker,
        expiresAt,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: upstoxSessions.id,
        set: {
          accessToken: trimmed,
          userId: profile.userId,
          userName: profile.userName,
          email: profile.email,
          broker: profile.broker,
          expiresAt,
          createdAt: new Date(),
        },
      });
  });
  cache = { token: trimmed, expiresAt: expiresAt.getTime(), profile };
  cacheReadAt = Date.now();
  return getStatus();
}

export async function clearToken(): Promise<void> {
  await withSchema(() => db.delete(upstoxSessions).where(eq(upstoxSessions.id, ROW_ID)));
  cache = null;
  cacheReadAt = 0;
}

/**
 * The token used by authenticated data calls.
 * Returns null when no valid, unexpired token exists — callers must then
 * degrade honestly (component reported MISSING) rather than guess.
 */
export async function getActiveToken(): Promise<string | null> {
  const now = Date.now();
  if (cache && now - cacheReadAt < CACHE_TTL) {
    return cache.expiresAt > now ? cache.token : null;
  }
  try {
    const row = await readRow();
    cacheReadAt = now;
    if (row) {
      cache = {
        token: row.accessToken,
        expiresAt: row.expiresAt.getTime(),
        profile: {
          userId: row.userId, userName: row.userName,
          email: row.email, broker: row.broker,
        },
      };
      if (cache.expiresAt > now) return cache.token;
      return null;
    }
    cache = null;
  } catch {
    /* database unavailable — fall through to env */
  }
  const envToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  return envToken ? envToken : null;
}

export function passcodeRequired(): boolean {
  return Boolean(process.env.FMPI_ADMIN_PASSCODE);
}

/** Constant-ish time comparison for the optional admin passcode. */
export function passcodeValid(supplied: string | null): boolean {
  return comparePasscode(process.env.FMPI_ADMIN_PASSCODE, supplied);
}

export async function getStatus(): Promise<SessionStatus> {
  const now = Date.now();
  const base = { passcodeRequired: passcodeRequired() };
  let row: Awaited<ReturnType<typeof readRow>> | null = null;
  try {
    row = await readRow();
  } catch {
    /* ignore — report env fallback below */
  }
  if (row) {
    const expMs = row.expiresAt.getTime();
    const expired = expMs <= now;
    return {
      ...base,
      authenticated: !expired,
      source: "database",
      userName: row.userName,
      email: row.email,
      userId: row.userId,
      broker: row.broker,
      tokenMask: maskToken(row.accessToken),
      expiresAt: row.expiresAt.toISOString(),
      expiresInMinutes: Math.max(0, Math.round((expMs - now) / 60000)),
      expired,
      message: expired
        ? "Session expired at 03:30 IST — paste today's access token to re-enable authenticated data."
        : "Authenticated with Upstox. Options positioning is active.",
    };
  }
  const envToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (envToken) {
    return {
      ...base,
      authenticated: true,
      source: "environment",
      tokenMask: maskToken(envToken),
      message: "Using UPSTOX_ACCESS_TOKEN from the environment. Sign in here to override it for today.",
    };
  }
  return {
    ...base,
    authenticated: false,
    source: "none",
    message:
      "Not signed in. Candles, futures OI and the instrument master work without a token; Options positioning stays MISSING until you sign in.",
  };
}
