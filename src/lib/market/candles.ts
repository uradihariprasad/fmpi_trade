/**
 * Genuine candle acquisition with optional PostgreSQL persistence.
 *
 * Native 5m/10m candles are always sourced from Upstox on their own grids.
 * PostgreSQL is a reusable cache only: when Render Postgres is unavailable,
 * reads/writes are skipped after one fast failure and the genuine network
 * candles continue through the FMPI engine.
 */
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { withSchema } from "@/db/bootstrap";
import { canTryDatabase, describeDbError, markDbFailure } from "@/db/status";
import { candles as candlesTable } from "@/db/schema";
import type { Candle, InstrumentMeta, Timeframe } from "@/lib/fmpi/types";
import { TIMEFRAME_MINUTES } from "@/lib/fmpi/types";
import { fetchIntraday1m, fetchV3Candles, fetchV3Intraday } from "./upstox";
import { gridpointMs, istDateStr, marketPhase, recentSessionCandidates } from "./session";

export type CandleTimeframe = Timeframe | "1m";
let warnedAt = 0;

function warnDb(context: string, error: unknown): void {
  markDbFailure(error);
  if (Date.now() - warnedAt > 30_000) {
    console.warn(`[candles] PostgreSQL ${context} failed; using direct Upstox candles: ${describeDbError(error)}`);
    warnedAt = Date.now();
  }
}

async function readDay(key: string, tf: CandleTimeframe, istDate: string): Promise<Candle[]> {
  const dayStart = gridpointMs(istDate, 0);
  const dayEnd = dayStart + 24 * 3_600_000;
  const rows = await withSchema(() =>
    db
      .select()
      .from(candlesTable)
      .where(
        and(
          eq(candlesTable.instrumentKey, key),
          eq(candlesTable.timeframe, tf),
          gte(candlesTable.ts, new Date(dayStart)),
          lt(candlesTable.ts, new Date(dayEnd)),
        ),
      )
      .orderBy(asc(candlesTable.ts)),
  );
  return rows.map((r) => ({
    ts: r.ts.getTime(), open: r.open, high: r.high, low: r.low, close: r.close,
    volume: Number(r.volume), oi: r.oi === null ? null : Number(r.oi),
  }));
}

async function writeDay(key: string, tf: CandleTimeframe, rows: Candle[]): Promise<void> {
  if (rows.length === 0 || !canTryDatabase()) return;
  const values = rows.map((c) => ({
    instrumentKey: key, timeframe: tf, ts: new Date(c.ts),
    open: c.open, high: c.high, low: c.low, close: c.close,
    volume: Math.round(c.volume), oi: c.oi == null ? null : Math.round(c.oi),
  }));
  await withSchema(() => db.insert(candlesTable).values(values).onConflictDoNothing());
}

/**
 * Ensures at least `wantSessions` data-bearing sessions. One DB failure
 * disables persistence for the rest of this request, avoiding N repeated
 * Render connection timeouts. Missing Upstox sessions/holidays remain empty.
 */
export async function ensureSessions(
  key: string, tf: CandleTimeframe, wantSessions: number, nowMs = Date.now(),
): Promise<{ candles: Candle[]; sessions: string[] }> {
  const candidates = recentSessionCandidates(wantSessions + 12, nowMs);
  const today = istDateStr(nowMs);
  const got: { date: string; rows: Candle[] }[] = [];
  let useDb = canTryDatabase();

  for (const date of candidates) {
    if (got.length >= wantSessions) break;
    const interval = tf === "1m" ? 1 : TIMEFRAME_MINUTES[tf];
    let rows: Candle[] = [];

    // The running session is absent from the historical endpoint, so the
    // current day must come from the intraday feed and is never cached
    // (its trailing bucket is still forming).
    if (date === today) {
      try {
        rows = (await fetchV3Intraday(key, "minutes", interval)).filter(
          (c) => istDateStr(c.ts) === today,
        );
      } catch {
        rows = [];
      }
      if (rows.length > 0) got.push({ date, rows });
      continue;
    }

    if (useDb) {
      try {
        rows = await readDay(key, tf, date);
      } catch (e) {
        warnDb("read", e);
        useDb = false;
      }
    }

    if (rows.length === 0) {
      try {
        rows = await fetchV3Candles(key, "minutes", interval, date, date);
      } catch {
        continue; // provider hiccup/holiday: never invent a candle
      }

      // IMPORTANT: persistence failure must not discard valid fetched rows.
      if (rows.length > 0 && useDb) {
        try {
          await writeDay(key, tf, rows);
        } catch (e) {
          warnDb("write", e);
          useDb = false;
        }
      }
    }
    if (rows.length > 0) got.push({ date, rows });
  }

  got.sort((a, b) => a.date.localeCompare(b.date));
  return {
    candles: got.flatMap((g) => g.rows).sort((a, b) => a.ts - b.ts),
    sessions: got.map((g) => g.date),
  };
}

/**
 * Appends today's 1-minute-derived buckets when the market is open / same
 * day. Only the final, still-forming bucket is marked provisional.
 */
export async function mergeLive(
  key: string, tf: Timeframe, hist: Candle[], nowMs = Date.now(),
): Promise<{ merged: Candle[]; provisionalCount: number }> {
  const phase = marketPhase(nowMs);
  if (phase !== "open" && phase !== "post_close") return { merged: hist, provisionalCount: 0 };
  const today = istDateStr(nowMs);
  let oneMin: Candle[];
  try {
    oneMin = await fetchIntraday1m(key);
  } catch {
    return { merged: hist, provisionalCount: 0 };
  }
  oneMin = oneMin.filter((c) => istDateStr(c.ts) === today);
  if (oneMin.length === 0) return { merged: hist, provisionalCount: 0 };

  const tfm = TIMEFRAME_MINUTES[tf] * 60_000;
  const anchor = gridpointMs(today, 555); // 09:15 IST
  const bucket = new Map<number, Candle>();
  for (const c of oneMin) {
    const idx = Math.floor((c.ts - anchor) / tfm);
    const open = anchor + idx * tfm;
    const cur = bucket.get(open);
    if (!cur) bucket.set(open, { ...c, ts: open });
    else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume; // independent 1m interval volume — sum is correct
    }
  }
  const todayBuckets = [...bucket.values()].sort((a, b) => a.ts - b.ts);
  if (todayBuckets.length === 0) return { merged: hist, provisionalCount: 0 };

  const histCut = hist.filter((c) => istDateStr(c.ts) !== today);
  const mergedAll = [...histCut, ...todayBuckets];
  const lastBucketOpen = todayBuckets[todayBuckets.length - 1].ts;
  const durMs = Math.min(tfm, gridpointMs(today, 930) - lastBucketOpen);
  const provisionalCount = nowMs < lastBucketOpen + durMs ? 1 : 0;
  return { merged: mergedAll, provisionalCount };
}

/** Futures frame aligned on spot timestamps for the OI component. */
export async function futuresFrameFor(
  meta: InstrumentMeta, tf: Timeframe, sessions: number, nowMs = Date.now(),
): Promise<{ byTs: Map<number, Candle>; spotTs: Set<number> } | null> {
  if (!meta.futuresKey) return null;
  try {
    const { candles } = await ensureSessions(meta.futuresKey, tf, sessions, nowMs);
    if (candles.length === 0) return null;
    return { byTs: new Map(candles.map((c) => [c.ts, c])), spotTs: new Set(candles.map((c) => c.ts)) };
  } catch {
    return null;
  }
}
