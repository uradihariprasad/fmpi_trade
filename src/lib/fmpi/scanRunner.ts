/**
 * Background universe scanner.
 *
 * Fills progressively: each instrument's row is published the moment its
 * own FMPI is computed, so the UI can rank partial-but-genuine coverage
 * instead of blocking for the whole universe. Nothing is extrapolated —
 * instruments not yet scanned simply do not appear.
 */
import { getUniverse } from "@/lib/market/universe";
import { scanInstrument } from "./service";
import type { ScanRow, Timeframe } from "./types";

export interface ScanState {
  status: "idle" | "building" | "ready";
  rows: ScanRow[];
  startedAt: number;
  finishedAt: number | null;
  progress: { done: number; total: number };
}

const globalScanner = globalThis as typeof globalThis & {
  __fmpiScanStates?: Record<Timeframe, ScanState>;
};

/** One scanner per Node process, even when Next bundles route handlers separately. */
const states: Record<Timeframe, ScanState> =
  globalScanner.__fmpiScanStates ?? {
    "5m": { status: "idle", rows: [], startedAt: 0, finishedAt: null, progress: { done: 0, total: 0 } },
    "10m": { status: "idle", rows: [], startedAt: 0, finishedAt: null, progress: { done: 0, total: 0 } },
  };
globalScanner.__fmpiScanStates = states;

const REFRESH_MS = 5 * 60_000;
const CONCURRENCY = 3;
const PACE_MS = 100;

export function getScanState(tf: Timeframe): ScanState {
  return states[tf];
}

export function ensureScan(tf: Timeframe): ScanState {
  const s = states[tf];
  const stale = s.finishedAt === null || Date.now() - s.finishedAt > REFRESH_MS;
  if (s.status !== "building" && stale) void runScan(tf);
  return s;
}

async function runScan(tf: Timeframe): Promise<void> {
  const s = states[tf];
  if (s.status === "building") return;
  s.status = "building";
  s.startedAt = Date.now();
  s.progress = { done: 0, total: 0 };
  try {
    const uni = await getUniverse();
    s.progress = { done: 0, total: uni.length };
    const fresh: ScanRow[] = [];
    let idx = 0;
    const worker = async () => {
      while (idx < uni.length) {
        const meta = uni[idx++];
        const row = await scanInstrument(meta, tf);
        fresh.push(row);
        s.progress = { done: fresh.length, total: uni.length };
        // publish a new array reference so readers always see a stable snapshot
        s.rows = [...fresh].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
        await new Promise((r) => setTimeout(r, PACE_MS));
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uni.length) }, worker));
    s.status = "ready";
    s.finishedAt = Date.now();
  } catch (e) {
    console.error(`[fmpi] scan ${tf} failed:`, (e as Error).message);
    s.status = s.rows.length ? "ready" : "idle";
    s.finishedAt = s.rows.length ? Date.now() : null;
  }
}

/* ------------------------------------------------------------------ */

export interface MoverRow extends ScanRow {
  rank: number;
}

export interface TopMovers {
  timeframe: Timeframe;
  status: ScanState["status"];
  progress: { done: number; total: number };
  /** instruments whose FMPI shows the strongest positive (buying) pressure */
  buying: MoverRow[];
  /** instruments whose FMPI shows the strongest negative (selling) pressure */
  selling: MoverRow[];
  /** equities that produced a usable reading — the honest ranking base */
  eligible: number;
  scannedAt: string | null;
  disclaimer: string;
}

/**
 * Ranks F&O **stocks** (indices excluded) by their own FMPI reading.
 *
 * Eligibility is deliberately strict: a row must carry a genuine value
 * with `valid` or `partial` quality. Warming-up / unavailable instruments
 * are never ranked. Buying leaders must sit above the 50 midpoint and
 * selling leaders below it, so a thin market simply yields a shorter list
 * rather than a padded one.
 */
export function topMovers(tf: Timeframe, limit = 10): TopMovers {
  const s = ensureScan(tf);
  const eligible = s.rows.filter(
    (r) =>
      r.instrument.segment === "fno" &&
      r.value != null &&
      (r.quality === "valid" || r.quality === "partial"),
  );
  const buying = eligible
    .filter((r) => (r.value as number) > 50)
    .sort((a, b) => (b.value as number) - (a.value as number))
    .slice(0, limit)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const selling = eligible
    .filter((r) => (r.value as number) < 50)
    .sort((a, b) => (a.value as number) - (b.value as number))
    .slice(0, limit)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    timeframe: tf,
    status: s.status,
    progress: s.progress,
    buying,
    selling,
    eligible: eligible.length,
    scannedAt: s.finishedAt ? new Date(s.finishedAt).toISOString() : null,
    disclaimer:
      "Ranked purely by each instrument's own FMPI pressure reading — this is evidence of buying/selling pressure, not a buy/sell recommendation. High pressure can persist in a trend and does not imply an imminent reversal.",
  };
}
