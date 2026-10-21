/**
 * Idempotent schema bootstrap.
 *
 * Keeps deployment to any host (Render, Fly, Docker, bare node) a single
 * step: the app creates its own tables on first database use instead of
 * requiring a separate migration command. Statements mirror
 * `src/db/schema.ts` exactly and are all `IF NOT EXISTS`, so running them
 * against an already-migrated database is a no-op.
 */
import { sql } from "drizzle-orm";
import { db } from "./index";
import { canTryDatabase, databaseStatus, markDbFailure, markDbSuccess } from "./status";

let started: Promise<void> | null = null;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS instruments (
     instrument_key    text PRIMARY KEY,
     symbol            text NOT NULL,
     name              text NOT NULL,
     exchange          text NOT NULL,
     segment           text NOT NULL,
     futures_key       text,
     futures_expiry_ts bigint,
     lot_size          integer,
     updated_at        timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS universe_syncs (
     id        text PRIMARY KEY,
     synced_at timestamptz NOT NULL,
     count     integer NOT NULL,
     source    text NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS candles (
     instrument_key text NOT NULL,
     timeframe      text NOT NULL,
     ts             timestamptz NOT NULL,
     open           double precision NOT NULL,
     high           double precision NOT NULL,
     low            double precision NOT NULL,
     close          double precision NOT NULL,
     volume         bigint NOT NULL DEFAULT 0,
     oi             bigint,
     CONSTRAINT candles_pk PRIMARY KEY (instrument_key, timeframe, ts)
   )`,
  `CREATE TABLE IF NOT EXISTS fmpi_snapshots (
     instrument_key text NOT NULL,
     timeframe      text NOT NULL,
     ts             timestamptz NOT NULL,
     engine_version text NOT NULL,
     payload        jsonb NOT NULL,
     created_at     timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT fmpi_snapshots_pk PRIMARY KEY (instrument_key, timeframe, ts, engine_version)
   )`,
  `CREATE TABLE IF NOT EXISTS upstox_sessions (
     id           text PRIMARY KEY,
     access_token text NOT NULL,
     user_id      text,
     user_name    text,
     email        text,
     broker       text,
     expires_at   timestamptz NOT NULL,
     created_at   timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS instruments_symbol_idx ON instruments (symbol)`,
  `CREATE INDEX IF NOT EXISTS universe_syncs_at_idx ON universe_syncs (synced_at DESC)`,
];

export function ensureSchema(): Promise<void> {
  if (!canTryDatabase()) {
    const detail = databaseStatus().lastError ?? "connection circuit is cooling down";
    return Promise.reject(new Error(`PostgreSQL temporarily unavailable: ${detail}`));
  }
  started ??= (async () => {
    try {
      for (const stmt of STATEMENTS) {
        await db.execute(sql.raw(stmt));
      }
      markDbSuccess();
    } catch (e) {
      started = null; // allow a later retry rather than wedging the process
      markDbFailure(e);
      console.error("[db] schema bootstrap failed:", databaseStatus().lastError);
      throw e;
    }
  })();
  return started;
}

/** Forget the memoized bootstrap so the next call re-runs the DDL. */
export function resetSchemaCache(): void {
  started = null;
}

/** Postgres undefined_table. */
function isMissingRelation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string }; message?: string };
  return (
    err?.code === "42P01" ||
    err?.cause?.code === "42P01" ||
    /relation .* does not exist/i.test(err?.message ?? "")
  );
}

/**
 * Runs a query, and if the database turns out to be missing its tables
 * (fresh volume, restored/blank database, manual drop) re-applies the
 * bootstrap once and retries. Keeps a cold deploy self-healing without
 * masking genuine query errors.
 */
export async function withSchema<T>(fn: () => Promise<T>): Promise<T> {
  await ensureSchema();
  try {
    const value = await fn();
    markDbSuccess();
    return value;
  } catch (e) {
    if (isMissingRelation(e)) {
      console.warn("[db] missing relation detected — re-applying schema bootstrap");
      resetSchemaCache();
      await ensureSchema();
      try {
        const value = await fn();
        markDbSuccess();
        return value;
      } catch (retryError) {
        markDbFailure(retryError);
        throw retryError;
      }
    }
    markDbFailure(e);
    throw e;
  }
}
