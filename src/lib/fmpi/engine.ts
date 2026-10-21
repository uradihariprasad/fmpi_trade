/**
 * FMPI engine — deterministic, causal, instrument-aware.
 *
 * Pipeline per completed candle i:
 *   components (each [-1,1]) → weighted composite over available weights
 *   → confidence shrink by coverage → logistic(k) blended with rolling
 *   percentile → causal EMA smoothing → change/slope/acceleration
 *   → rolling-quantile dynamic zones (EMA-smoothed, monotone-enforced)
 *   → swing pivots (candidate → prominence-confirmed)
 *   → divergence check on confirmed pivots → momentum state + scores
 *   → evidence-based explanation.
 *
 * No lookup ahead anywhere: slicing is always ≤ i. This property is
 * asserted by unit tests (prefix-invariance) and by the replay API.
 */
import type {
  Candle, ComponentKey, ComponentReading, DataQuality, Divergence, EngineConfig,
  FmpiPoint, FuturesFrame, MomentumState, Timeframe, TurningPoint, ZoneBoundaries, ZoneId,
} from "./types";
import { Ema, Ring, clamp, logistic, median, percentileRank, quantile } from "./math";
import * as comp from "./components";
import { computeRegimes, REGIME_LABEL, type RegimeReading } from "./regime";
import { ENGINE_VERSION } from "./types";

const ALL_COMPONENTS: ComponentKey[] = [
  "price_pressure", "volume_participation", "futures_positioning",
  "options_positioning", "price_structure", "acceleration_persistence",
];

export interface SeriesResult {
  engineVersion: string;
  points: FmpiPoint[];
  turningPoints: TurningPoint[];
  zones: ZoneBoundaries | null;
}

interface PendingCandidate {
  kind: "peak" | "trough";
  index: number;
  ts: number;
  value: number;
}

