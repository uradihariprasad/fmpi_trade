/**
 * FMPI — Financial Market Pressure Index
 * Shared contracts for the engine, API (v1) and frontend.
 * Engine version is persisted with every snapshot so historical
 * readings are never silently recomputed under a different formula.
 */

export const ENGINE_VERSION = "fmpi-1.0.0";

export type Timeframe = "5m" | "10m";
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = { "5m": 5, "10m": 10 };

/** One completed OHLCV(+OI) candle, timestamps are ms epoch (UTC). */
export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number; // 0 when the exchange gives no volume (indices)
  oi?: number | null; // open interest (futures/options rows only)
}

export type DataQuality = "valid" | "partial" | "stale" | "warming_up" | "unavailable";

export type ZoneId = "overbought" | "bullish" | "equilibrium" | "bearish" | "oversold";

export type MomentumState =
  | "bullish_acceleration"
  | "bullish_continuation"
  | "bullish_momentum"
  | "bullish_exhaustion"
  | "bullish_reversal_watch"
  | "bearish_acceleration"
  | "bearish_continuation"
  | "bearish_momentum"
  | "bearish_exhaustion"
  | "bearish_reversal_watch"
  /** counter-trend bounce inside a downtrend — NOT a bullish signal */
  | "bearish_pullback"
  /** counter-trend dip inside an uptrend — NOT a bearish signal */
  | "bullish_pullback"
  | "neutral"
  | "transition"
  | "conflicting_signals"
  | "insufficient_data";

export type ComponentKey =
  | "price_pressure"
  | "volume_participation"
  | "futures_positioning"
  | "options_positioning"
  | "price_structure"
  | "acceleration_persistence";

export interface ComponentReading {
  /** normalized direction-aware score in [-1, 1]; null when unavailable */
  score: number | null;
  available: boolean;
  /** causal explanation fragments computed from actual measurements */
  evidence: string[];
}

export interface ZoneBoundaries {
  oversoldLower: number; // q05  – floor marker of extreme lower tail
  oversoldUpper: number; // q15  – upper edge of oversold zone
  equilibriumLower: number; // q40
  equilibriumUpper: number; // q60
  overboughtLower: number; // q85 – lower edge of overbought zone
  overboughtUpper: number; // q95 – ceiling marker of extreme upper tail
  samples: number; // observation count used (truthfulness for warm-up)
}

export interface TurningPoint {
  kind: "peak" | "trough";
  index: number; // candle index of the pivot
  ts: number;
  value: number;
  confirmed: boolean; // candidates render hollow until confirmed
  confirmedTs: number | null; // when the turn became knowable (never backdated)
}

export type Divergence = "bullish" | "bearish" | "developing_bullish" | "developing_bearish" | "none";

export interface FmpiPoint {
  ts: number;
  /** provisional = built from the still-forming live candle */
  provisional: boolean;
  value: number; // smoothed FMPI 0..100
  raw: number; // unsmoothed logistic/percentile blend (pre-EMA)
  change: number | null; // vs previous completed point
  slope: number | null; // normalized -1..1
  acceleration: number | null;
  zone: ZoneId | null;
  zoneBoundaries: ZoneBoundaries | null;
  state: MomentumState;
  divergence: Divergence | null;
  continuationScore: number | null; // 0..100
  exhaustionScore: number | null; // 0..100
  coverage: number; // 0..1 share of configured component weight available
  /** dominant trend context used to damp counter-trend spikes */
  regime: {
    label: string;
    direction: -1 | 0 | 1;
    strength: number;
    pullback: boolean;
  } | null;
  missingComponents: ComponentKey[];
  components: Record<ComponentKey, ComponentReading>;
  quality: DataQuality;
  explanation: string[];
}

