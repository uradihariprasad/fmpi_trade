import type { Candle } from "@/lib/fmpi/types";

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenOpts {
  n?: number;
  start?: number;
  drift?: number; // per-bar drift in return units
  vol?: number; // per-bar stdev of returns
  withVolume?: boolean;
  startTs?: number;
  tfMs?: number;
}

/** Synthetic random-walk OHLCV candles (test fixtures only, never served by API). */
export function genCandles(o: GenOpts = {}, returns?: number[]): Candle[] {
  const n = o.n ?? 300;
  const start = o.start ?? 1000;
  const vol = o.vol ?? 0.0016;
  const drift = o.drift ?? 0;
  const startTs = o.startTs ?? Date.UTC(2026, 8, 28, 3, 45); // 09:15 IST
  const tfMs = o.tfMs ?? 300_000;
  const rand = rng(o.n ?? 1);
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const r = returns ? returns[i % returns.length] : drift + (rand() * 2 - 1) * vol;
    const open = price;
    const close = price * (1 + r);
    const high = Math.max(open, close) * (1 + rand() * vol * 0.6);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.6);
    out.push({
      ts: startTs + i * tfMs,
      open, high, low, close,
      volume: o.withVolume === false ? 0 : Math.round(400_000 + rand() * 300_000 + Math.abs(r) * 3e8),
      oi: null,
    });
    price = close;
  }
  return out;
}

/** Crafted to force exactly one prominent FMPI peak in the middle. */
export function peakPattern(): Candle[] {
  const up = Array.from({ length: 60 }, () => 0.004);
  const top = Array.from({ length: 6 }, () => 0.0005);
  const down = Array.from({ length: 40 }, () => -0.003);
  const tail = Array.from({ length: 60 }, (_, i) => (i % 2 ? 0.0012 : -0.0012));
  return genCandles({ n: 166, start: 1000, vol: 0.0004, withVolume: false }, [...up, ...top, ...down, ...tail]);
}
