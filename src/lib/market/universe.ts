/**
 * Universe service — current NSE F&O underlyings + key indices.
 *
 * Source of truth: genuine Upstox instrument master.
 * Persistence: PostgreSQL when available, bounded in-memory cache otherwise.
 * A Render database connection problem must never block live market data.
 */
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { withSchema } from "@/db/bootstrap";
import { canTryDatabase, describeDbError, markDbFailure } from "@/db/status";
import { instruments, universeSyncs } from "@/db/schema";
import type { InstrumentMeta } from "@/lib/fmpi/types";
import { buildUniverse } from "./upstox";

const STALE_MS = 20 * 3_600_000;
let inflight: Promise<number> | null = null;
let memory: { at: number; instruments: InstrumentMeta[] } | null = null;
let warnedAt = 0;

function warnDb(context: string, error: unknown): void {
  markDbFailure(error);
  // Structured, rate-limited log: useful in Render Logs, no credentials.
  if (Date.now() - warnedAt > 30_000) {
    console.warn(`[universe] PostgreSQL ${context} failed; using live Upstox master: ${describeDbError(error)}`);
    warnedAt = Date.now();
  }
}

function fromRows(rows: (typeof instruments.$inferSelect)[]): InstrumentMeta[] {
  return rows
    .map((r) => ({
      instrumentKey: r.instrumentKey,
      symbol: r.symbol,
      name: r.name,
      exchange: r.exchange as "NSE" | "BSE",
      segment: r.segment as "index" | "fno",
      futuresKey: r.futuresKey,
      futuresExpiryTs: r.futuresExpiryTs,
      lotSize: r.lotSize,
    }))
    .sort((a, b) =>
      a.segment !== b.segment
        ? a.segment === "index" ? -1 : 1
        : a.symbol.localeCompare(b.symbol),
    );
}

async function persistUniverse(items: InstrumentMeta[], syncedAt: Date): Promise<void> {
  if (!canTryDatabase()) return;
  try {
    await withSchema(() =>
      db.transaction(async (tx) => {
        await tx.delete(instruments);
        if (items.length > 0) {
          await tx.insert(instruments).values(
            items.map((m) => ({
              instrumentKey: m.instrumentKey,
              symbol: m.symbol,
              name: m.name,
              exchange: m.exchange,
              segment: m.segment,
              futuresKey: m.futuresKey ?? null,
              futuresExpiryTs: m.futuresExpiryTs ?? null,
              lotSize: m.lotSize ?? null,
              updatedAt: syncedAt,
            })),
          );
        }
        await tx.insert(universeSyncs).values({
          id: `sync-${syncedAt.getTime()}`,
          syncedAt,
          count: items.length,
          source: "upstox-instrument-master",
        });
      }),
    );
  } catch (e) {
    warnDb("write", e);
  }
}

/** Force a genuine master refresh; persistence is best-effort. */
export async function syncUniverse(): Promise<number> {
  inflight ??= (async () => {
    try {
      const uni = await buildUniverse();
      memory = { at: Date.now(), instruments: uni.instruments };
      await persistUniverse(uni.instruments, new Date(uni.syncedAt));
      return uni.instruments.length;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function readPersisted(): Promise<{ rows: InstrumentMeta[]; age: number } | null> {
  if (!canTryDatabase()) return null;
  try {
    const [dbRows, syncRows] = await withSchema(async () =>
      Promise.all([
        db.select().from(instruments),
        db.select().from(universeSyncs).orderBy(desc(universeSyncs.syncedAt)).limit(1),
      ]),
    );
    return {
      rows: fromRows(dbRows),
      age: syncRows.length ? Date.now() - syncRows[0].syncedAt.getTime() : Infinity,
    };
  } catch (e) {
    warnDb("read", e);
    return null;
  }
}

export async function getUniverse(): Promise<InstrumentMeta[]> {
  // Fast path (also powers DB-degraded Render deployments).
  if (memory && Date.now() - memory.at < STALE_MS && memory.instruments.length > 0) {
    return memory.instruments;
  }

  const persisted = await readPersisted();
  if (persisted && persisted.rows.length > 0) {
    memory = { at: Date.now() - Math.min(persisted.age, STALE_MS), instruments: persisted.rows };
    if (persisted.age <= STALE_MS) return persisted.rows;
  }

  // DB empty/stale/unavailable: source directly from Upstox. If Upstox has
  // a transient issue but DB had stale rows, serve those rather than none.
  try {
    await syncUniverse();
    return memory?.instruments ?? persisted?.rows ?? [];
  } catch (e) {
    if (persisted?.rows.length) {
      console.warn(`[universe] Upstox master refresh failed; serving stale DB universe: ${(e as Error).message}`);
      return persisted.rows;
    }
    throw e;
  }
}

export async function getInstrument(symbolOrKey: string): Promise<InstrumentMeta | null> {
  const uni = await getUniverse();
  const s = symbolOrKey.toUpperCase();
  return uni.find((m) => m.symbol.toUpperCase() === s || m.instrumentKey === symbolOrKey) ?? null;
}

/** Resolved from the same in-memory/dynamic universe; no extra DB dependency. */
export async function getFuturesMeta(keys: string[]): Promise<Map<string, InstrumentMeta>> {
  const wanted = new Set(keys);
  const uni = await getUniverse();
  const map = new Map<string, InstrumentMeta>();
  for (const m of uni) if (m.futuresKey && wanted.has(m.futuresKey)) map.set(m.futuresKey, m);
  return map;
}