export interface InstrumentMeta {
  instrumentKey: string; // e.g. NSE_EQ|INE002A01018, NSE_INDEX|Nifty 50
  symbol: string; // RELIANCE, NIFTY, SENSEX
  name: string;
  exchange: "NSE" | "BSE";
  segment: "index" | "fno";
  /** nearest-expiry futures key when one exists (enables futures component) */
  futuresKey?: string | null;
  futuresExpiryTs?: number | null;
  lotSize?: number | null;
}

export interface FmpiSeriesPayload {
  engineVersion: string;
  instrument: InstrumentMeta;
  timeframe: Timeframe;
  timezone: "Asia/Kolkata";
  candles: Candle[];
  points: FmpiPoint[];
  turningPoints: TurningPoint[];
  zones: ZoneBoundaries | null; // boundaries of the last completed point
  latest: FmpiPoint | null;
  /** combined 5m/10m conflict view (filled when the other tf was computed) */
  peer: { timeframe: Timeframe; value: number; zone: ZoneId | null; state: MomentumState } | null;
  combinedState: MomentumState | null;
  marketState: "open" | "closed" | "pre_open" | "post_close";
  futures: {
    used: boolean; instrumentKey?: string; expiryTs?: number; note?: string;
    /** latest futures close & basis vs spot, when both genuinely exist */
    lastClose?: number; basisPct?: number;
  };
  /** futures closes aligned to spot timestamps — basis overlay on the price panel */
  futuresSeries?: { ts: number; close: number }[];
  options: { used: boolean; note: string; expiry?: string; contracts?: number };
  dataSource: string;
  generatedAt: string;
}

export interface ScanRow {
  instrument: InstrumentMeta;
  value: number | null;
  change: number | null;
  slope: number | null;
  zone: ZoneId | null;
  state: MomentumState;
  quality: DataQuality;
  ts: number | null;
}

/** Optional aligned context per candle (futures contract of same underlying). */
export interface FuturesFrame {
  /** map from candle ts → futures candle (same timeframe, same alignment) */
  byTs: Map<number, Candle>;
  spotTs: Set<number>; // timestamps where a spot candle existed (premium calc)
}

export interface EngineConfig {
  weights: Record<ComponentKey, number>; // sums to 1.0
  logisticK: number; // logistic steepness for composite → 0..100
  percentileBlend: number; // 0..1 weight of rolling-percentile transform
  percentileWindow: number; // candles
  percentileMinSamples: number;
  zoneWindow: number; // rolling FMPI obs for zone quantiles
  zoneMinSamples: number; // warm-up before zones appear
  zoneQuantiles: [number, number, number, number, number, number]; // 5,15,40,60,85,95
  zoneSmoothing: number; // EMA factor applied to boundaries (anti-jump)
  smoothingAlpha: Record<Timeframe, number>; // causal EMA of FMPI
  volLookback: number; // candles for sigma of returns
  volumeLookback: number;
  structureLookback: number; // swing/structure window
  atrLookback: number;
  slopeWindow: number; // bars for slope
  accelWindow: number;
  swingConfirmBars: number; // k bars after pivot before confirmation
  swingNoise: number; // min absolute FMPI move (points) to count as swing
  swingProminence: number; // min prominence floor (points)
  swingLookback: number; // bars either side used to measure prominence
  divergenceMinSeparation: number; // bars between compared swings
  divergenceMinDiff: number; // min FMPI difference between two swings
  minCandles: number; // below → insufficient_data
  minCoverage: number; // below → partial quality, shrunk composite

  /* trend-regime layer */
  regimeFast: number; // fast EMA period (bars)
  regimeSlow: number; // slow EMA period (bars)
  regimeSlopeWindow: number; // bars used for the slow-EMA slope
  regimeMinStrength: number; // below → rangebound, no regime applied
  regimeAnchor: number; // 0..1 share of composite anchored to the regime
  counterTrendDamping: number; // 0..1 damping of counter-regime pressure
  regimeFlipBars: number; // consecutive counter-regime bars before a flip
}
