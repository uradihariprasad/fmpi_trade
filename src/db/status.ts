/**
 * Small database circuit breaker shared by persistence services.
 *
 * PostgreSQL is a cache/audit/session store for FMPI, not the market-data
 * source. If a managed DB is sleeping, misconfigured or temporarily down,
 * chart requests must fall back to genuine Upstox data instead of failing.
 */

interface DbState {
  healthy: boolean | null;
  retryAfter: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

const state: DbState = {
  healthy: null,
  retryAfter: 0,
  lastError: null,
  lastSuccessAt: null,
  lastFailureAt: null,
};

const CIRCUIT_MS = 30_000;

/** Safe diagnostics: includes error codes/messages but never connection URLs. */
export function describeDbError(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; depth < 4 && cur && !seen.has(cur); depth++) {
    seen.add(cur);
    const e = cur as { name?: string; code?: string; message?: string; cause?: unknown };
    const message = (e.message ?? String(cur))
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://<redacted>")
      .replace(/password=[^\s]+/gi, "password=<redacted>");
    const label = [e.code, message].filter(Boolean).join(": ");
    if (label && !parts.includes(label)) parts.push(label);
    cur = e.cause;
  }
  return parts.join(" → ") || "unknown database error";
}

export function markDbSuccess(): void {
  state.healthy = true;
  state.retryAfter = 0;
  state.lastError = null;
  state.lastSuccessAt = new Date().toISOString();
}

export function markDbFailure(error: unknown): void {
  state.healthy = false;
  state.retryAfter = Date.now() + CIRCUIT_MS;
  state.lastError = describeDbError(error);
  state.lastFailureAt = new Date().toISOString();
}

/** False during the short cooldown following a connection failure. */
export function canTryDatabase(): boolean {
  return state.healthy !== false || Date.now() >= state.retryAfter;
}

export function databaseStatus() {
  return {
    healthy: state.healthy,
    circuitOpen: !canTryDatabase(),
    retryAt: state.retryAfter ? new Date(state.retryAfter).toISOString() : null,
    lastError: state.lastError,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
  };
}
