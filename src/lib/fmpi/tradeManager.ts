/**
 * Trade lifecycle manager.
 *
 * Once an idea has been published the engine keeps re-evaluating it on
 * every refresh and issues one of:
 *
 *   HOLD          — the thesis still stands
 *   EXTEND_TARGET — momentum is continuing, so the objective is pushed to
 *                   the next option wall (or +1R when no wall is left)
 *   EXIT          — sentiment changed against a position that has already
 *                   moved; stand down rather than hope
 *   AVOID         — the setup degraded while price is still at the
 *                   suggested entry, so the trade can simply be skipped
 *   TARGET_HIT / STOPPED_OUT — the level was reached on real candles
 *
 * `decideAdvisory` is deliberately pure so every rule is unit-testable
 * without network or database access.
 */
import type { MomentumState } from "./types";
import type { LevelVerdict } from "./strikeLevels";
import { levelSupports } from "./strikeLevels";

export type Direction = "long" | "short";

export type AdvisoryAction =
  | "hold"
  | "extend_target"
  | "exit"
  | "avoid"
  | "target_hit"
  | "stopped_out";

export interface AdvisoryInput {
  direction: Direction;
  entryPrice: number;
  stop: number;
  target1: number;
  /** current objective — target2 initially, raised by extensions */
  currentTarget: number;
  lastPrice: number;
  state: MomentumState;
  regimeDirection: -1 | 0 | 1;
  regimeStrength: number;
  levelVerdict: LevelVerdict | null;
  levelBias: number | null;
  orderFlowScore: number | null;
  orderFlowAbsorption: boolean;
  /** next option wall beyond the current target, if one exists */
  nextWall: number | null;
  atr: number;
}

export interface Advisory {
  action: AdvisoryAction;
  reasons: string[];
  newTarget: number | null;
  /** adverse-evidence count that produced an exit/avoid */
  adverse: number;
}

const CONTINUATION_STATES = new Set<MomentumState>([
  "bullish_acceleration", "bullish_continuation", "bullish_momentum",
  "bearish_acceleration", "bearish_continuation", "bearish_momentum",
]);

function stateDirection(state: MomentumState): Direction | null {
  if (state.startsWith("bullish")) return "long";
  if (state.startsWith("bearish")) return "short";
  return null;
}

export function decideAdvisory(x: AdvisoryInput): Advisory {
  const sign = x.direction === "long" ? 1 : -1;
  const reasons: string[] = [];

  // 1. Hard levels first — these are facts from real candles.
  const stopped = x.direction === "long" ? x.lastPrice <= x.stop : x.lastPrice >= x.stop;
  if (stopped) {
    return {
      action: "stopped_out",
      reasons: [`Price reached the protective stop at ${x.stop.toFixed(2)}.`],
      newTarget: null, adverse: 0,
    };
  }
  const hitTarget =
    x.direction === "long" ? x.lastPrice >= x.currentTarget : x.lastPrice <= x.currentTarget;
  if (hitTarget) {
    return {
      action: "target_hit",
      reasons: [`Objective ${x.currentTarget.toFixed(2)} reached — bank or trail; the engine does not add beyond a met target without fresh evidence.`],
      newTarget: null, adverse: 0,
    };
  }

  // 2. Adverse evidence — a change of sentiment against the open idea.
  let adverse = 0;
  const regimeAgainst =
    x.regimeDirection !== 0 && x.regimeDirection !== sign && x.regimeStrength >= 0.25;
  if (regimeAgainst) {
    adverse++;
    reasons.push(`Trend regime has flipped against the trade (strength ${x.regimeStrength.toFixed(2)}).`);
  }

  const sDir = stateDirection(x.state);
  if (x.state.includes("reversal_watch") && sDir !== x.direction) {
    adverse++;
    reasons.push("Momentum state moved to reversal watch against the position.");
  } else if (sDir !== null && sDir !== x.direction && CONTINUATION_STATES.has(x.state)) {
    adverse++;
    reasons.push(`Momentum has turned: the engine now reads ${x.state.replace(/_/g, " ")}.`);
  } else if (x.state.includes("exhaustion") && sDir === x.direction) {
    adverse++;
    reasons.push("Pressure behind the move is showing exhaustion.");
  }

  if (x.levelVerdict) {
    const stance = levelSupports(x.levelVerdict, x.direction);
    if (stance === "opposes") {
      adverse++;
      reasons.push(`Option levels now oppose the trade (${x.levelVerdict.replace(/_/g, " ")}).`);
    }
  }
  if (x.levelBias !== null && sign * x.levelBias < -0.3) {
    adverse++;
    reasons.push("Open interest around the money has shifted against the direction.");
  }
  if (x.orderFlowScore !== null && sign * x.orderFlowScore < -0.25) {
    adverse++;
    reasons.push("Order flow has turned against the position.");
  }
  if (x.orderFlowAbsorption) {
    reasons.push("Absorption detected — heavy volume without progress; treat continuation cautiously.");
  }

  if (adverse >= 2) {
    const risk = Math.abs(x.entryPrice - x.stop);
    const moved = Math.abs(x.lastPrice - x.entryPrice);
    // Still effectively at the suggested entry → the trade can be skipped.
    const notYetCommitted = risk > 0 && moved < risk * 0.25;
    return {
      action: notYetCommitted ? "avoid" : "exit",
      reasons: notYetCommitted
        ? ["Setup degraded before the move began — skip this one.", ...reasons]
        : ["Sentiment changed against an open position.", ...reasons],
      newTarget: null, adverse,
    };
  }

  // 3. Continuation — extend only on positive evidence, never on hope.
  const beyondT1 =
    x.direction === "long" ? x.lastPrice >= x.target1 : x.lastPrice <= x.target1;
  const momentumIntact = sDir === x.direction && CONTINUATION_STATES.has(x.state);
  const flowAligned = x.orderFlowScore === null || sign * x.orderFlowScore > 0.1;
  const levelsAligned =
    x.levelVerdict === null || levelSupports(x.levelVerdict, x.direction) !== "opposes";
  const regimeAligned = x.regimeDirection === sign || x.regimeDirection === 0;

  if (beyondT1 && momentumIntact && flowAligned && levelsAligned && regimeAligned && adverse === 0) {
    const risk = Math.abs(x.entryPrice - x.stop) || x.atr;
    const wallTarget =
      x.nextWall !== null &&
      (x.direction === "long" ? x.nextWall > x.currentTarget : x.nextWall < x.currentTarget)
        ? x.nextWall
        : null;
    const stepTarget = x.direction === "long" ? x.currentTarget + risk : x.currentTarget - risk;
    const newTarget = wallTarget ?? stepTarget;
    return {
      action: "extend_target",
      reasons: [
        `Momentum is continuing past the first objective and nothing opposes it.`,
        wallTarget !== null
          ? `Objective extended to the next option wall at ${wallTarget}.`
          : `No further wall inside the ±3 band — objective extended by 1R to ${newTarget.toFixed(2)}.`,
        ...reasons,
      ],
      newTarget, adverse,
    };
  }

  return {
    action: "hold",
    reasons: reasons.length ? reasons : ["Thesis intact; no material change since the idea was published."],
    newTarget: null, adverse,
  };
}

