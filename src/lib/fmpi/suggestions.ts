/**
 * Trade suggestion engine.
 *
 * NON-NEGOTIABLE RULE: an extreme FMPI reading is never, by itself, a
 * trade. Ideas are only produced when several independent pieces of
 * evidence agree, and the engine is allowed to return FEWER than the
 * requested count — including zero — rather than manufacture a setup.
 *
 * Ranking is by CONVICTION, not by |FMPI − 50|:
 *   • continuation strength from the state machine
 *   • 5M / 10M timeframe agreement (conflicts are disqualifying)
 *   • agreement among the available components (price, volume, futures
 *     OI, options OI, structure, acceleration)
 *   • effective component coverage and data quality
 *   • penalties for exhaustion evidence and adverse divergence
 *
 * Exhaustion / reversal-watch instruments are deliberately EXCLUDED from
 * entries and surfaced separately as watch-outs, because weakening
 * pressure is a warning, not a counter-trend signal.
 *
 * Risk levels are derived from genuine recent structure and ATR — they
 * are reference levels for sizing research, not advice.
 */
import { atr, clamp } from "./math";
import { getFmpiSeries } from "./service";
import { buildOptionsFrame } from "@/lib/market/optionsFrame";
import { ensureSessions } from "@/lib/market/candles";
import { analyzeStrikes, levelSupports, nextWallBeyond, BAND_RADIUS } from "./strikeLevels";
import type { StrikeAnalysis } from "./strikeLevels";
import { orderFlowFor } from "./orderflow";
import type { OrderFlowReading } from "./orderflow";
import {
  applyAdvisory, decideAdvisory, openTrades, registerTrade, rMultipleOf, trackedKey,
} from "./tradeManager";
import type { AdvisoryAction, ManagedTrade } from "./tradeManager";
import type {
  Candle, ComponentKey, DataQuality, InstrumentMeta, MomentumState, ScanRow, Timeframe, ZoneId,
} from "./types";

export type Direction = "long" | "short";

export interface TradeIdea {
  rank: number;
  instrument: InstrumentMeta;
  direction: Direction;
  setup: string;
  conviction: number; // 0..100
  grade: "A" | "B" | "C";
  fmpi5: number;
  fmpi10: number | null;
  state5: MomentumState;
  state10: MomentumState | null;
  aligned: boolean;
  zone: ZoneId | null;
  lastPrice: number;
  atr: number;
  stop: number;
  target1: number;
  target2: number;
  riskPct: number;
  rewardRisk: number;
  evidence: string[];
  risks: string[];
  coverage: number;
  dataQuality: DataQuality;
  ts: number;
  /** ±3 strike picture; null when the chain cannot support it */
  levels: StrikeLevelSummary | null;
  /** candle-derived order flow; null when no volume is published */
  orderFlow: OrderFlowSummary | null;
}

export interface StrikeLevelSummary {
  expiryDate: string;
  atm: number;
  support: number | null;
  supportOi: number | null;
  supportState: string | null;
  resistance: number | null;
  resistanceOi: number | null;
  resistanceState: string | null;
  positionInRange: number | null;
  verdict: string;
  stance: "supports" | "opposes" | "neutral";
  bias: number;
  bandPcr: number | null;
  notes: string[];
}

export interface OrderFlowSummary {
  source: "spot" | "futures";
  pressure: string;
  deltaRatio: number;
  absorption: boolean;
  divergence: string;
  score: number;
  notes: string[];
}

export interface WatchOut {
  instrument: InstrumentMeta;
  fmpi: number;
  state: MomentumState;
  note: string;
}

export interface SuggestionPayload {
  timeframe: Timeframe;
  generatedAt: string | null;
  status: "idle" | "building" | "ready";
  progress: { done: number; total: number };
  ideas: TradeIdea[];
  /** published ideas that are now being actively managed */
  managed: ManagedTrade[];
  watchOuts: WatchOut[];
  considered: number;
  qualified: number;
  minConviction: number;
  scanStatus: "idle" | "building" | "ready";
  scanProgress: { done: number; total: number };
  disclaimer: string;
}