export function computeSeries(
  candles: Candle[],
  timeframe: Timeframe,
  cfg: EngineConfig,
  futures: FuturesFrame | null = null,
  optionsReading: ((i: number) => ComponentReading | null) | null = null,
  provisionalCount = 0,
): SeriesResult {
  const n = candles.length;
  const points: FmpiPoint[] = [];
  const sm = new Ema(cfg.smoothingAlpha[timeframe]);
  const pctlWindow = new Ring(cfg.percentileWindow);
  const zoneWindow = new Ring(cfg.zoneWindow);
  const values: number[] = [];
  let zoneSm: ZoneBoundaries | null = null;
  const confirmed: TurningPoint[] = [];
  let candidates: PendingCandidate[] = [];

  const regimes = computeRegimes(candles, cfg);
  let counterStreak = 0;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const k = cfg.swingConfirmBars;

  const zonesFrom = (win: Ring): ZoneBoundaries | null => {
    if (win.size < cfg.zoneMinSamples) return null;
    const s = win.sorted();
    const [q5, q15, q40, q60, q85, q95] = cfg.zoneQuantiles;
    return {
      oversoldLower: quantile(s, q5),
      oversoldUpper: quantile(s, q15),
      equilibriumLower: quantile(s, q40),
      equilibriumUpper: quantile(s, q60),
      overboughtLower: quantile(s, q85),
      overboughtUpper: quantile(s, q95),
      samples: win.size,
    };
  };

  const smoothZones = (raw: ZoneBoundaries | null): ZoneBoundaries | null => {
    if (!raw) return zoneSm;
    if (!zoneSm) { zoneSm = { ...raw }; return zoneSm; }
    const b = cfg.zoneSmoothing;
    const keys: (keyof ZoneBoundaries)[] = [
      "oversoldLower", "oversoldUpper", "equilibriumLower",
      "equilibriumUpper", "overboughtLower", "overboughtUpper",
    ];
    const next = { ...zoneSm, samples: raw.samples };
    for (const key of keys) next[key] = (1 - b) * zoneSm[key] + b * raw[key];
    // anti-jump: quantile boundaries must stay ordered with a minimum gap
    const GAP = 0.4;
    next.oversoldUpper = Math.max(next.oversoldUpper, next.oversoldLower + GAP);
    next.equilibriumLower = Math.max(next.equilibriumLower, next.oversoldUpper + GAP);
    next.equilibriumUpper = Math.max(next.equilibriumUpper, next.equilibriumLower + GAP);
    next.overboughtLower = Math.max(next.overboughtLower, next.equilibriumUpper + GAP);
    next.overboughtUpper = Math.max(next.overboughtUpper, next.overboughtLower + GAP);
    zoneSm = next;
    return zoneSm;
  };

  const zoneOf = (v: number, z: ZoneBoundaries | null): ZoneId | null => {
    if (!z) return null;
    if (v >= z.overboughtLower) return "overbought";
    if (v <= z.oversoldUpper) return "oversold";
    if (v >= z.equilibriumUpper) return "bullish";
    if (v <= z.equilibriumLower) return "bearish";
    return "equilibrium";
  };

  const slopeAt = (idx: number): number | null => {
    const w = cfg.slopeWindow;
    if (idx < w || values[idx - w] == null) return null;
    return clamp((values[idx] - values[idx - w]) / 12, -1, 1);
  };
  const accelAt = (idx: number): number | null => {
    const s1 = slopeAt(idx); const s0 = slopeAt(idx - cfg.accelWindow);
    return s1 == null || s0 == null ? null : clamp(s1 - s0, -2, 2) / 2;
  };

  /* Swing thresholds scale with the instrument's own observed FMPI
     dispersion. Fixed point thresholds do not transfer between a placid
     index and a volatile midcap, and they stop confirming pivots
     altogether whenever the curve compresses (for example when a major
     component is unavailable). Causal: derived only from past values. */
  /* Significance is decided by PROMINENCE over a wide window, scaled to
     the instrument's own FMPI dispersion. A narrow local-range gate was
     removed deliberately: it rejected smooth, rounded tops (where the
     ±3-bar range is tiny) while adding nothing the prominence test does
     not already enforce. Causal — past observations only. */
  const swingProminenceGate = (): number => {
    if (zoneWindow.size < 30) return cfg.swingProminence;
    const deltas: number[] = [];
    for (let k = Math.max(1, values.length - 100); k < values.length; k++) {
      deltas.push(Math.abs(values[k] - values[k - 1]));
    }
    const medDelta = deltas.length ? median(deltas) : 0;
    const sorted = zoneWindow.sorted();
    const iqr = quantile(sorted, 75) - quantile(sorted, 25);
    // must clear both the dispersion-scaled bar and plain bar-to-bar noise
    return Math.max(clamp(0.35 * iqr, cfg.swingProminence, 10), 3 * medDelta);
  };

  const evaluatePivots = (i: number) => {
    const swingProminence = swingProminenceGate();
    // candidate check for pivot at j = i - k, using only observations ≤ i
    const j = i - k;
    if (j - k >= 0) {
      const v = values[j];
      let isPeak = true, isTrough = true;
      for (let d = 1; d <= k; d++) {
        if (values[j - d] >= v || values[j + d] > v) isPeak = false;
        if (values[j - d] <= v || values[j + d] < v) isTrough = false;
      }
      const loWin = Math.min(...values.slice(j - k, j + k + 1));
      const hiWin = Math.max(...values.slice(j - k, j + k + 1));
      if (isPeak && v > loWin && !candidates.some((c) => c.index === j)) {
        candidates.push({ kind: "peak", index: j, ts: candles[j].ts, value: v });
      }
      if (isTrough && hiWin > v && !candidates.some((c) => c.index === j)) {
        candidates.push({ kind: "trough", index: j, ts: candles[j].ts, value: v });
      }
    }
    // prominence confirmation with whatever right-hand data exists (≤ i)
    const stillPending: PendingCandidate[] = [];
    for (const cand of candidates) {
      if (confirmed.some((t) => t.index === cand.index)) continue;
      /* A turning point is confirmed by the REVERSAL THAT FOLLOWS it.
         Classical two-sided prominence was abandoned here because a long
         plateau before a top caps the measurement and hides obvious
         peaks; what matters for momentum is how far pressure travelled
         back the other way. Right-hand data only, so nothing is known
         before it happens. */
      const W = cfg.swingLookback;
      const right = values.slice(cand.index + 1, Math.min(i + 1, cand.index + W + 1));
      if (right.length === 0) { stillPending.push(cand); continue; }
      const prominence =
        cand.kind === "peak"
          ? cand.value - Math.min(...right)
          : Math.max(...right) - cand.value;
      if (prominence >= swingProminence) {
        confirmed.push({
          kind: cand.kind, index: cand.index, ts: cand.ts,
          value: Math.round(cand.value * 10) / 10,
          confirmed: true, confirmedTs: candles[Math.min(i, n - 1)].ts,
        });
      } else if (i - cand.index <= cfg.swingLookback) {
        /* Keep the candidate alive until its prominence window has fully
           formed. Expiring sooner discarded genuine major pivots whose
           right-hand side simply had not developed yet. */
        stillPending.push(cand);
      }
    }
    candidates = stillPending.filter((c) => !confirmed.some((t) => t.index === c.index));
  };

  const lastPivots = (kind: "peak" | "trough"): TurningPoint[] =>
    confirmed.filter((t) => t.kind === kind).slice(-3);

  const divergenceAt = (i: number): Divergence => {
    const sep = cfg.divergenceMinSeparation;
    const dd = cfg.divergenceMinDiff;
    const pk = lastPivots("peak");
    if (pk.length >= 2) {
      const [a, b] = pk.slice(-2);
      if (b.index - a.index >= sep && highs[b.index] > highs[a.index] && b.value < a.value - dd) {
        if (i - b.index <= 25) return "bearish";
      }
    }
    const tr = lastPivots("trough");
    if (tr.length >= 2) {
      const [a, b] = tr.slice(-2);
      if (b.index - a.index >= sep && lows[b.index] < lows[a.index] && b.value > a.value + dd) {
        if (i - b.index <= 25) return "bullish";
      }
    }
    // developing: unconfirmed candidate forming the same pattern
    const lastCand = candidates[candidates.length - 1];
    if (lastCand && i - lastCand.index <= 8) {
      const prevPeak = pk[pk.length - 1]; const prevTr = tr[tr.length - 1];
      if (lastCand.kind === "peak" && prevPeak && lastCand.index - prevPeak.index >= sep &&
          highs[lastCand.index] > highs[prevPeak.index] && lastCand.value < prevPeak.value - dd) {
        return "developing_bearish";
      }
      if (lastCand.kind === "trough" && prevTr && lastCand.index - prevTr.index >= sep &&
          lows[lastCand.index] < lows[prevTr.index] && lastCand.value > prevTr.value + dd) {
        return "developing_bullish";
      }
    }
    return "none";
  };

  const equilibriumCrossings = (i: number, z: ZoneBoundaries | null): number => {
    if (!z) return 0;
    const lo = z.equilibriumLower, hi = z.equilibriumUpper;
    let crosses = 0;
    let prevSide = 0;
    for (let j = Math.max(0, i - 12); j <= i; j++) {
      const v = values[j];
      const side = v > hi ? 1 : v < lo ? -1 : 0;
      if (side !== 0 && prevSide !== 0 && side !== prevSide) crosses++;
      if (side !== 0) prevSide = side;
    }
    return crosses;
  };

  for (let i = 0; i < n; i++) {
    const provisional = i >= n - provisionalCount;
    const readings: Record<ComponentKey, ComponentReading> = {
      price_pressure: comp.pricePressure(candles, i, cfg),
      volume_participation: comp.volumeParticipation(candles, i, cfg),
      futures_positioning: comp.futuresPositioning(candles, i, futures),
      options_positioning: comp.optionsPositioning(optionsReading ? optionsReading(i) : null),
      price_structure: comp.priceStructure(candles, i, cfg),
      acceleration_persistence: comp.accelerationPersistence(candles, i, cfg),
    };

    const missing = ALL_COMPONENTS.filter((k2) => !readings[k2].available);
    let wSum = 0, acc = 0;
    for (const key of ALL_COMPONENTS) {
      const r = readings[key];
      if (r.available && r.score != null) { acc += cfg.weights[key] * r.score; wSum += cfg.weights[key]; }
    }
    const coverage = wSum; // weights sum to 1.0 by configuration
    const hasPrice = readings.price_pressure.available && readings.price_pressure.score != null;

    let quality: DataQuality;
    if (i < cfg.minCandles) quality = "warming_up";
    else if (!hasPrice) quality = "unavailable";
    else if (coverage < cfg.minCoverage) quality = "partial";
    else quality = "valid";

    // composite → confidence shrink → bounded transform (documented mapping)
    const composite = hasPrice && wSum > 0 ? (acc / wSum) * (0.55 + 0.45 * clamp(coverage, 0, 1)) : 0;

    /* Trend-regime anchoring (v2).
       A retest bounce inside a downtrend turns several short-window
       components positive at once. Anchoring part of the composite to the
       dominant regime, then damping whatever still opposes it, keeps a
       pullback from reading as a reversal while leaving a genuine regime
       change free to come through once the evidence persists. */
    const regime = regimes[i];
    let anchored = composite;
    if (hasPrice && regime.direction !== 0) {
      anchored = composite * (1 - cfg.regimeAnchor) + regime.bias * cfg.regimeAnchor;
      if (Math.sign(anchored) !== 0 && Math.sign(anchored) !== regime.direction) {
        anchored *= 1 - cfg.counterTrendDamping * regime.strength;
      }
    }

    pctlWindow.push(anchored);
    const logi = 100 * logistic(cfg.logisticK * anchored);
    const pctl = pctlWindow.size >= cfg.percentileMinSamples ? 100 * percentileRank(pctlWindow.values, anchored) : 50;
    const raw = (1 - cfg.percentileBlend) * logi + cfg.percentileBlend * pctl;
    const V = clamp(sm.next(raw), 0, 100);
    values.push(V);
    zoneWindow.push(V);
    const zb = smoothZones(zonesFrom(zoneWindow));
    const zone = zoneOf(V, zb);
    const change = i > 0 ? V - values[i - 1] : null;
    const slope = slopeAt(i);
    const accel = accelAt(i);
    evaluatePivots(i);
    const divergence = i > cfg.structureLookback ? divergenceAt(i) : "none";

    // Consecutive bars whose zone opposes the regime. A genuine flip has
    // to sustain; two or three bars of bounce never qualifies.
    const zoneDir = zone === "overbought" || zone === "bullish" ? 1
      : zone === "oversold" || zone === "bearish" ? -1 : 0;
    if (regime.direction !== 0 && zoneDir !== 0 && zoneDir !== regime.direction) counterStreak++;
    else if (zoneDir === regime.direction) counterStreak = 0;

    const { state, continuation, exhaustion } = classify({
      i, value: V, zone, slope, accel, cfg, zb,
      readings, divergence, closes,
      chopCrossings: equilibriumCrossings(i, zb),
      quality, regime, counterStreak,
    });

    points.push({
      ts: candles[i].ts, provisional,
      value: Math.round(V * 100) / 100,
      raw: Math.round(raw * 100) / 100,
      change: change == null ? null : Math.round(change * 100) / 100,
      slope: slope == null ? null : Math.round(slope * 1000) / 1000,
      acceleration: accel == null ? null : Math.round(accel * 1000) / 1000,
      zone, zoneBoundaries: zb ? { ...zb } : null,
      state, divergence,
      continuationScore: continuation, exhaustionScore: exhaustion,
      coverage: Math.round(coverage * 1000) / 1000,
      regime: {
        label: REGIME_LABEL[regime.label],
        direction: regime.direction,
        strength: Math.round(regime.strength * 100) / 100,
        pullback: regime.pullback,
      },
      missingComponents: missing, components: readings, quality,
      explanation: buildExplanation(V, zone, slope, accel, change, readings, divergence, state, quality, coverage, regime),
    });
  }

  const turningPoints: TurningPoint[] = [
    ...confirmed,
    ...candidates.map((c) => ({ ...c, confirmed: false, confirmedTs: null as null })),
  ].sort((a, b) => a.index - b.index);

  return {
    engineVersion: ENGINE_VERSION,
    points,
    turningPoints: turningPoints.map((t) => ({
      ...t,
      value: Math.round(t.value * 10) / 10,
    })),
    zones: points.length ? (points[points.length - 1].zoneBoundaries ?? null) : null,
  };
}

