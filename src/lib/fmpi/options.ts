/**
 * Options positioning component — FMPI v2 primary input (50% weight).
 *
 * Open interest is the only component that shows where committed money is
 * actually positioned, which is why it now anchors sentiment. To carry
 * half the composite it scores five independent pieces of evidence rather
 * than a single OI ratio:
 *
 *   1. FLOW (35%)  — writing vs buying, from ΔOI combined with the
 *                    contract's own price change:
 *                      CE OI↑ + CE price↓ = call writing      → bearish
 *                      CE OI↑ + CE price↑ = call long buildup → bullish
 *                      PE OI↑ + PE price↓ = put writing       → bullish
 *                      PE OI↑ + PE price↑ = put long buildup  → bearish
 *                      OI↓                 = unwinding of the above
 *   2. OI BALANCE (20%) — distance-weighted standing PE vs CE OI
 *   3. WALLS (20%)      — position between the heaviest CE (resistance)
 *                         and PE (support) strikes
 *   4. ΔPCR (15%)       — shift in put/call OI ratio versus the last bar
 *   5. VOLUME (10%)     — traded-volume skew
 *
 * Every number is the value printed by that candle, so the component is
 * causal and never repaints. Each sub-signal is skipped — not zero-filled
 * — when its inputs are absent, and the remaining weights renormalise.
 */
import type { Candle, ComponentReading } from "./types";
import type { OptionsFrame, OptionPoint } from "@/lib/market/optionsFrame";
import { STRIKE_RADIUS } from "@/lib/market/optionsFrame";
import { clamp, tanh } from "./math";

const EPS = 1e-9;

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

const UNAVAILABLE = (why: string): ComponentReading => ({
  score: null, available: false, evidence: [why],
});

/**
 * Signed contribution of one leg's OI change.
 * `bullishWhenWritten` is true for puts (put writing supports the market)
 * and false for calls (call writing caps it).
 */
function flowContribution(now: OptionPoint, prev: OptionPoint, isPut: boolean): number {
  const dOi = now.oi - prev.oi;
  if (Math.abs(dOi) < EPS) return 0;
  const dPrice = prev.close > EPS ? (now.close - prev.close) / prev.close : 0;
  const written = dPrice < 0; // premium falling while OI changes ⇒ writer-led
  let bullish: boolean;
  if (dOi > 0) {
    // fresh positions
    bullish = isPut ? written : !written;
  } else {
    // unwinding reverses the implication
    bullish = isPut ? !written : written;
  }
  return (bullish ? 1 : -1) * Math.abs(dOi);
}

