/**
 * Order-flow reading.
 *
 * HONEST SCOPE: Upstox historical/intraday candles expose OHLCV only —
 * not trade-level bid/ask aggression. True footprint delta therefore
 * cannot be computed from this feed. What follows is the standard
 * candle-derived approximation, and it is labelled as an estimate
 * everywhere it surfaces:
 *
 *   buy volume  ≈ volume × (close − low)  / (high − low)
 *   sell volume ≈ volume × (high − close) / (high − low)
 *   delta       = buy − sell
 *
 * From that it derives cumulative delta, participation-weighted
 * pressure, absorption (heavy volume with no progress) and delta
 * divergence (price extends while flow does not confirm).
 *
 * Indices publish no exchange volume, so the caller is expected to pass
 * the linked futures candles instead; the source is reported either way.
 */
import type { Candle } from "./types";
import { atr, clamp, mean } from "./math";

const EPS = 1e-9;

export type FlowPressure = "buyers" | "sellers" | "balanced";

export interface OrderFlowReading {
  available: boolean;
  source: "spot" | "futures" | null;
  /** signed volume of the evaluated candle */
  delta: number;
  /** signed volume accumulated over the lookback */
  cumulativeDelta: number;
  /** cumulative delta as a share of total volume, -1..1 */
  deltaRatio: number;
  pressure: FlowPressure;
  /** heavy participation with little price progress */
  absorption: boolean;
  divergence: "bullish" | "bearish" | "none";
  /** -1..1 composite, positive = buyers in control */
  score: number;
  notes: string[];
}

const UNAVAILABLE: OrderFlowReading = {
  available: false, source: null, delta: 0, cumulativeDelta: 0, deltaRatio: 0,
  pressure: "balanced", absorption: false, divergence: "none", score: 0,
  notes: ["order flow unavailable — no exchange volume on this feed"],
};

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

/** Signed volume of a single candle (close-location weighted). */
export function candleDelta(c: Candle): number {
  const range = c.high - c.low;
  if (range <= EPS || c.volume <= 0) return 0;
  const buy = c.volume * ((c.close - c.low) / range);
  const sell = c.volume * ((c.high - c.close) / range);
  return buy - sell;
}

export function computeOrderFlow(
  candles: Candle[],
  i: number,
  source: "spot" | "futures",
  lookback = 20,
): OrderFlowReading {
  if (i < 2 || i >= candles.length) return UNAVAILABLE;
  const start = Math.max(0, i - lookback + 1);
  const window = candles.slice(start, i + 1);
  const totalVol = window.reduce((s, c) => s + c.volume, 0);
  if (totalVol <= 0) return UNAVAILABLE;

  const deltas = window.map(candleDelta);
  const cumulativeDelta = deltas.reduce((a, b) => a + b, 0);
  const delta = deltas[deltas.length - 1];
  const deltaRatio = clamp(cumulativeDelta / totalVol, -1, 1);

  // Absorption: top-quartile volume with a body far smaller than ATR.
  const vols = window.map((c) => c.volume).sort((a, b) => a - b);
  const q75 = vols[Math.floor(vols.length * 0.75)] ?? 0;
  const a = atr(
    candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close),
    i, 14,
  );
  const body = Math.abs(candles[i].close - candles[i].open);
  const absorption = candles[i].volume >= q75 && a > EPS && body < a * 0.25;

  // Delta divergence: price extends but flow does not confirm.
  const half = Math.floor(window.length / 2);
  let divergence: "bullish" | "bearish" | "none" = "none";
  if (half >= 3) {
    const firstHalf = window.slice(0, half);
    const secondHalf = window.slice(half);
    const d1 = deltas.slice(0, half).reduce((x, y) => x + y, 0);
    const d2 = deltas.slice(half).reduce((x, y) => x + y, 0);
    const priceHi1 = Math.max(...firstHalf.map((c) => c.high));
    const priceHi2 = Math.max(...secondHalf.map((c) => c.high));
    const priceLo1 = Math.min(...firstHalf.map((c) => c.low));
    const priceLo2 = Math.min(...secondHalf.map((c) => c.low));
    if (priceHi2 > priceHi1 && d2 < d1) divergence = "bearish";
    else if (priceLo2 < priceLo1 && d2 > d1) divergence = "bullish";
  }

  const recentDeltaNorm = clamp(
    delta / Math.max(mean(window.map((c) => c.volume)), 1),
    -1, 1,
  );
  let score = 0.55 * deltaRatio + 0.3 * recentDeltaNorm;
  if (divergence === "bearish") score -= 0.2;
  if (divergence === "bullish") score += 0.2;
  score = clamp(score, -1, 1);

  const pressure: FlowPressure =
    deltaRatio > 0.08 ? "buyers" : deltaRatio < -0.08 ? "sellers" : "balanced";

  const notes = [
    `${source === "futures" ? "Futures" : "Spot"} order flow (candle-derived estimate — tick-level aggression is not published on this feed)`,
    `cumulative delta ${cumulativeDelta >= 0 ? "+" : ""}${fmt(cumulativeDelta)} over ${window.length} bars (${(deltaRatio * 100).toFixed(0)}% of traded volume) — ${pressure} in control`,
  ];
  if (absorption) notes.push("Absorption: heavy participation with almost no price progress — one side is being filled into.");
  if (divergence === "bearish") notes.push("Negative delta divergence: price made a higher high while flow weakened.");
  if (divergence === "bullish") notes.push("Positive delta divergence: price made a lower low while flow improved.");

  return {
    available: true, source,
    delta, cumulativeDelta, deltaRatio,
    pressure, absorption, divergence,
    score, notes,
  };
}

/** Picks whichever genuine series carries volume: spot, else futures. */
export function orderFlowFor(
  spot: Candle[], futures: Candle[] | null, i: number, lookback = 20,
): OrderFlowReading {
  const spotHasVolume = spot.slice(Math.max(0, i - lookback), i + 1).some((c) => c.volume > 0);
  if (spotHasVolume) return computeOrderFlow(spot, i, "spot", lookback);
  if (futures && futures.length > 0) {
    // align on the evaluated timestamp
    const ts = spot[i]?.ts;
    const idx = futures.findIndex((c) => c.ts === ts);
    const useIdx = idx >= 0 ? idx : futures.length - 1;
    const futHasVolume = futures.slice(Math.max(0, useIdx - lookback), useIdx + 1).some((c) => c.volume > 0);
    if (futHasVolume) return computeOrderFlow(futures, useIdx, "futures", lookback);
  }
  return UNAVAILABLE;
}