/* ------------------------------------------------------------------ */

interface ClassifyInput {
  i: number; value: number; zone: ZoneId | null;
  slope: number | null; accel: number | null; cfg: EngineConfig;
  zb: ZoneBoundaries | null;
  readings: Record<ComponentKey, ComponentReading>;
  divergence: Divergence; closes: number[];
  chopCrossings: number; quality: DataQuality;
  regime: RegimeReading; counterStreak: number;
}

function classify(x: ClassifyInput): {
  state: MomentumState; continuation: number | null; exhaustion: number | null;
} {
  if (x.quality === "warming_up" || x.quality === "unavailable" || x.zone === null ||
      x.slope == null || x.accel == null) {
    return { state: "insufficient_data", continuation: null, exhaustion: null };
  }
  const slope = x.slope, accel = x.accel;
  const structScore = x.readings.price_structure.score ?? 0;
  const volAvailable = x.readings.volume_participation.available;
  const volScore = x.readings.volume_participation.score ?? 0;
  const futScore = x.readings.futures_positioning.available ? (x.readings.futures_positioning.score ?? 0) : 0;
  const bull = x.zone === "overbought" || x.zone === "bullish";
  const bear = x.zone === "oversold" || x.zone === "bearish";
  const upper = x.zone === "overbought";
  const lower = x.zone === "oversold";
  const div = x.divergence;

  // choppy tape: repeated equilibrium crossings with weak slope
  if (x.chopCrossings >= 3 && Math.abs(slope) < 0.18) {
    return { state: "neutral", continuation: 35, exhaustion: 35 };
  }

  const dir = bull ? 1 : bear ? -1 : slope > 0 ? 1 : -1;
  // continuation & exhaustion evidence, symmetric around direction `dir`
  const structureOk = dir > 0 ? structScore > -0.05 : structScore < 0.05;
  const volOk = !volAvailable || (dir > 0 ? volScore > -0.25 : volScore < 0.25); // missing vol never blocks
  const futOk = dir > 0 ? futScore >= -0.1 : futScore <= 0.1;
  const divAgainst = dir > 0 ? div === "bearish" || div === "developing_bearish"
                             : div === "bullish" || div === "developing_bullish";

  let cont = 50;
  cont += (dir * slope > 0 ? 18 : -18) + (dir * accel > 0 ? 10 : -6);
  cont += structureOk ? 12 : -12;
  cont += volOk ? 8 : -10;
  cont += futOk ? 4 : -6;
  cont += upper || lower ? 4 : 0; // extreme zone + persisting = trend evidence, NOT auto-reversal
  cont = clamp(cont, 0, 100);

  let exh = 30;
  exh += dir * accel < -0.02 ? 20 : 0; // acceleration flipping against direction
  exh += dir * slope < 0 ? 16 : dir * slope < 0.1 ? 7 : 0; // slope decay
  exh += !volOk ? 14 : 0; // participation fading
  exh += !structureOk ? 10 : 0;
  exh += divAgainst ? 18 : 0;
  exh = clamp(exh, 0, 100);

  const weakening = exh >= 55;
  const strongTrend = cont >= 62;

  /* COUNTER-TREND GUARD — the core v2 fix.
     If the reading opposes an established regime and has not sustained
     for `regimeFlipBars`, it is a pullback inside the prevailing trend,
     not a reversal or a continuation of the opposite side. */
  if (x.regime.direction !== 0 && x.regime.strength >= x.cfg.regimeMinStrength) {
    // Direction implied by the whole reading, not just the zone: a bounce
    // can sit inside equilibrium while the slope points the other way.
    const stateDir = bull ? 1 : bear ? -1 : Math.abs(slope) > 0.22 ? Math.sign(slope) : 0;
    if (stateDir !== 0 && stateDir !== x.regime.direction && x.counterStreak < x.cfg.regimeFlipBars) {
      return {
        state: x.regime.direction < 0 ? "bearish_pullback" : "bullish_pullback",
        // conviction in CONTINUATION of the prevailing trend is unchanged;
        // the bounce itself is not promoted to a tradable signal
        continuation: Math.round(clamp(cont * 0.6, 0, 100)),
        exhaustion: Math.round(exh),
      };
    }
  }

  if (bull) {
    if (!weakening && strongTrend) {
      return {
        state: dir * accel > 0.05 && slope > 0.3 ? "bullish_acceleration" : "bullish_continuation",
        continuation: Math.round(cont), exhaustion: Math.round(exh),
      };
    }
    if (weakening) {
      // spec: reversal watch requires corroborating divergence — an extreme
      // reading or weakening alone is never promoted to reversal
      const reversalEvidence = divAgainst && exh >= 58;
      return {
        state: reversalEvidence ? "bullish_reversal_watch" : "bullish_exhaustion",
        continuation: Math.round(cont), exhaustion: Math.round(exh),
      };
    }
    return { state: "bullish_momentum", continuation: Math.round(cont), exhaustion: Math.round(exh) };
  }
  if (bear) {
    if (!weakening && strongTrend) {
      return {
        state: dir * accel > 0.05 && dir * slope > 0.3 ? "bearish_acceleration" : "bearish_continuation",
        continuation: Math.round(cont), exhaustion: Math.round(exh),
      };
    }
    if (weakening) {
      const reversalEvidence = divAgainst && exh >= 58;
      return {
        state: reversalEvidence ? "bearish_reversal_watch" : "bearish_exhaustion",
        continuation: Math.round(cont), exhaustion: Math.round(exh),
      };
    }
    return { state: "bearish_momentum", continuation: Math.round(cont), exhaustion: Math.round(exh) };
  }
  // equilibrium neighbourhood
  if (Math.abs(slope) > 0.22) {
    return {
      state: slope > 0 ? "bullish_momentum" : "bearish_momentum",
      continuation: Math.round(cont), exhaustion: Math.round(exh),
    };
  }
  return { state: "transition", continuation: Math.round(cont), exhaustion: Math.round(exh) };
}

