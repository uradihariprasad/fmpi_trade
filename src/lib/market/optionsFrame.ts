/**
 * Genuine option positioning data WITHOUT an authenticated session.
 *
 * Upstox `/option/chain` and `/option/contract` require a login token
 * (HTTP 401 otherwise), which is why options positioning used to report
 * MISSING for every instrument. However, each individual option contract
 * is a normal instrument whose historical candles are public — and those
 * candles carry per-interval **open interest and volume**, exactly like
 * the futures contracts already used by the engine.
 *
 * This module therefore reconstructs the option chain from contract
 * candles, which is strictly better than a chain snapshot:
 *   • every historical candle gets its own point-in-time reading
 *   • values are causal (OI at bar i is the OI printed at bar i)
 *   • nothing requires a daily token
 *
 * Only strikes around the traded price are fetched, with a hard cap on
 * contract count so one chart load stays within a few requests.
 */
import type { Candle, InstrumentMeta, Timeframe } from "@/lib/fmpi/types";
import { TIMEFRAME_MINUTES } from "@/lib/fmpi/types";
import { fetchV3Candles, fetchV3Intraday, getOptionContracts } from "./upstox";
import { istDateStr } from "./session";

/** Strikes either side of ATM used for scoring a candle. */
export const STRIKE_RADIUS = 3;
/** Hard cap on contracts fetched per chart load (CE+PE combined). */
const MAX_CONTRACTS = 26;
/** Sessions of option history to reconstruct. */
const OPTION_SESSIONS = 3;

export interface OptionPoint {
  oi: number;
  vol: number;
  /** contract close — enables writing vs buying classification */
  close: number;
}

export interface OptionsFrame {
  expiryDate: string;
  strikeStep: number;
  strikes: number[];
  /** strike → (candle ts → {oi, vol}) */
  ce: Map<number, Map<number, OptionPoint>>;
  pe: Map<number, Map<number, OptionPoint>>;
  contracts: number;
  /** earliest candle timestamp covered by the fetched contracts */
  from: number;
  note: string;
}

function modalStep(strikes: number[]): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < strikes.length; i++) {
    const d = Math.round((strikes[i] - strikes[i - 1]) * 100) / 100;
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
  return best || 1;
}

const globalOptions = globalThis as typeof globalThis & {
  __fmpiOptionsFrames?: Map<string, { at: number; frame: OptionsFrame | null }>;
};
const frameCache = globalOptions.__fmpiOptionsFrames ?? new Map<string, { at: number; frame: OptionsFrame | null }>();
globalOptions.__fmpiOptionsFrames = frameCache;
const FRAME_TTL = 60_000;
const FRAME_CACHE_MAX = Math.max(1, Number(process.env.OPTIONS_FRAME_CACHE_MAX ?? 3));

function frameCachePut(key: string, frame: OptionsFrame | null): void {
  if (frameCache.has(key)) frameCache.delete(key);
  frameCache.set(key, { at: Date.now(), frame });
  while (frameCache.size > FRAME_CACHE_MAX) {
    const oldest = frameCache.keys().next().value;
    if (oldest === undefined) break;
    frameCache.delete(oldest);
  }
}

/**
 * Builds the option OI/volume frame aligned to the spot candle grid.
 * Returns null (never a fabricated chain) when the underlying has no
 * listed options or the provider returns nothing usable.
 */
export interface FrameOptions {
  /**
   * Restrict strikes to ATM±focusRadius of the latest close. Trade
   * management only needs the ±3 band, so this keeps a refresh to ~14
   * contract requests instead of 26.
   */
  focusRadius?: number;
  /** Sessions of option history to reconstruct (default OPTION_SESSIONS). */
  sessions?: number;
}

