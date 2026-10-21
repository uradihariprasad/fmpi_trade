/**
 * Strike-level analysis — ATM ±3 strikes.
 *
 * Reads the genuine per-candle open interest of the CE/PE contracts three
 * strikes either side of the money and derives:
 *
 *   • SUPPORT      — the heaviest PE open interest at or below spot.
 *                    Put writers must defend that strike, so it behaves as
 *                    a floor while the position is being added to.
 *   • RESISTANCE   — the heaviest CE open interest at or above spot.
 *                    Call writers cap the move while they keep writing.
 *   • WALL DYNAMICS — whether each wall is BUILDING (ΔOI up, defenders
 *                    adding) or UNWINDING (ΔOI down, defenders covering).
 *                    An unwinding wall in the direction of travel is the
 *                    strongest continuation evidence the chain offers.
 *   • VERDICT      — continuation, reversal from a wall, breakout,
 *                    breakdown or rangebound.
 *
 * Causal: bar i is compared only with bar i-1. Nothing is inferred from
 * data that did not exist at that candle.
 */
import type { Candle } from "./types";
import type { OptionsFrame } from "@/lib/market/optionsFrame";
import { clamp } from "./math";

/** Strikes either side of ATM — the ±3 band. */
export const BAND_RADIUS = 3;
const EPS = 1e-9;

export type LevelVerdict =
  | "breakout"
  | "breakdown"
  | "continuation_up"
  | "continuation_down"
  | "reversal_from_resistance"
  | "reversal_from_support"
  | "range_bound"
  | "undecided";

export interface StrikeRow {
  strike: number;
  offset: number; // strikes from ATM, signed
  ceOi: number;
  peOi: number;
  ceDOi: number;
  peDOi: number;
  ceVol: number;
  peVol: number;
}

export interface Wall {
  strike: number;
  oi: number;
  dOi: number;
  /** ΔOI as a share of the wall's own OI */
  changePct: number;
  state: "building" | "unwinding" | "steady";
  distancePct: number; // signed distance of spot from the wall
}

export interface StrikeAnalysis {
  expiryDate: string;
  atm: number;
  step: number;
  spot: number;
  rows: StrikeRow[];
  support: Wall | null;
  resistance: Wall | null;
  /** 0 at the support wall, 1 at the resistance wall */
  positionInRange: number | null;
  verdict: LevelVerdict;
  /** -1 (bearish) … +1 (bullish) from the levels alone */
  bias: number;
  bandPcr: number | null;
  notes: string[];
}

function wallOf(
  strike: number, oi: number, dOi: number, spot: number,
): Wall {
  const changePct = oi > EPS ? (dOi / oi) * 100 : 0;
  return {
    strike, oi, dOi,
    changePct,
    state: changePct > 0.5 ? "building" : changePct < -0.5 ? "unwinding" : "steady",
    distancePct: ((strike - spot) / spot) * 100,
  };
}

/**
 * Builds the ±3 strike picture for candle `i`.
 * Returns null when the chain cannot support the analysis — never a
 * fabricated level.
 */