/* ------------------------------------------------------------------ */

function buildExplanation(
  value: number, zone: ZoneId | null, slope: number | null, accel: number | null,
  change: number | null, r: Record<ComponentKey, ComponentReading>,
  divergence: Divergence, state: MomentumState, quality: DataQuality, coverage: number,
  regime: RegimeReading,
): string[] {
  const out: string[] = [];
  if (quality === "warming_up") {
    out.push("Engine warming up — not enough completed candles yet for calibrated pressure statistics.");
    return out;
  }
  if (quality === "unavailable") {
    out.push("Core price input unavailable for this candle — FMPI is not published rather than fabricated.");
    return out;
  }
  const dirTxt = slope == null ? "flat" : slope > 0.05 ? "rising" : slope < -0.05 ? "falling" : "flat";
  out.push(
    `FMPI ${value.toFixed(1)} (${zone ?? "no-zone"}) is ${dirTxt}` +
    (change != null ? ` by ${Math.abs(change).toFixed(1)} pts` : "") +
    (accel != null && Math.abs(accel) > 0.02 ? ` with ${accel > 0 ? "positive" : "negative"} acceleration.` : "."),
  );
  if (regime.direction !== 0) {
    out.push(
      `Trend context: ${REGIME_LABEL[regime.label].toLowerCase()} (strength ${regime.strength.toFixed(2)})` +
      (regime.pullback ? " — price is currently counter-trending against it." : "."),
    );
  }
  if (state === "bearish_pullback") {
    out.push("This is a PULLBACK inside a downtrend, not a reversal: upward pressure has not persisted long enough to flip the regime. Treat strength here as a retest, not a buy signal.");
  }
  if (state === "bullish_pullback") {
    out.push("This is a PULLBACK inside an uptrend, not a breakdown: downward pressure has not persisted long enough to flip the regime.");
  }
  const zoneMeaning: Record<ZoneId, string> = {
    overbought: "Pressure is in the dynamic overbought zone — unusually strong positive pressure. This is continuation evidence, not an automatic sell.",
    bullish: "Pressure is in the strong bullish zone, above the empirical centre of recent readings.",
    equilibrium: "Pressure sits inside the equilibrium band — supply and demand are relatively balanced.",
    bearish: "Pressure is in the strong bearish zone, below the empirical centre of recent readings.",
    oversold: "Pressure is in the dynamic oversold zone — unusually strong negative pressure. This is continuation evidence, not an automatic buy.",
  };
  if (zone) out.push(zoneMeaning[zone]);
  if (state.includes("exhaustion"))
    out.push("Exhaustion evidence building: slope/acceleration are working against the prevailing pressure while participation or structure weakens. Reversal is watched, not confirmed.");
  if (state.includes("reversal_watch"))
    out.push("Reversal watch: divergence plus structure deterioration corroborate weakening pressure — still evidence, not a prediction.");
  if (state.includes("continuation") || state.includes("acceleration"))
    out.push("Continuation supported: slope, structure and participation remain aligned with prevailing pressure. High/low FMPI can persist in trends.");
  if (divergence === "bearish" || divergence === "developing_bearish")
    out.push(`${divergence === "bearish" ? "Confirmed" : "Developing"} bearish divergence: price printed a higher high while FMPI printed a lower high.`);
  if (divergence === "bullish" || divergence === "developing_bullish")
    out.push(`${divergence === "bullish" ? "Confirmed" : "Developing"} bullish divergence: price printed a lower low while FMPI printed a higher low.`);
  const vol = r.volume_participation;
  if (!vol.available) out.push("Volume evidence excluded (exchange supplies no usable volume here — e.g. index); weight renormed honestly.");
  const fut = r.futures_positioning;
  if (!fut.available) out.push("Futures/OI evidence excluded (no aligned futures snapshot); never substituted with zeros.");
  if (!r.options_positioning.available) out.push("Options positioning excluded for this candle — no usable CE/PE open interest; shown as missing, weighted 0.");
  if (quality === "partial")
    out.push(`Effective component coverage ${(coverage * 100).toFixed(0)}% — composite shrunk toward neutral by the coverage factor.`);
  return out.slice(0, 7);
}