export async function buildOptionsFrame(
  meta: InstrumentMeta,
  tf: Timeframe,
  spot: Candle[],
  nowMs = Date.now(),
  opts: FrameOptions = {},
): Promise<OptionsFrame | null> {
  if (spot.length === 0) return null;

  // Restrict option reconstruction to the most recent sessions.
  const sessionDates = [...new Set(spot.map((c) => istDateStr(c.ts)))].sort();
  const windowDates = sessionDates.slice(-(opts.sessions ?? OPTION_SESSIONS));
  const fromDate = windowDates[0];
  const toDate = windowDates[windowDates.length - 1];
  const windowStart = spot.find((c) => istDateStr(c.ts) === fromDate)?.ts ?? spot[0].ts;
  const windowSpot = spot.filter((c) => c.ts >= windowStart);
  if (windowSpot.length === 0) return null;

  const listing = await getOptionContracts(meta.instrumentKey, nowMs);
  if (!listing || listing.contracts.length === 0) return null;

  const cacheKey = `${meta.instrumentKey}|${tf}|${listing.expiryDate}|${fromDate}|${toDate}|r${opts.focusRadius ?? "full"}`;
  const hit = frameCache.get(cacheKey);
  if (hit && nowMs - hit.at < FRAME_TTL) return hit.frame;

  const allStrikes = [...new Set(listing.contracts.map((c) => c.strike))].sort((a, b) => a - b);
  if (allStrikes.length < 3) return null;
  const step = modalStep(allStrikes);

  // Cover the price range actually traded in the window, plus the scoring
  // radius, then cap. Capping centres on the latest close.
  const lo = Math.min(...windowSpot.map((c) => c.low));
  const hi = Math.max(...windowSpot.map((c) => c.high));
  const last = windowSpot[windowSpot.length - 1].close;
  const pad = step * STRIKE_RADIUS;
  let wanted = opts.focusRadius
    ? allStrikes.filter((s) => Math.abs(s - last) <= step * opts.focusRadius! + step * 0.5)
    : allStrikes.filter((s) => s >= lo - pad && s <= hi + pad);
  const maxStrikes = Math.floor(MAX_CONTRACTS / 2);
  if (wanted.length > maxStrikes) {
    wanted = [...wanted]
      .sort((a, b) => Math.abs(a - last) - Math.abs(b - last))
      .slice(0, maxStrikes)
      .sort((a, b) => a - b);
  }
  if (wanted.length < 3) return null;
  const keep = new Set(wanted);
  const targets = listing.contracts.filter((c) => keep.has(c.strike));

  const ce = new Map<number, Map<number, OptionPoint>>();
  const pe = new Map<number, Map<number, OptionPoint>>();
  const interval = TIMEFRAME_MINUTES[tf];
  let ok = 0;

  // bounded parallelism — the shared rate gate still paces the provider
  const today = istDateStr(nowMs);
  const pastDates = windowDates.filter((d) => d !== today);
  const needsIntraday = windowDates.includes(today);
  const histTo = pastDates.length ? pastDates[pastDates.length - 1] : null;
  const histFrom = pastDates.length ? pastDates[0] : null;

  const queue = [...targets];
  const worker = async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const series = new Map<number, OptionPoint>();
      const absorb = (rows: Awaited<ReturnType<typeof fetchV3Candles>>) => {
        for (const r of rows) {
          if (r.oi == null) continue;
          series.set(r.ts, { oi: r.oi, vol: r.volume, close: r.close });
        }
      };
      try {
        if (histFrom && histTo) {
          absorb(await fetchV3Candles(c.instrumentKey, "minutes", interval, histTo, histFrom));
        }
        // The running session is only available on the intraday feed.
        if (needsIntraday) {
          const live = await fetchV3Intraday(c.instrumentKey, "minutes", interval);
          absorb(live.filter((r) => istDateStr(r.ts) === today));
        }
      } catch {
        /* a single illiquid contract must not fail the frame */
      }
      if (series.size === 0) continue;
      (c.type === "CE" ? ce : pe).set(c.strike, series);
      ok++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));

  if (ok === 0) {
    frameCache.set(cacheKey, { at: nowMs, frame: null });
    return null;
  }

  const strikes = [...new Set([...ce.keys(), ...pe.keys()])].sort((a, b) => a - b);
  const frame: OptionsFrame = {
    expiryDate: listing.expiryDate,
    strikeStep: step,
    strikes,
    ce, pe,
    contracts: ok,
    from: windowStart,
    note: `expiry ${listing.expiryDate} · ${ok} contracts · ${strikes.length} strikes · per-candle OI from public contract candles`,
  };
  frameCachePut(cacheKey, frame);
  return frame;
}
