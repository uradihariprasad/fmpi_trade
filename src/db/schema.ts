import { sql } from "drizzle-orm";
import {
  bigint, doublePrecision, integer, jsonb, pgTable, primaryKey, text, timestamp,
} from "drizzle-orm/pg-core";

/** Dynamic NSE/BSE F&O universe synced from the Upstox instrument master. */
export const instruments = pgTable("instruments", {
  instrumentKey: text("instrument_key").primaryKey(),
  symbol: text("symbol").notNull(),
  name: text("name").notNull(),
  exchange: text("exchange").notNull(), // NSE | BSE
  segment: text("segment").notNull(), // index | fno
  futuresKey: text("futures_key"),
  futuresExpiryTs: bigint("futures_expiry_ts", { mode: "number" }),
  lotSize: integer("lot_size"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const universeSyncs = pgTable("universe_syncs", {
  id: text("id").primaryKey(),
  syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
  source: text("source").notNull(),
});

/** Genuine exchange candles, one row per (instrument, timeframe, open-time). */
export const candles = pgTable(
  "candles",
  {
    instrumentKey: text("instrument_key").notNull(),
    timeframe: text("timeframe").notNull(), // 1m | 5m | 10m
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    volume: bigint("volume", { mode: "number" }).notNull().default(0),
    oi: bigint("oi", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.instrumentKey, t.timeframe, t.ts] })],
);

/**
 * Upstox session (singleton row, id = 'current').
 * Holds the daily access token so it survives restarts/redeploys. The raw
 * token is never returned by any API — only masked metadata.
 */
export const upstoxSessions = pgTable("upstox_sessions", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull(),
  userId: text("user_id"),
  userName: text("user_name"),
  email: text("email"),
  broker: text("broker"),
  /** Upstox tokens expire at 03:30 IST the following day */
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Write-once FMPI snapshots. ON CONFLICT DO NOTHING + engine_version in
 * the key: historical values are persisted, never repainted.
 */
export const fmpiSnapshots = pgTable(
  "fmpi_snapshots",
  {
    instrumentKey: text("instrument_key").notNull(),
    timeframe: text("timeframe").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    engineVersion: text("engine_version").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.instrumentKey, t.timeframe, t.ts, t.engineVersion] })],
);
