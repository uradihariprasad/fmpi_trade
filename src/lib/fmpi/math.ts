/** Numeric primitives for the FMPI engine — all causal, all pure. */

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function tanh(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
}

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stdev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Nearest-rank percentile with linear interpolation, p in [0,100]. */
export function quantile(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = (clamp(p, 0, 100) / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/** Median absolute deviation (scaled to ~std for normal data). */
export function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/** Robust z-score: location=m median, scale=1.4826·MAD, winsor-clipped. */
export function robustZ(x: number, xs: number[], clipAt = 3): number {
  if (xs.length < 3) return 0;
  const m = median(xs);
  const s = mad(xs);
  if (s <= 1e-12) return x > m ? 0.5 : x < m ? -0.5 : 0;
  return clamp((x - m) / s, -clipAt, clipAt);
}

/** Percentile rank (0..1) of x within the window (causal, includes x). */
export function percentileRank(window: number[], x: number): number {
  if (window.length === 0) return 0.5;
  let below = 0;
  for (const v of window) if (v <= x) below++;
  return below / window.length;
}

/** Simple causal EMA helper kept as explicit state so nothing anticipates. */
export class Ema {
  private value: number | null = null;
  constructor(private readonly alpha: number) {}
  next(x: number): number {
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }
  get current(): number | null {
    return this.value;
  }
}

/** Bounded ring buffer for rolling windows. */
export class Ring {
  private buf: number[] = [];
  constructor(public readonly capacity: number) {}
  push(x: number): void {
    this.buf.push(x);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  get values(): number[] {
    return this.buf;
  }
  get size(): number {
    return this.buf.length;
  }
  sorted(): number[] {
    return [...this.buf].sort((a, b) => a - b);
  }
}

/** Average True Range over the trailing window (causal). */
export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  end: number,
  lookback: number,
): number {
  const start = Math.max(1, end - lookback + 1);
  if (end < 1) return 0;
  let sum = 0;
  let n = 0;
  for (let i = start; i <= end; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    sum += tr;
    n++;
  }
  return n ? sum / n : 0;
}