/** States that may become an entry idea (trend-following only). */
const ENTRY_STATES = new Set<MomentumState>([
  "bullish_acceleration", "bullish_continuation", "bullish_momentum",
  "bearish_acceleration", "bearish_continuation", "bearish_momentum",
]);

/** States that are warnings, never entries. */
const WATCH_STATES = new Set<MomentumState>([
  "bullish_exhaustion", "bullish_reversal_watch",
  "bearish_exhaustion", "bearish_reversal_watch",
  // counter-trend bounces: information, never a trade in either direction
  "bearish_pullback", "bullish_pullback",
]);

const MIN_CONVICTION = 55;
const SHORTLIST = 14;
const DEEP_CONCURRENCY = 3;
const CACHE_TTL = 150_000;

function directionOf(state: MomentumState): Direction | null {
  if (state.startsWith("bullish")) return "long";
  if (state.startsWith("bearish")) return "short";
  return null;
}

function setupLabel(state: MomentumState): string {
  switch (state) {
    case "bullish_acceleration": return "Bullish acceleration";
    case "bullish_continuation": return "Bullish continuation";
    case "bullish_momentum": return "Bullish momentum";
    case "bearish_acceleration": return "Bearish acceleration";
    case "bearish_continuation": return "Bearish continuation";
    case "bearish_momentum": return "Bearish momentum";
    default: return "Momentum";
  }
}

const COMPONENT_LABEL: Record<ComponentKey, string> = {
  price_pressure: "price pressure",
  volume_participation: "volume",
  futures_positioning: "futures OI",
  options_positioning: "options OI",
  price_structure: "structure",
  acceleration_persistence: "acceleration",
};

/**
 * Structure-anchored risk reference.
 * Stop sits beyond the recent swing extreme (with an ATR buffer) and is
 * capped so an unusually wide swing does not produce an absurd level.
 */
function riskLevels(candles: Candle[], direction: Direction, atrValue: number) {
  const n = candles.length;
  const last = candles[n - 1].close;
  const window = candles.slice(Math.max(0, n - 10));
  const buffer = atrValue * 0.15;
  let stop: number;
  if (direction === "long") {
    const swingLow = Math.min(...window.map((c) => c.low));
    stop = swingLow - buffer;
    if (last - stop > atrValue * 2.5 || stop >= last) stop = last - atrValue * 1.5;
  } else {
    const swingHigh = Math.max(...window.map((c) => c.high));
    stop = swingHigh + buffer;
    if (stop - last > atrValue * 2.5 || stop <= last) stop = last + atrValue * 1.5;
  }
  const risk = Math.abs(last - stop);
  const target1 = direction === "long" ? last + risk : last - risk;
  const target2 = direction === "long" ? last + 2 * risk : last - 2 * risk;
  return {
    stop, target1, target2,
    riskPct: (risk / last) * 100,
    rewardRisk: 2,
  };
}

const DISCLAIMER =
  "Research output, not investment advice. Ideas require multi-factor agreement — an extreme FMPI reading alone never qualifies. Fewer than the requested number (including none) are returned when the evidence is not there. Levels are derived from recent structure and ATR; verify independently and manage your own risk.";

interface SuggestState {
  status: "idle" | "building" | "ready";
  builtAt: number | null;
  ideas: TradeIdea[];
  /** published ideas that are now being actively managed */
  managed: ManagedTrade[];
  watchOuts: WatchOut[];
  considered: number;
  qualified: number;
  progress: { done: number; total: number };
}
const globalSuggestions = globalThis as typeof globalThis & {
  __fmpiSuggestionState?: SuggestState;
  __fmpiSuggestionInflight?: Promise<void> | null;
};
const state: SuggestState = globalSuggestions.__fmpiSuggestionState ?? {
  status: "idle", builtAt: null, ideas: [], managed: [], watchOuts: [],
  considered: 0, qualified: 0, progress: { done: 0, total: 0 },
};
state.managed ??= [];
globalSuggestions.__fmpiSuggestionState = state;
let inflight: Promise<void> | null = globalSuggestions.__fmpiSuggestionInflight ?? null;