/** Combine 5m and 10m snapshots into the multi-timeframe state (Scenario E). */
export function combineStates(
  a: { value: number; zone: ZoneId | null; state: MomentumState } | null,
  b: { value: number; zone: ZoneId | null; state: MomentumState } | null,
): { combined: MomentumState; note: string } {
  if (!a || !b || !a.zone || !b.zone) return { combined: "insufficient_data", note: "one timeframe is not ready" };
  const aBull = a.zone === "overbought" || a.zone === "bullish";
  const aBear = a.zone === "oversold" || a.zone === "bearish";
  const bBull = b.zone === "overbought" || b.zone === "bullish";
  const bBear = b.zone === "oversold" || b.zone === "bearish";
  if ((aBull && bBear) || (aBear && bBull)) {
    return {
      combined: "conflicting_signals",
      note: `5M pressure is ${aBull ? "bullish" : "bearish"} while 10M is ${bBull ? "bullish" : "bearish"} — timeframes disagree; confidence reduced. Neither reading is overwritten.`,
    };
  }
  /* Agreement is judged on DIRECTION, not on exact zone identity.
     5M oversold against 10M bearish is the same bearish message at
     different intensities; calling that "transition" masked an otherwise
     unambiguous read. Only a genuinely undecided higher timeframe, or an
     explicit transition state, downgrades the combined view. */
  const aDir = aBull ? 1 : aBear ? -1 : 0;
  const bDir = bBull ? 1 : bBear ? -1 : 0;
  if (aDir !== 0 && aDir === bDir) {
    return {
      combined: a.state,
      note: a.zone === b.zone
        ? "5M and 10M confirm each other"
        : "5M and 10M agree on direction, at different intensities",
    };
  }
  return {
    combined: "transition",
    note: aDir === 0 || bDir === 0
      ? "one timeframe is still inside equilibrium — direction not yet established"
      : "timeframes agree on direction but not on strength",
  };
}
