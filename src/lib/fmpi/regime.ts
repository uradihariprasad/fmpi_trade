/**
 * Trend-regime layer (FMPI v2).
 *
 * THE PROBLEM THIS SOLVES
 * A market in a downtrend regularly bounces for two or three candles on a
 * retest. Every short-window component (candle body, close location,
 * return z-score, acceleration) turns positive at the same moment, so the
 * old composite spiked and the state machine reported bullish
 * continuation — a counter-trend bounce dressed up as a reversal.
 *
 * The regime layer establishes the dominant direction from a much longer
 * causal window than any single component uses, so short bursts can be
 * recognised as PULLBACKS inside the prevailing trend until enough
 * evidence accumulates for a genuine regime flip.
 *
 * Everything here is causal: regime at bar i uses only bars ≤ i.
 */
import type { Candle, EngineConfig } from "./types";
import { atr, clamp, tanh } from "./math";

export type RegimeLabel = "strong_bull" | "bull" | "neutral" | "bear" | "strong_bear";

export interface RegimeReading {
  /** −1 bearish, 0 rangebound, +1 bullish */
  direction: -1 | 0 | 1;
  /** 0..1 — how convincingly the tape is trending */
  strength: number;
  label: RegimeLabel;
  /** direction × strength, in [-1, 1] — used to anchor the composite */
  bias: number;
  emaFast: number;
  emaSlow: number;
  /** price is counter-trending against the regime right now */
  pullback: boolean;
  /** distance of close from the slow EMA, in ATR units */
  stretchAtr: number;
}

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Per-candle regime readings for the whole series (causal). */
export function computeRegimes(candles: Candle[], cfg: EngineConfig): RegimeReading[] {
  const n = candles.length;
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const fast = emaSeries(closes, cfg.regimeFast);
  const slow = emaSeries(closes, cfg.regimeSlow);

  const out: RegimeReading[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(atr(highs, lows, closes, i, cfg.atrLookback), closes[i] * 1e-5);

    // 1. EMA separation in ATR units — trend body
    const sep = (fast[i] - slow[i]) / a;

    // 2. Slow-EMA slope in ATR units — trend persistence
    const back = Math.max(0, i - cfg.regimeSlopeWindow);
    const slope = (slow[i] - slow[back]) / a;

    // 3. Structural agreement: where price sits versus both EMAs
    const above = (closes[i] > fast[i] ? 1 : -1) + (closes[i] > slow[i] ? 1 : -1);
    const structure = above / 2; // -1, 0 or +1

    // Warm-up: the slow EMA is meaningless before it has seen its period.
    if (i < cfg.regimeSlow) {
      out.push({
        direction: 0, strength: 0, label: "neutral", bias: 0,
        emaFast: fast[i], emaSlow: slow[i], pullback: false,
        stretchAtr: (closes[i] - slow[i]) / a,
      });
      continue;
    }

    /* Trend BODY comes from EMA separation and slope. Where price sits
       relative to the EMAs only CONFIRMS an existing trend — on its own it
       would label a flat tape as trending, because price is always a
       fraction above or below the averages. */
    const body = 0.9 * sep + 1.4 * slope;
    const confirm = 0.35 * structure * clamp(Math.abs(body) / 0.3, 0, 1);
    const raw = tanh(body + confirm);
    const strength = clamp(Math.abs(raw), 0, 1);
    const direction: -1 | 0 | 1 =
      strength < cfg.regimeMinStrength ? 0 : raw > 0 ? 1 : -1;

    const label: RegimeLabel =
      direction === 0 ? "neutral"
        : direction > 0 ? (strength >= 0.6 ? "strong_bull" : "bull")
          : strength >= 0.6 ? "strong_bear" : "bear";

    // A pullback is price moving against an established regime while the
    // regime itself is still intact (close on the wrong side of the fast
    // EMA, but the trend structure has not broken).
    const pullback =
      direction !== 0 &&
      ((direction < 0 && closes[i] > fast[i] && closes[i] < slow[i]) ||
        (direction > 0 && closes[i] < fast[i] && closes[i] > slow[i]));

    out.push({
      direction, strength, label,
      bias: direction * strength,
      emaFast: fast[i], emaSlow: slow[i],
      pullback,
      stretchAtr: (closes[i] - slow[i]) / a,
    });
  }
  return out;
}

export const REGIME_LABEL: Record<RegimeLabel, string> = {
  strong_bull: "STRONG UPTREND",
  bull: "UPTREND",
  neutral: "RANGEBOUND",
  bear: "DOWNTREND",
  strong_bear: "STRONG DOWNTREND",
};