/**
 * Non-blocking accessor: returns whatever has genuinely been computed and
 * kicks off a refresh in the background when the result is stale. The API
 * therefore responds immediately instead of holding the request open for
 * a multi-instrument deep analysis.
 */
export function ensureSuggestions(
  rows: ScanRow[],
  scanStatus: "idle" | "building" | "ready",
  scanProgress: { done: number; total: number },
  limit = 5,
  tf: Timeframe = "5m",
): SuggestionPayload {
  const stale = state.builtAt === null || Date.now() - state.builtAt > CACHE_TTL;
  // Never run the deep multi-timeframe pass concurrently with the cold
  // universe scan. On Render's 512MB tier those two workloads together can
  // kill the process. The scanner publishes progress; suggestions begin as
  // soon as it reaches READY.
  if (state.status !== "building" && stale && rows.length > 0 && scanStatus === "ready") {
    void runBuild(rows, limit, tf);
  }
  return {
    timeframe: tf,
    generatedAt: state.builtAt ? new Date(state.builtAt).toISOString() : null,
    status: state.status,
    progress: state.progress,
    ideas: state.ideas.slice(0, limit),
    managed: state.managed,
    watchOuts: state.watchOuts,
    considered: state.considered,
    qualified: state.qualified,
    minConviction: MIN_CONVICTION,
    scanStatus, scanProgress,
    disclaimer: DISCLAIMER,
  };
}


/* ------------------------------------------------------------------ */
/* Shared market context: ±3 strike levels + order flow               */
/* ------------------------------------------------------------------ */

interface TradeContext {
  lastPrice: number;
  atr: number;
  state: MomentumState;
  regimeDirection: -1 | 0 | 1;
  regimeStrength: number;
  analysis: StrikeAnalysis | null;
  flow: OrderFlowReading | null;
  levelSummary: StrikeLevelSummary | null;
  flowSummary: OrderFlowSummary | null;
}

/**
 * Builds the ±3 strike picture and the order-flow reading for one
 * instrument on the latest completed candle. Returns null rather than a
 * partial guess when the genuine inputs are missing.
 */
async function analyseContext(
  meta: InstrumentMeta, tf: Timeframe, direction: Direction,
): Promise<TradeContext | null> {
  const payload = await getFmpiSeries(meta.symbol, tf, 3, false, false, false, true);
  const candles = payload.candles;
  const l = payload.latest;
  if (!l || candles.length < 20) return null;
  const i = candles.length - 1;
  const lastPrice = candles[i].close;
  const atrValue = atr(
    candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close), i, 14,
  );

  // ±3 strikes only, one session — cheap enough to refresh often.
  let analysis: StrikeAnalysis | null = null;
  try {
    const frame = await buildOptionsFrame(meta, tf, candles, Date.now(), {
      focusRadius: BAND_RADIUS, sessions: 1,
    });
    analysis = analyzeStrikes(frame, candles, i);
  } catch {
    analysis = null;
  }

  // Indices publish no volume, so fall back to the linked futures series.
  let flow: OrderFlowReading | null = null;
  try {
    let futures: Candle[] | null = null;
    if (meta.futuresKey) {
      const fut = await ensureSessions(meta.futuresKey, tf, 2);
      futures = fut.candles.length ? fut.candles : null;
    }
    const reading = orderFlowFor(candles, futures, i);
    flow = reading.available ? reading : null;
  } catch {
    flow = null;
  }

  const levelSummary: StrikeLevelSummary | null = analysis
    ? {
        expiryDate: analysis.expiryDate,
        atm: analysis.atm,
        support: analysis.support?.strike ?? null,
        supportOi: analysis.support?.oi ?? null,
        supportState: analysis.support?.state ?? null,
        resistance: analysis.resistance?.strike ?? null,
        resistanceOi: analysis.resistance?.oi ?? null,
        resistanceState: analysis.resistance?.state ?? null,
        positionInRange: analysis.positionInRange,
        verdict: analysis.verdict,
        stance: levelSupports(analysis.verdict, direction),
        bias: analysis.bias,
        bandPcr: analysis.bandPcr,
        notes: analysis.notes,
      }
    : null;

  const flowSummary: OrderFlowSummary | null =
    flow && flow.source
      ? {
          source: flow.source,
          pressure: flow.pressure,
          deltaRatio: Math.round(flow.deltaRatio * 1000) / 1000,
          absorption: flow.absorption,
          divergence: flow.divergence,
          score: Math.round(flow.score * 1000) / 1000,
          notes: flow.notes,
        }
      : null;

  return {
    lastPrice,
    atr: atrValue,
    state: l.state,
    regimeDirection: (l.regime?.direction ?? 0) as -1 | 0 | 1,
    regimeStrength: l.regime?.strength ?? 0,
    analysis, flow, levelSummary, flowSummary,
  };
}

