/**
 * Pure Upstox token helpers (no database or network imports) so they can
 * be unit-tested and reused anywhere.
 */
import { IST_OFFSET_MS } from "./session";

/**
 * Upstox access tokens are day-scoped: every token expires at 03:30 IST
 * the following morning. Issued before 03:30 → expires 03:30 the same
 * day; issued after → expires 03:30 the next day.
 */
export function tokenExpiryFrom(nowMs = Date.now()): Date {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const dayOffset = minutes < 3 * 60 + 30 ? 0 : 1;
  return new Date(Date.UTC(y, m, d + dayOffset, 3, 30) - IST_OFFSET_MS);
}

/** Masked form used in every API response — the raw token never leaves the server. */
export function maskToken(token: string): string {
  if (token.length <= 10) return "••••";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

/** Constant-time-ish comparison for the optional admin passcode. */
export function comparePasscode(expected: string | undefined, supplied: string | null): boolean {
  if (!expected) return true;
  if (!supplied || supplied.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ supplied.charCodeAt(i);
  return diff === 0;
}