/* ------------------------------------------------------------------ */
/* Bounded in-process tracker                                          */
/* ------------------------------------------------------------------ */

export interface TrackedTrade {
  id: string;
  instrumentKey: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  entryTs: number;
  stop: number;
  target1: number;
  target2: number;
  currentTarget: number;
  extensions: number;
  status: "open" | "closed";
  closedReason: AdvisoryAction | null;
  lastPrice: number;
  updatedAt: number;
}

export interface ManagedTrade extends TrackedTrade {
  action: AdvisoryAction;
  reasons: string[];
  rMultiple: number;
  levelVerdict: LevelVerdict | null;
  orderFlow: string | null;
}

const MAX_TRACKED = 16;
const globalTracker = globalThis as typeof globalThis & {
  __fmpiTrackedTrades?: Map<string, TrackedTrade>;
};
const tracked = globalTracker.__fmpiTrackedTrades ?? new Map<string, TrackedTrade>();
globalTracker.__fmpiTrackedTrades = tracked;

export function trackedKey(instrumentKey: string, direction: Direction): string {
  return `${instrumentKey}|${direction}`;
}

export function openTrades(): TrackedTrade[] {
  return [...tracked.values()].filter((t) => t.status === "open");
}

export function getTracked(key: string): TrackedTrade | undefined {
  return tracked.get(key);
}

/** Registers a freshly published idea so it can be managed from now on. */
export function registerTrade(t: Omit<TrackedTrade, "id" | "status" | "closedReason" | "extensions" | "currentTarget" | "updatedAt"> & { currentTarget?: number }): TrackedTrade {
  const id = trackedKey(t.instrumentKey, t.direction);
  const existing = tracked.get(id);
  if (existing && existing.status === "open") return existing;
  const row: TrackedTrade = {
    ...t,
    id,
    currentTarget: t.currentTarget ?? t.target2,
    extensions: 0,
    status: "open",
    closedReason: null,
    updatedAt: Date.now(),
  };
  tracked.set(id, row);
  // bounded retention — drop the oldest closed rows first
  if (tracked.size > MAX_TRACKED) {
    const victims = [...tracked.values()]
      .sort((a, b) => Number(a.status === "open") - Number(b.status === "open") || a.updatedAt - b.updatedAt);
    for (const v of victims) {
      if (tracked.size <= MAX_TRACKED) break;
      tracked.delete(v.id);
    }
  }
  return row;
}

export function applyAdvisory(trade: TrackedTrade, advisory: Advisory, lastPrice: number): void {
  trade.lastPrice = lastPrice;
  trade.updatedAt = Date.now();
  if (advisory.action === "extend_target" && advisory.newTarget !== null) {
    trade.currentTarget = advisory.newTarget;
    trade.extensions += 1;
  }
  if (advisory.action === "exit" || advisory.action === "stopped_out" || advisory.action === "target_hit") {
    trade.status = "closed";
    trade.closedReason = advisory.action;
  }
  if (advisory.action === "avoid") {
    trade.status = "closed";
    trade.closedReason = "avoid";
  }
}

export function rMultipleOf(t: TrackedTrade, lastPrice: number): number {
  const risk = Math.abs(t.entryPrice - t.stop);
  if (risk <= 0) return 0;
  const move = t.direction === "long" ? lastPrice - t.entryPrice : t.entryPrice - lastPrice;
  return move / risk;
}

export function clearTracked(): void {
  tracked.clear();
}