export function optionsReadingAt(
  frame: OptionsFrame | null,
  candles: Candle[],
  i: number,
): ComponentReading {
  if (!frame) return UNAVAILABLE("no listed option contracts resolved for this underlying");
  const bar = candles[i];
  if (!bar || bar.ts < frame.from) {
    return UNAVAILABLE(`outside the reconstructed option window (${frame.expiryDate})`);
  }

  // ATM from THIS candle's close — never a later price.
  let atm = frame.strikes[0];
  let best = Infinity;
  for (const s of frame.strikes) {
    const d = Math.abs(s - bar.close);
    if (d < best) { best = d; atm = s; }
  }
  const reach = frame.strikeStep * STRIKE_RADIUS + 1e-6;
  const band = frame.strikes.filter((s) => Math.abs(s - atm) <= reach);
  if (band.length < 3) return UNAVAILABLE("too few strikes around the money at this candle");

  const prevTs = i > 0 ? candles[i - 1].ts : null;
  let ceOiW = 0, peOiW = 0;        // distance-weighted standing OI
  let ceOi = 0, peOi = 0;          // raw, for PCR
  let ceOiPrev = 0, peOiPrev = 0;
  let ceVol = 0, peVol = 0;
  let flow = 0, flowMag = 0;
  let ceDOi = 0, peDOi = 0;
  let present = 0, flowLegs = 0;

  for (const strike of band) {
    const w = 1 / (1 + Math.abs(strike - atm) / Math.max(frame.strikeStep, EPS));
    const c = frame.ce.get(strike)?.get(bar.ts);
    const p = frame.pe.get(strike)?.get(bar.ts);
    if (c) { ceOiW += c.oi * w; ceOi += c.oi; ceVol += c.vol; present++; }
    if (p) { peOiW += p.oi * w; peOi += p.oi; peVol += p.vol; present++; }
    if (prevTs !== null) {
      const cPrev = frame.ce.get(strike)?.get(prevTs);
      const pPrev = frame.pe.get(strike)?.get(prevTs);
      if (c && cPrev) {
        ceOiPrev += cPrev.oi;
        ceDOi += c.oi - cPrev.oi;
        flow += flowContribution(c, cPrev, false) * w;
        flowMag += Math.abs(c.oi - cPrev.oi) * w;
        flowLegs++;
      }
      if (p && pPrev) {
        peOiPrev += pPrev.oi;
        peDOi += p.oi - pPrev.oi;
        flow += flowContribution(p, pPrev, true) * w;
        flowMag += Math.abs(p.oi - pPrev.oi) * w;
        flowLegs++;
      }
    }
  }
  if (present < 4) return UNAVAILABLE("option contracts did not trade around this candle");

  const parts: { w: number; v: number }[] = [];
  const evidence: string[] = [];

  // 1. FLOW — writing vs buying
  let flowScore: number | null = null;
  if (flowLegs >= 2 && flowMag > EPS) {
    flowScore = clamp(flow / flowMag, -1, 1);
    parts.push({ w: 0.35, v: flowScore });
  }

  // 2. OI BALANCE — distance-weighted standing positioning
  let balanceScore: number | null = null;
  if (ceOiW + peOiW > EPS) {
    balanceScore = clamp((peOiW - ceOiW) / (peOiW + ceOiW), -1, 1);
    parts.push({ w: 0.2, v: balanceScore });
  }

  // 3. WALLS — heaviest CE above (resistance) vs heaviest PE below (support)
  let wallScore: number | null = null;
  let resistance: number | null = null;
  let support: number | null = null;
  let maxCe = 0, maxPe = 0;
  for (const strike of frame.strikes) {
    const c = frame.ce.get(strike)?.get(bar.ts);
    const p = frame.pe.get(strike)?.get(bar.ts);
    if (c && strike >= bar.close && c.oi > maxCe) { maxCe = c.oi; resistance = strike; }
    if (p && strike <= bar.close && p.oi > maxPe) { maxPe = p.oi; support = strike; }
  }
  if (resistance !== null && support !== null && resistance > support) {
    // 0 at the support wall, 1 at the resistance wall
    const pos = clamp((bar.close - support) / (resistance - support), 0, 1);
    // Near support = downside cushioned (bullish); near resistance = capped.
    wallScore = clamp(1 - 2 * pos, -1, 1);
    parts.push({ w: 0.2, v: wallScore });
  }

  // 4. ΔPCR — shift in the put/call OI ratio
  let pcrScore: number | null = null;
  const pcr = ceOi > EPS ? peOi / ceOi : null;
  const pcrPrev = ceOiPrev > EPS ? peOiPrev / ceOiPrev : null;
  if (pcr !== null && pcrPrev !== null && pcrPrev > EPS) {
    pcrScore = clamp((pcr / pcrPrev - 1) / 0.05, -1, 1);
    parts.push({ w: 0.15, v: pcrScore });
  }

  // 5. VOLUME skew
  let volScore: number | null = null;
  if (ceVol + peVol > EPS) {
    volScore = clamp((peVol - ceVol) / (peVol + ceVol), -1, 1);
    parts.push({ w: 0.1, v: volScore });
  }

  if (parts.length === 0) return UNAVAILABLE("option chain carried no usable OI/volume at this candle");

  const wSum = parts.reduce((s, p) => s + p.w, 0);
  const score = tanh((parts.reduce((s, p) => s + p.w * p.v, 0) / wSum) * 1.5);

  evidence.push(
    `ATM ${atm} ±${STRIKE_RADIUS} · PCR(OI) ${pcr != null ? pcr.toFixed(2) : "n/a"} · exp ${frame.expiryDate} — positioning evidence, not a directional guarantee`,
  );
  if (flowScore !== null) {
    const dir = flowScore > 0.05 ? "supportive" : flowScore < -0.05 ? "capping" : "balanced";
    evidence.push(
      `OI flow ${dir} (${flowScore >= 0 ? "+" : ""}${flowScore.toFixed(2)}): PE ΔOI ${peDOi >= 0 ? "+" : ""}${fmt(peDOi)} · CE ΔOI ${ceDOi >= 0 ? "+" : ""}${fmt(ceDOi)}, classified by premium direction`,
    );
  }
  if (resistance !== null && support !== null) {
    evidence.push(`OI walls: support ${support} (${fmt(maxPe)}) · resistance ${resistance} (${fmt(maxCe)})`);
  }
  if (pcrScore !== null && Math.abs(pcrScore) > 0.1) {
    evidence.push(`PCR ${pcrScore > 0 ? "rising" : "falling"} vs previous candle`);
  }
  if (volScore !== null) {
    evidence.push(`option volume ${volScore >= 0 ? "put" : "call"}-heavy (PE ${fmt(peVol)} / CE ${fmt(ceVol)})`);
  }
  return { score, available: true, evidence };
}
