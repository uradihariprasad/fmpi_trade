import type { EngineConfig, Timeframe } from "./types";

/**
 * FMPI engine v2 configuration.
 *
 * Options positioning is the dominant input (50%). Open interest is the
 * only component that reveals where committed money is actually
 * positioned, so it anchors sentiment while price/volume/futures supply
 * confirmation. The remaining 50% is split across the other components.
 */
export const DEFAULT_CONFIG: EngineConfig = {
  weights: {
    options_positioning: 0.5,
    price_pressure: 0.16,
    futures_positioning: 0.14,
    volume_participation: 0.08,
    price_structure: 0.08,
    acceleration_persistence: 0.04,
  },
  logisticK: 3.2,
  percentileBlend: 0.25,
  percentileWindow: 375,
  percentileMinSamples: 75,

  /* Dynamic zones — a longer causal window makes the quantile boundaries
     describe the instrument's regime rather than the last two hours. */
  zoneWindow: 450,
  zoneMinSamples: 90,
  zoneQuantiles: [5, 15, 40, 60, 85, 95],
  zoneSmoothing: 0.15,

  smoothingAlpha: { "5m": 0.3, "10m": 0.26 } as Record<Timeframe, number>,
  volLookback: 20,
  volumeLookback: 20,
  structureLookback: 40,
  atrLookback: 14,
  slopeWindow: 3,
  accelWindow: 3,
  swingConfirmBars: 3,
  swingNoise: 0.4,        // absolute floor; the live gate tracks local jitter
  swingProminence: 2.5,   // absolute floor; the live gate tracks dispersion
  swingLookback: 20,      // bars either side used to measure prominence
  divergenceMinSeparation: 6,
  divergenceMinDiff: 1.5,
  minCandles: 30,
  minCoverage: 0.3,

  /* ---------------- trend-regime layer (v2) ----------------
     Fixes counter-trend misreads: a small bounce inside a downtrend must
     not be scored as bullish continuation. */
  regimeFast: 20,          // fast EMA, bars
  regimeSlow: 50,          // slow EMA, bars
  regimeSlopeWindow: 10,   // bars used for slow-EMA slope
  regimeMinStrength: 0.25, // below this the tape is treated as rangebound
  regimeAnchor: 0.22,      // share of the composite anchored to the regime
  counterTrendDamping: 0.55, // how hard counter-regime pressure is damped
  regimeFlipBars: 5,       // consecutive counter-regime bars before a flip
};

export function withConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    weights: { ...DEFAULT_CONFIG.weights, ...(overrides.weights ?? {}) },
    smoothingAlpha: { ...DEFAULT_CONFIG.smoothingAlpha, ...(overrides.smoothingAlpha ?? {}) },
    zoneQuantiles: overrides.zoneQuantiles ?? DEFAULT_CONFIG.zoneQuantiles,
  };
}
