/**
 * FMPI component calculators.
 * Every component maps its own measurements into a direction-aware score in
 * [-1, +1]; units never mix. Each returns `available:false` when its inputs
 * are genuinely absent (e.g. no exchange volume on indices, no futures
 * contract resolved) so the composite can renorm weights truthfully.
 *
 * All functions are causal: reading index i only touches observations ≤ i.
 */
import type { Candle, ComponentReading, EngineConfig, FuturesFrame } from "./types";
import { atr, clamp, mean, median, robustZ, stdev, tanh } from "./math";

const EPS = 1e-9;

function returns(closes: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < closes.length; i++) r.push(closes[i] / closes[i - 1] - 1);
  return r;
}

function volSigma(rets: number[], i: number, lookback: number): number {
  // rets[k] is the return closing at candle k+1
  const end = Math.min(i - 1, rets.length); // exclusive
  const start = Math.max(0, end - lookback);
  const win = rets.slice(start, end);
  if (win.length < 5) return 0;
  return Math.max(stdev(win), 1e-6);
}

/** A — Price pressure & candle structure. Weight 30%. */
export function pricePressure(c: Candle[], i: number, cfg: EngineConfig): ComponentReading {
  if (i < Math.max(6, cfg.volLookback - 1)) {
    return { score: null, available: false, evidence: ["warming up: insufficient candles"] };
  }
  const closes = c.map((x) => x.close);
  const rets = returns(closes);
  const sigma = volSigma(rets, i, cfg.volLookback);
  const ret = rets[i - 1];
  const zRet = clamp(ret / Math.max(sigma, 1e-6), -3, 3) / 3;

  const k = c[i];
  const range = Math.max(k.high - k.low, k.close * 1e-6);
  const body = clamp((k.close - k.open) / range, -1, 1);
  const closeLoc = clamp((2 * k.close - k.high - k.low) / range, -1, 1);
  const candleScore = 0.55 * closeLoc + 0.45 * body;

  // directional persistence over last 5 completed moves
  const dir: number[] = [];
  for (let j = Math.max(1, i - 4); j <= i; j++) dir.push(Math.sign(closes[j] - closes[j - 1]));
  const persistence = mean(dir);

  // higher highs/lows vs lower highs/lows over a 10-bar window
  let hh = 0; let hl = 0; let lh = 0; let ll = 0;
  for (let j = Math.max(1, i - 9); j <= i; j++) {
    if (c[j].high > c[j - 1].high) hh++; else if (c[j].high < c[j - 1].high) lh++;
    if (c[j].low > c[j - 1].low) hl++; else if (c[j].low < c[j - 1].low) ll++;
  }
  const structure = clamp((hh + hl - lh - ll) / 14, -1, 1);

  // breakout/breakdown distance vs prior 20-bar extremes, in ATR units
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), closes, i, cfg.atrLookback);
  const hiPrev = Math.max(...c.slice(Math.max(0, i - 20), i).map((x) => x.high), -Infinity);
  const loPrev = Math.min(...c.slice(Math.max(0, i - 20), i).map((x) => x.low), Infinity);
  let breakout = 0;
  if (a > EPS) {
    breakout =
      clamp((k.close - hiPrev) / a, -1.5, 1.5) / 1.5 + clamp((loPrev - k.close) / a, -1.5, 1.5) / 1.5;
    breakout = clamp(breakout, -1, 1);
  }

  const score = tanh(0.38 * zRet + 0.22 * candleScore + 0.15 * persistence + 0.15 * structure + 0.1 * breakout);
  const evidence: string[] = [
    `return ${(ret * 100).toFixed(2)}% = ${(ret / Math.max(sigma, 1e-6)).toFixed(2)}σ of ${cfg.volLookback}-bar vol`,
    `close at ${((closeLoc + 1) * 50).toFixed(0)}% of candle range`,
    `directional persistence ${persistence >= 0 ? "+" : ""}${persistence.toFixed(2)} over 5 bars`,
  ];
  if (structure > 0.2) evidence.push("higher highs / higher lows dominate");
  if (structure < -0.2) evidence.push("lower highs / lower lows dominate");
  if (Math.abs(breakout) > 0.3)
    evidence.push(breakout > 0 ? "breaking above prior 20-bar high" : "breaking below prior 20-bar low");
  return { score, available: true, evidence };
}