/**
 * Re-evaluates every open idea and issues HOLD / EXTEND / EXIT / AVOID.
 * This is what turns a one-shot suggestion into a managed trade.
 */
async function manageOpenTrades(tf: Timeframe): Promise<ManagedTrade[]> {
  const { getInstrument } = await import("@/lib/market/universe");
  const out: ManagedTrade[] = [];
  for (const trade of openTrades().slice(0, 8)) {
    try {
      const meta = await getInstrument(trade.symbol);
      if (!meta) continue;
      const ctx = await analyseContext(meta, tf, trade.direction);
      if (!ctx) continue;

      const nextWall = ctx.analysis
        ? nextWallBeyond(ctx.analysis, trade.direction, trade.currentTarget)
        : null;

      const advisory = decideAdvisory({
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        stop: trade.stop,
        target1: trade.target1,
        currentTarget: trade.currentTarget,
        lastPrice: ctx.lastPrice,
        state: ctx.state,
        regimeDirection: ctx.regimeDirection,
        regimeStrength: ctx.regimeStrength,
        levelVerdict: ctx.analysis?.verdict ?? null,
        levelBias: ctx.analysis?.bias ?? null,
        orderFlowScore: ctx.flow?.score ?? null,
        orderFlowAbsorption: ctx.flow?.absorption ?? false,
        nextWall,
        atr: ctx.atr,
      });

      applyAdvisory(trade, advisory, ctx.lastPrice);
      out.push({
        ...trade,
        action: advisory.action,
        reasons: advisory.reasons,
        rMultiple: Math.round(rMultipleOf(trade, ctx.lastPrice) * 100) / 100,
        levelVerdict: ctx.analysis?.verdict ?? null,
        orderFlow: ctx.flowSummary
          ? `${ctx.flowSummary.pressure} (${(ctx.flowSummary.deltaRatio * 100).toFixed(0)}% delta)`
          : null,
      });
    } catch {
      /* a single instrument must never break trade management */
    }
  }
  // most actionable first
  const order: Record<AdvisoryAction, number> = {
    exit: 0, avoid: 1, stopped_out: 2, target_hit: 3, extend_target: 4, hold: 5,
  };
  return out.sort((a, b) => order[a.action] - order[b.action]);
}