export function analyzeStrikes(
  frame: OptionsFrame | null,
  candles: Candle[],
  i: number,
): StrikeAnalysis | null {
  if (!frame) return null;
  const bar = candles[i];
  if (!bar || bar.ts < frame.from) return null;

  // ATM from this candle's own close.
  let atm = frame.strikes[0];
  let best = Infinity;
  for (const s of frame.strikes) {
    const d = Math.abs(s - bar.close);
    if (d < best) { best = d; atm = s; }
  }

  const band = frame.strikes.filter(
    (s) => Math.abs(s - atm) <= frame.strikeStep * BAND_RADIUS + frame.strikeStep * 0.5,
  );
  if (band.length < 3) return null;

  const prevTs = i > 0 ? candles[i - 1].ts : null;
  const rows: StrikeRow[] = [];
  let totalCeOi = 0, totalPeOi = 0;

  for (const strike of band) {
    const c = frame.ce.get(strike)?.get(bar.ts);
    const p = frame.pe.get(strike)?.get(bar.ts);
    if (!c && !p) continue;
    const cPrev = prevTs !== null ? frame.ce.get(strike)?.get(prevTs) : undefined;
    const pPrev = prevTs !== null ? frame.pe.get(strike)?.get(prevTs) : undefined;
    const row: StrikeRow = {
      strike,
      offset: Math.round((strike - atm) / Math.max(frame.strikeStep, EPS)),
      ceOi: c?.oi ?? 0,
      peOi: p?.oi ?? 0,
      ceDOi: c && cPrev ? c.oi - cPrev.oi : 0,
      peDOi: p && pPrev ? p.oi - pPrev.oi : 0,
      ceVol: c?.vol ?? 0,
      peVol: p?.vol ?? 0,
    };
    rows.push(row);
    totalCeOi += row.ceOi;
    totalPeOi += row.peOi;
  }
  if (rows.length < 3) return null;

  // Walls inside the ±3 band.
  let resistance: Wall | null = null;
  let support: Wall | null = null;
  let maxCe = 0, maxPe = 0;
  for (const r of rows) {
    if (r.strike >= bar.close && r.ceOi > maxCe) {
      maxCe = r.ceOi;
      resistance = wallOf(r.strike, r.ceOi, r.ceDOi, bar.close);
    }
    if (r.strike <= bar.close && r.peOi > maxPe) {
      maxPe = r.peOi;
      support = wallOf(r.strike, r.peOi, r.peDOi, bar.close);
    }
  }

  const positionInRange =
    support && resistance && resistance.strike > support.strike
      ? clamp((bar.close - support.strike) / (resistance.strike - support.strike), 0, 1)
      : null;

  // Short-horizon travel, used to tell a breakout from a drift.
  const back = Math.max(0, i - 3);
  const travel = candles[i].close - candles[back].close;
  const rising = travel > 0;
  const falling = travel < 0;

  const notes: string[] = [];
  let verdict: LevelVerdict = "undecided";
  let bias = 0;

  // Standing OI balance across the band (put-heavy = supported).
  const balance =
    totalCeOi + totalPeOi > EPS
      ? clamp((totalPeOi - totalCeOi) / (totalPeOi + totalCeOi), -1, 1)
      : 0;

  const aboveAllCalls = resistance === null && rows.some((r) => r.ceOi > 0);
  const belowAllPuts = support === null && rows.some((r) => r.peOi > 0);

  if (aboveAllCalls) {
    verdict = "breakout";
    bias = 0.7;
    notes.push("Spot is above every call wall in the ±3 band — no listed resistance left inside the band.");
  } else if (belowAllPuts) {
    verdict = "breakdown";
    bias = -0.7;
    notes.push("Spot is below every put wall in the ±3 band — no listed support left inside the band.");
  } else if (resistance && support) {
    const resUnwinding = resistance.state === "unwinding";
    const resBuilding = resistance.state === "building";
    const supUnwinding = support.state === "unwinding";
    const supBuilding = support.state === "building";
    const nearRes = positionInRange !== null && positionInRange >= 0.65;
    const nearSup = positionInRange !== null && positionInRange <= 0.35;

    if (rising && resUnwinding) {
      verdict = "continuation_up";
      bias = 0.75;
      notes.push(`Call writers are covering at ${resistance.strike} (${resistance.changePct.toFixed(1)}% OI) while price advances — resistance is giving way.`);
    } else if (falling && supUnwinding) {
      verdict = "continuation_down";
      bias = -0.75;
      notes.push(`Put writers are abandoning ${support.strike} (${support.changePct.toFixed(1)}% OI) while price falls — the floor is being withdrawn.`);
    } else if (nearRes && resBuilding) {
      verdict = "reversal_from_resistance";
      bias = -0.6;
      notes.push(`Call writing is increasing at ${resistance.strike} (+${resistance.changePct.toFixed(1)}% OI) with price pressed against it — the cap is being defended.`);
    } else if (nearSup && supBuilding) {
      verdict = "reversal_from_support";
      bias = 0.6;
      notes.push(`Put writing is increasing at ${support.strike} (+${support.changePct.toFixed(1)}% OI) with price on the floor — the level is being defended.`);
    } else if (positionInRange !== null && positionInRange > 0.35 && positionInRange < 0.65) {
      verdict = "range_bound";
      bias = balance * 0.3;
      notes.push(`Price is mid-range between the ${support.strike} put wall and the ${resistance.strike} call wall.`);
    } else {
      verdict = "undecided";
      bias = balance * 0.4;
    }

    /* Wall maintenance still carries information even when no clean
       verdict fires: a floor being withdrawn is a warning for longs, and
       a cap being covered is a warning for shorts. Applied only in the
       fallback branches — the primary verdicts already encode it. */
    if (verdict === "undecided" || verdict === "range_bound") {
      if (supUnwinding) {
        bias -= 0.25;
        notes.push(`Put writers are trimming the ${support.strike} floor (${support.changePct.toFixed(1)}% OI) — support is weakening.`);
      }
      if (supBuilding) {
        bias += 0.2;
        notes.push(`Put writers are adding at ${support.strike} (+${support.changePct.toFixed(1)}% OI) — the floor is being reinforced.`);
      }
      if (resUnwinding) {
        bias += 0.25;
        notes.push(`Call writers are covering at ${resistance.strike} (${resistance.changePct.toFixed(1)}% OI) — the cap is weakening.`);
      }
      if (resBuilding) {
        bias -= 0.2;
        notes.push(`Call writers are adding at ${resistance.strike} (+${resistance.changePct.toFixed(1)}% OI) — the cap is being reinforced.`);
      }
    }

    // Position inside the wall range nudges the bias.
    if (positionInRange !== null) bias = clamp(bias + (0.5 - positionInRange) * 0.4, -1, 1);
  }

  if (resistance) {
    notes.push(`Resistance ${resistance.strike} · CE OI ${Math.round(resistance.oi).toLocaleString("en-IN")} (${resistance.state}) · ${resistance.distancePct >= 0 ? "+" : ""}${resistance.distancePct.toFixed(2)}% away`);
  }
  if (support) {
    notes.push(`Support ${support.strike} · PE OI ${Math.round(support.oi).toLocaleString("en-IN")} (${support.state}) · ${support.distancePct.toFixed(2)}% away`);
  }

  return {
    expiryDate: frame.expiryDate,
    atm,
    step: frame.strikeStep,
    spot: bar.close,
    rows: rows.sort((a, b) => a.strike - b.strike),
    support,
    resistance,
    positionInRange,
    verdict,
    bias: clamp(bias, -1, 1),
    bandPcr: totalCeOi > EPS ? totalPeOi / totalCeOi : null,
    notes,
  };
}