/** B — Volume participation. Weight 20%. Candle-directional estimate (labelled). */
export function volumeParticipation(c: Candle[], i: number, cfg: EngineConfig): ComponentReading {
  const v = c[i].volume;
  const hasVol = c.slice(Math.max(0, i - cfg.volumeLookback), i + 1).some((x) => x.volume > 0);
  if (!hasVol || i < cfg.volumeLookback) {
    return {
      score: null,
      available: false,
      evidence: ["volume unavailable for this instrument/session (labelled: excluded from composite)"],
    };
  }
  const win = c.slice(Math.max(0, i - cfg.volumeLookback), i).map((x) => x.volume);
  const med = Math.max(median(win), 1);
  const rvol = v / med;
  const vsd = Math.max(stdev(win), 1);
  const volZ = clamp((v - median(win)) / vsd, -3, 3);

  const closes = c.map((x) => x.close);
  const dir = Math.sign(closes[i] - closes[i - 1]);
  // candle-based directional participation estimate (trade direction unknown)
  const participation = dir * clamp((rvol - 1) * 0.9, -1, 1);
  // volume trend vs price trend agreement over 6 bars
  const vWin = c.slice(Math.max(0, i - 5), i + 1).map((x) => x.volume);
  const vTrend = (vWin[vWin.length - 1] - vWin[0]) / Math.max(mean(vWin), 1);
  const pMove = closes[i] - closes[Math.max(0, i - 5)];
  const agree = clamp(vTrend, -2, 2) * 0.5 * Math.sign(pMove);
  // extended move with shrinking volume decays toward zero
  let fade = 0;
  if (Math.abs(pMove) > EPS && rvol < 0.8 && vTrend < 0) fade = -0.35 * Math.sign(pMove);

  const score = tanh(0.8 * participation + 0.45 * clamp(agree, -1, 1) + 0.15 * (volZ / 3) * dir + fade);
  const evidence = [
    `RVOL ${rvol.toFixed(2)}× vs ${cfg.volumeLookback}-bar median (candle-directional estimate — trade direction not observable)`,
  ];
  if (fade < 0) evidence.push("price extending on shrinking volume — participation fading");
  if (rvol > 1.5 && dir !== 0) evidence.push(`volume expansion in ${dir > 0 ? "up" : "down"} move`);
  if (volZ > 2) evidence.push("volume outlier vs recent distribution");
  return { score, available: true, evidence };
}

/** C — Momentum slope & acceleration+persistence. Weight 5%. */
export function accelerationPersistence(c: Candle[], i: number, cfg: EngineConfig): ComponentReading {
  if (i < cfg.volLookback + 8) return { score: null, available: false, evidence: ["warming up"] };
  const closes = c.map((x) => x.close);
  const rets = returns(closes);
  const sigma = volSigma(rets, i, cfg.volLookback);
  const z = (k: number) => (rets[k - 1] ?? 0) / Math.max(sigma, 1e-6);
  const s3 = mean([z(i), z(i - 1), z(i - 2)]).valueOf();
  const s8 = mean([z(i), z(i - 1), z(i - 2), z(i - 3), z(i - 4), z(i - 5), z(i - 6), z(i - 7)]);
  const slopeShort = clamp(s3 / 2, -1, 1);
  const accel = clamp((s3 - s8) / 2, -1, 1);
  const dir: number[] = [];
  for (let j = Math.max(1, i - 7); j <= i; j++) dir.push(Math.sign(closes[j] - closes[j - 1]));
  const persist = mean(dir);
  const score = tanh(0.55 * slopeShort + 0.35 * accel + 0.45 * persist);
  return {
    score,
    available: true,
    evidence: [
      `short slope ${slopeShort >= 0 ? "+" : ""}${slopeShort.toFixed(2)} · acceleration ${accel >= 0 ? "+" : ""}${accel.toFixed(2)}`,
      `8-bar directional persistence ${persist >= 0 ? "+" : ""}${persist.toFixed(2)}`,
    ],
  };
}

