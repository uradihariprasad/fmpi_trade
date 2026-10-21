import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

const databaseUrl = process.env.DATABASE_URL;
// Do not crash a manually-created Render service that forgot to attach its
// database. Queries fail fast against a closed local port and the genuine
// direct-Upstox fallback stays operational; /api/health explains the fix.
const effectiveDatabaseUrl =
  databaseUrl ?? "postgresql://unconfigured:unconfigured@127.0.0.1:1/unconfigured";

/**
 * PostgreSQL TLS selection.
 *
 * Render Blueprint's `fromDatabase.connectionString` is an INTERNAL URL.
 * Its host is typically `dpg-…-a` (no public domain) and TLS is optional;
 * forcing SSL there can fail. External Render hosts end in
 * `-postgres.render.com` and require TLS. Explicit `sslmode` or
 * `DATABASE_SSL` always wins.
 */
export function databaseSslMode(url: string): false | { rejectUnauthorized: false } {
  const override = process.env.DATABASE_SSL?.toLowerCase();
  if (override === "false" || override === "0" || override === "disable") return false;
  if (override === "true" || override === "1" || override === "require") {
    return { rejectUnauthorized: false };
  }
  if (/[?&]sslmode=disable(?:&|$)/i.test(url)) return false;
  if (/[?&]sslmode=(require|verify-ca|verify-full)(?:&|$)/i.test(url)) {
    return { rejectUnauthorized: false };
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
    const renderInternal =
      /^dpg-[a-z0-9-]+$/i.test(host) ||
      host.endsWith(".render-internal.com") ||
      host.endsWith(".internal");
    if (local || renderInternal) return false;
    // Render external connections always require encryption.
    if (host.endsWith("-postgres.render.com") || host.includes("-postgres.render.com")) {
      return { rejectUnauthorized: false };
    }
    // For other managed/public providers, TLS is the safer default.
    return { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

export function databaseConnectionInfo(url: string) {
  try {
    const parsed = new URL(url);
    const ssl = databaseSslMode(url);
    return {
      configured: true,
      host: parsed.hostname,
      port: parsed.port || "5432",
      database: parsed.pathname.replace(/^\//, "") || null,
      ssl: Boolean(ssl),
      renderInternal: /^dpg-[a-z0-9-]+$/i.test(parsed.hostname) || parsed.hostname.endsWith(".render-internal.com"),
    };
  } catch {
    return { configured: true, host: "invalid-url", port: null, database: null, ssl: false, renderInternal: false };
  }
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

const config: PoolConfig = {
  connectionString: effectiveDatabaseUrl,
  ssl: databaseSslMode(effectiveDatabaseUrl),
  max: Number(process.env.PGPOOL_MAX ?? 5),
  idleTimeoutMillis: 30_000,
  // Fail fast so the direct-Upstox fallback activates quickly on Render.
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? (databaseUrl ? 5_000 : 750)),
  keepAlive: true,
};

export const pool = globalForDb.__arenaNextJsPostgresqlPool ?? new Pool(config);

// Prevent an idle-client network error from crashing the Node process.
pool.on("error", (error) => {
  const e = error as Error & { code?: string };
  console.error("[db] idle pool error:", e.code ?? e.name, e.message);
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