/** Does the level picture support a long / short at this moment? */
export function levelSupports(
  verdict: LevelVerdict, direction: "long" | "short",
): "supports" | "opposes" | "neutral" {
  const bullish: LevelVerdict[] = ["breakout", "continuation_up", "reversal_from_support"];
  const bearish: LevelVerdict[] = ["breakdown", "continuation_down", "reversal_from_resistance"];
  if (direction === "long") {
    if (bullish.includes(verdict)) return "supports";
    if (bearish.includes(verdict)) return "opposes";
  } else {
    if (bearish.includes(verdict)) return "supports";
    if (bullish.includes(verdict)) return "opposes";
  }
  return "neutral";
}

/** Next wall beyond the current one, used to extend a running target. */
export function nextWallBeyond(
  analysis: StrikeAnalysis, direction: "long" | "short", beyond: number,
): number | null {
  if (direction === "long") {
    const candidates = analysis.rows
      .filter((r) => r.strike > beyond && r.ceOi > 0)
      .sort((a, b) => b.ceOi - a.ceOi);
    return candidates.length ? candidates[0].strike : null;
  }
  const candidates = analysis.rows
    .filter((r) => r.strike < beyond && r.peOi > 0)
    .sort((a, b) => b.peOi - a.peOi);
  return candidates.length ? candidates[0].strike : null;
}