/** D — Futures positioning (price + OI + premium). Weight 20%. */
export function futuresPositioning(
  spot: Candle[],
  i: number,
  frame: FuturesFrame | null,
): ComponentReading {
  const k = spot[i];
  if (!frame) {
    return {
      score: null,
      available: false,
      evidence: ["futures contract not resolved — component excluded (weight renorm)"],
    };
  }
  const fc = frame.byTs.get(k.ts);
  const findPrev = (): Candle | null => {
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      const p = frame.byTs.get(spot[j].ts);
      if (p) return p;
    }
    return null;
  };
  if (!fc) {
    return { score: null, available: false, evidence: ["no futures candle aligned to this timestamp"] };
  }
  const prev = findPrev();
  const fRet = prev ? fc.close / prev.close - 1 : 0;
  const dOi = prev && fc.oi != null && prev.oi != null && prev.oi > 0 ? fc.oi / prev.oi - 1 : null;
  if (dOi === null) {
    return { score: null, available: false, evidence: ["OI snapshot missing — never substituted with zero"] };
  }
  const zP = clamp(fRet / 0.0012, -2.5, 2.5) / 2.5; // scaled by ~12bp norm move
  const zO = clamp(dOi / 0.004, -2.5, 2.5) / 2.5; // scaled by ~0.4% OI move
  const up = fRet > EPS; const down = fRet < -EPS;
  const oiUp = dOi > 1e-4; const oiDown = dOi < -1e-4;
  let stance: number; let label: string;
  if (up && oiUp) { stance = +1; label = "long buildup (price↑ OI↑)"; }
  else if (down && oiUp) { stance = -1; label = "short buildup (price↓ OI↑)"; }
  else if (up && oiDown) { stance = +0.55; label = "short covering (price↑ OI↓)"; }
  else if (down && oiDown) { stance = -0.55; label = "long unwinding (price↓ OI↓)"; }
  else { stance = 0; label = "positioning flat"; }
  // futures premium/discount tilt
  const premium = (fc.close - k.close) / k.close;
  const premTilt = clamp(premium / 0.0015, -1, 1) * 0.15;
  const score = tanh(stance * (0.55 * Math.abs(zP) + 0.45 * Math.abs(zO)) + premTilt);
  return {
    score,
    available: true,
    evidence: [
      label + " — evidence, not identification of trader intent",
      `futures move ${(fRet * 100).toFixed(2)}% · ΔOI ${(dOi * 100).toFixed(2)}% · basis ${(premium * 100).toFixed(3)}%`,
    ],
  };
}

/**
 * E — Options positioning. Weight 15%.
 * Supplied per candle by `lib/fmpi/options.ts`, which reconstructs CE/PE
 * open interest and volume from public option-contract candles.
 */
export function optionsPositioning(reading: ComponentReading | null): ComponentReading {
  if (reading) return reading;
  return {
    score: null,
    available: false,
    evidence: ["no option positioning data for this candle — component excluded, not fabricated"],
  };
}

/** F — Price structure: swings, level proximity, rejection, stall. Weight 10%. */
export function priceStructure(c: Candle[], i: number, cfg: EngineConfig): ComponentReading {
  if (i < cfg.structureLookback) return { score: null, available: false, evidence: ["warming up"] };
  const closes = c.map((x) => x.close);
  const win = c.slice(Math.max(0, i - cfg.structureLookback), i + 1);
  const hi = Math.max(...win.map((x) => x.high));
  const lo = Math.min(...win.map((x) => x.low));
  const span = Math.max(hi - lo, closes[i] * 1e-6);
  const channelPos = clamp(2 * ((closes[i] - lo) / span) - 1, -1, 1);
  const a = atr(c.map((x) => x.high), c.map((x) => x.low), closes, i, cfg.atrLookback);
  const k = c[i];
  const range = Math.max(k.high - k.low, EPS);
  const upWick = k.high - Math.max(k.open, k.close);
  const dnWick = Math.min(k.open, k.close) - k.low;
  let rejection = 0;
  if (channelPos > 0.7 && upWick / range > 0.55) rejection = -0.6; // rejected at highs
  if (channelPos < -0.7 && dnWick / range > 0.55) rejection = +0.6; // rejected at lows
  // stall: high channel travel but tiny net progress over 5 bars
  const progress = a > EPS ? Math.abs(closes[i] - closes[Math.max(0, i - 5)]) / a : 0;
  let stall = 0;
  if (progress < 0.35 && Math.abs(channelPos) > 0.65) stall = -Math.sign(channelPos) * 0.25;
  const score = tanh(0.62 * channelPos + 0.55 * rejection + 0.4 * stall);
  const evidence = [`price at ${(((closes[i] - lo) / span) * 100).toFixed(0)}% of ${cfg.structureLookback}-bar channel`];
  if (rejection < 0) evidence.push("upper-wick rejection near channel top");
  if (rejection > 0) evidence.push("lower-wick rejection near channel bottom");
  if (stall !== 0) evidence.push("price stalling at channel extreme despite range travel");
  if (a > EPS) evidence.push(`net 5-bar progress ${progress.toFixed(2)} ATR`);
  return { score, available: true, evidence };
}