async function runBuild(rows: ScanRow[], limit: number, tf: Timeframe): Promise<void> {
  if (inflight) return inflight;
  state.status = "building";
  inflight = (async () => {
    try {
      // Eligible universe: F&O equities + the two requested indices.
      const eligible = rows.filter(
        (r) =>
          r.value != null &&
          (r.quality === "valid" || r.quality === "partial") &&
          (r.instrument.segment === "fno" ||
            r.instrument.symbol === "NIFTY" ||
            r.instrument.symbol === "SENSEX"),
      );

      const watchOuts: WatchOut[] = eligible
        .filter((r) => WATCH_STATES.has(r.state))
        .sort((a, b) => Math.abs((b.value as number) - 50) - Math.abs((a.value as number) - 50))
        .slice(0, 5)
        .map((r) => ({
          instrument: r.instrument,
          fmpi: r.value as number,
          state: r.state,
          note: r.state.includes("pullback")
            ? "Counter-trend bounce inside the prevailing trend. Not an entry in either direction until the regime actually flips."
            : r.state.includes("reversal")
              ? "Reversal watch — divergence plus weakening pressure. Warning only, not a counter-trend entry."
              : "Pressure weakening against the prevailing move. Continuation is no longer well supported.",
        }));

      // Shortlist trend-following candidates; deep analysis is expensive.
      const shortlist = eligible
        .filter((r) => ENTRY_STATES.has(r.state) && directionOf(r.state))
        .sort((a, b) => Math.abs((b.value as number) - 50) - Math.abs((a.value as number) - 50))
        .slice(0, SHORTLIST);

      state.watchOuts = watchOuts;
      state.considered = shortlist.length;
      state.progress = { done: 0, total: shortlist.length };

      const ideas: TradeIdea[] = [];
      const queue = [...shortlist];

      const worker = async () => {
        for (;;) {
          const row = queue.shift();
          if (!row) return;
          try {
            // sessions=4 matches the scanner's cached depth; options are
            // skipped during screening so a pass stays a few requests deep.
            // includePeer=false: the confirming timeframe is fetched
            // explicitly below so a failure is visible instead of silently
            // degrading every idea to "unconfirmed".
            const payload = await getFmpiSeries(row.instrument.symbol, tf, 4, false, false, false, true);
            const l = payload.latest;
            if (!l || !l.zone || l.quality === "warming_up" || l.quality === "unavailable") continue;

            const direction = directionOf(l.state);
            // Re-check on fresh data: the state may have moved on since the scan.
            if (!direction || !ENTRY_STATES.has(l.state)) continue;
            // Never trade on a still-forming candle's reading alone.
            if (l.provisional && payload.points.length < 2) continue;

            // Higher-timeframe confirmation, fetched with a retry because
            // a transient miss must not be read as "no confirmation".
            const peerTf: Timeframe = tf === "5m" ? "10m" : "5m";
            let peer: { value: number; state: MomentumState } | null = null;
            for (let attempt = 0; attempt < 2 && !peer; attempt++) {
              try {
                const pp = await getFmpiSeries(row.instrument.symbol, peerTf, 4, false, false, false, true);
                const pl = pp.latest;
                if (pl && pl.zone && pl.quality !== "warming_up" && pl.quality !== "unavailable") {
                  peer = { value: pl.value, state: pl.state };
                }
              } catch {
                /* retry once, then treat as unconfirmed */
              }
            }
            const peerDir = peer ? directionOf(peer.state) : null;
            // Opposing higher-timeframe pressure disqualifies the idea.
            if (peerDir !== null && peerDir !== direction) continue;
            // Same direction is not automatically confirmation: a higher
            // timeframe sitting in exhaustion/reversal-watch is fading
            // pressure, so it counts as a caution, never as a confirm.
            const peerTrending = peer ? ENTRY_STATES.has(peer.state) : false;
            const aligned = peerDir !== null && peerDir === direction && peerTrending;
            const peerFading = peerDir === direction && !peerTrending;

            // Component agreement among those actually available.
            const sign = direction === "long" ? 1 : -1;
            const available = (Object.keys(l.components) as ComponentKey[]).filter(
              (k) => l.components[k].available && l.components[k].score != null,
            );
            const agreeing = available.filter((k) => sign * (l.components[k].score as number) > 0.02);
            const agreement = available.length ? agreeing.length / available.length : 0;

            /* Conviction is a weighted blend, not an additive score that
               saturates at 100: each pillar contributes a bounded share so
               ideas actually separate from one another.
                 continuation strength 45 · HTF confirmation 20
                 component agreement   20 · data coverage      15      */
            let conviction =
              (l.continuationScore ?? 50) * 0.45 +
              (aligned ? 20 : 0) +
              agreement * 20 +
              clamp(l.coverage, 0, 1) * 15;
            conviction -= (l.exhaustionScore ?? 0) * 0.2;
            if (l.quality === "partial") conviction -= 8;
            if (l.quality === "stale") conviction -= 25;
            const adverseDivergence =
              (direction === "long" && l.divergence?.includes("bearish")) ||
              (direction === "short" && l.divergence?.includes("bullish"));
            if (adverseDivergence) conviction -= l.divergence?.startsWith("developing") ? 10 : 20;
            if (peerFading) conviction -= 12;
            // Without higher-timeframe confirmation an idea can never be
            // presented as high conviction, however clean the 5M looks.
            if (!aligned) conviction = Math.min(conviction, 70);
            conviction = Math.round(clamp(conviction, 0, 100));
            if (conviction < MIN_CONVICTION) continue;

            const candles = payload.candles;
            if (candles.length < 20) continue;
            const atrValue = atr(
              candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close),
              candles.length - 1, 14,
            );
            if (!(atrValue > 0)) continue;
            const lastPrice = candles[candles.length - 1].close;
            const levels = riskLevels(candles, direction, atrValue);

            const evidence: string[] = [
              `FMPI ${l.value.toFixed(1)} in the ${l.zone} zone, slope ${(l.slope ?? 0) >= 0 ? "+" : ""}${(l.slope ?? 0).toFixed(2)}`,
              aligned && peer
                ? `${peerTf.toUpperCase()} confirms at ${peer.value.toFixed(1)} (${peer.state.replace(/_/g, " ")})`
                : peerFading && peer
                  ? `${peerTf.toUpperCase()} is same-direction but fading at ${peer.value.toFixed(1)} (${peer.state.replace(/_/g, " ")}) — caution, not confirmation`
                  : `${peerTf.toUpperCase()} confirmation unavailable — conviction capped`,
              `${agreeing.length}/${available.length} available components agree: ${agreeing.map((k) => COMPONENT_LABEL[k]).join(", ") || "none"}`,
            ];
            const fut = l.components.futures_positioning;
            if (fut.available && fut.evidence[0]) evidence.push(fut.evidence[0]);
            const opt = l.components.options_positioning;
            if (opt.available && opt.evidence[0]) evidence.push(opt.evidence[0]);

            const risks: string[] = [];
            if (peerFading) {
              risks.push(`${peerTf.toUpperCase()} pressure is already fading (${peer?.state.replace(/_/g, " ")}) — the higher timeframe does not support continuation.`);
            } else if (!aligned) {
              risks.push(`${peerTf.toUpperCase()} confirmation is absent — conviction is capped at 70 and the grade cannot be A.`);
            }
            if (adverseDivergence) risks.push(`Adverse ${l.divergence?.replace(/_/g, " ")} divergence is present.`);
            if ((l.exhaustionScore ?? 0) >= 45) risks.push(`Exhaustion evidence at ${l.exhaustionScore}/100 — pressure may be fading.`);
            if (l.coverage < 0.7) risks.push(`Only ${(l.coverage * 100).toFixed(0)}% component coverage: ${l.missingComponents.map((k) => COMPONENT_LABEL[k]).join(", ")} missing.`);
            if (l.quality !== "valid") risks.push(`Data quality is ${l.quality}.`);
            if (payload.marketState !== "open") risks.push("Market is closed — levels are from the last completed session.");
            if (risks.length === 0) risks.push("No material contradictions detected at this candle.");

            ideas.push({
              rank: 0,
              instrument: payload.instrument,
              direction,
              setup: setupLabel(l.state),
              conviction,
              // Grade A additionally requires 10M confirmation (enforced by
              // the cap above, which keeps unconfirmed ideas below 78).
              grade: conviction >= 78 ? "A" : conviction >= 66 ? "B" : "C",
              fmpi5: l.value,
              fmpi10: peer?.value ?? null,
              state5: l.state,
              state10: peer?.state ?? null,
              aligned,
              zone: l.zone,
              lastPrice,
              atr: atrValue,
              stop: levels.stop,
              target1: levels.target1,
              target2: levels.target2,
              riskPct: levels.riskPct,
              rewardRisk: levels.rewardRisk,
              evidence,
              risks,
              coverage: l.coverage,
              dataQuality: l.quality,
              ts: l.ts,
              levels: null,
              orderFlow: null,
            });
          } catch {
            /* one instrument must never break the suggestion run */
          } finally {
            state.progress = { done: state.progress.done + 1, total: shortlist.length };
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(DEEP_CONCURRENCY, shortlist.length) }, worker),
      );

      // Rank by conviction; `limit` is applied on read so the cached set
      // stays reusable. Nothing is padded if fewer ideas qualify.
      ideas.sort((a, b) => b.conviction - a.conviction);

      /* ---- Strike-level + order-flow enrichment -------------------
         Only the ideas that will actually be published are enriched,
         using a ±3-strike focused frame over a single session. That is
         ~14 contract requests each instead of 26, keeping the refresh
         inside Render's memory and rate budget. */
      const publish = ideas.slice(0, Math.max(limit, 5));
      for (const idea of publish) {
        try {
          const ctx = await analyseContext(idea.instrument, tf, idea.direction);
          if (!ctx) continue;
          idea.levels = ctx.levelSummary;
          idea.orderFlow = ctx.flowSummary;

          // Levels and flow are evidence, so they move conviction and can
          // veto an idea outright — never silently decorate it.
          if (ctx.levelSummary) {
            if (ctx.levelSummary.stance === "supports") {
              idea.conviction = Math.min(100, idea.conviction + 6);
              idea.evidence.push(`Option levels support the trade: ${ctx.levelSummary.verdict.replace(/_/g, " ")}.`);
            } else if (ctx.levelSummary.stance === "opposes") {
              idea.conviction = Math.max(0, idea.conviction - 18);
              idea.risks.push(`Option levels oppose the trade (${ctx.levelSummary.verdict.replace(/_/g, " ")}).`);
            }
            for (const n of ctx.levelSummary.notes.slice(0, 2)) idea.evidence.push(n);
          }
          if (ctx.flowSummary) {
            const sign = idea.direction === "long" ? 1 : -1;
            if (sign * ctx.flowSummary.score > 0.15) {
              idea.conviction = Math.min(100, idea.conviction + 4);
              idea.evidence.push(ctx.flowSummary.notes[1] ?? "Order flow aligned.");
            } else if (sign * ctx.flowSummary.score < -0.15) {
              idea.conviction = Math.max(0, idea.conviction - 12);
              idea.risks.push(`Order flow is against the direction (${ctx.flowSummary.pressure} in control).`);
            }
            if (ctx.flowSummary.absorption) idea.risks.push("Absorption detected at these prices.");
          }
          idea.grade = idea.conviction >= 78 ? "A" : idea.conviction >= 66 ? "B" : "C";
        } catch {
          /* enrichment is additive; its failure never drops a ranked idea */
        }
      }
      // Re-rank and drop anything the levels/flow pushed under the gate.
      const vetted = publish
        .filter((i2) => i2.conviction >= MIN_CONVICTION)
        .concat(ideas.slice(Math.max(limit, 5)))
        .sort((a, b) => b.conviction - a.conviction);

      state.ideas = vetted.map((idea, i2) => ({ ...idea, rank: i2 + 1 }));
      state.qualified = vetted.length;

      /* ---- Register published ideas, then manage every open trade --- */
      for (const idea of state.ideas.slice(0, limit)) {
        registerTrade({
          instrumentKey: idea.instrument.instrumentKey,
          symbol: idea.instrument.symbol,
          direction: idea.direction,
          entryPrice: idea.lastPrice,
          entryTs: idea.ts,
          stop: idea.stop,
          target1: idea.target1,
          target2: idea.target2,
          lastPrice: idea.lastPrice,
        });
      }
      state.managed = await manageOpenTrades(tf);
      state.builtAt = Date.now();
      state.status = "ready";
    } catch (e) {
      console.warn(`[suggestions] build failed: ${(e as Error).message}`);
      state.status = state.ideas.length ? "ready" : "idle";
      state.builtAt = state.ideas.length ? Date.now() : null;
    } finally {
      inflight = null;
      globalSuggestions.__fmpiSuggestionInflight = null;
    }
  })();
  globalSuggestions.__fmpiSuggestionInflight = inflight;
  return inflight;
}
