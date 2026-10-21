import { describe, expect, it } from "vitest";
import { analyzeStrikes, levelSupports, nextWallBeyond, BAND_RADIUS } from "@/lib/fmpi/strikeLevels";
import { candleDelta, computeOrderFlow, orderFlowFor } from "@/lib/fmpi/orderflow";
import { decideAdvisory, type AdvisoryInput } from "@/lib/fmpi/tradeManager";
import type { OptionsFrame, OptionPoint } from "@/lib/market/optionsFrame";
import type { Candle } from "@/lib/fmpi/types";

const TS0 = Date.UTC(2026, 9, 9, 3, 45);
const STEP = 5 * 60_000;

function bars(closes: number[], vol = 1000): Candle[] {
  return closes.map((c, i) => ({
    ts: TS0 + i * STEP, open: c, high: c + 5, low: c - 5, close: c, volume: vol, oi: null,
  }));
}

/** Frame with explicit per-strike OI for two bars (prev, now). */
function frameOf(spec: Record<number, { ce: [number, number]; pe: [number, number] }>): OptionsFrame {
  const ce = new Map<number, Map<number, OptionPoint>>();
  const pe = new Map<number, Map<number, OptionPoint>>();
  for (const [kStr, v] of Object.entries(spec)) {
    const k = Number(kStr);
    const c = new Map<number, OptionPoint>();
    const p = new Map<number, OptionPoint>();
    c.set(TS0, { oi: v.ce[0], vol: 100, close: 50 });
    c.set(TS0 + STEP, { oi: v.ce[1], vol: 100, close: 50 });
    p.set(TS0, { oi: v.pe[0], vol: 100, close: 50 });
    p.set(TS0 + STEP, { oi: v.pe[1], vol: 100, close: 50 });
    ce.set(k, c);
    pe.set(k, p);
  }
  return {
    expiryDate: "2026-10-15", strikeStep: 100,
    strikes: Object.keys(spec).map(Number).sort((a, b) => a - b),
    ce, pe, contracts: Object.keys(spec).length * 2, from: TS0, note: "test",
  };
}

const FLAT = {
  22200: { ce: [1e5, 1e5] as [number, number], pe: [1e5, 1e5] as [number, number] },
  22300: { ce: [1e5, 1e5] as [number, number], pe: [1e5, 1e5] as [number, number] },
  22400: { ce: [1e5, 1e5] as [number, number], pe: [1e5, 1e5] as [number, number] },
  22500: { ce: [1e5, 1e5] as [number, number], pe: [1e5, 1e5] as [number, number] },
  22600: { ce: [1e5, 1e5] as [number, number], pe: [1e5, 1e5] as [number, number] },
  22700: { ce: [1e5, 1e5] as [number, number], pe: [1e5, 1e5] as [number, number] },
  22800: { ce: [1e5, 1e5] as [number, number], pe: [1e5, 1e5] as [number, number] },
};

describe("±3 strike level analysis", () => {
  it("detects the support and resistance walls from real OI", () => {
    const f = frameOf({
      ...FLAT,
      22700: { ce: [9e5, 9e5], pe: [1e5, 1e5] }, // heavy call wall above
      22300: { pe: [8e5, 8e5], ce: [1e5, 1e5] }, // heavy put wall below
    });
    const a = analyzeStrikes(f, bars([22500, 22500]), 1)!;
    expect(a.resistance!.strike).toBe(22700);
    expect(a.support!.strike).toBe(22300);
    expect(a.atm).toBe(22500);
    expect(a.rows.every((r) => Math.abs(r.offset) <= BAND_RADIUS)).toBe(true);
  });

  it("reads call writers covering into a rally as upside continuation", () => {
    const f = frameOf({ ...FLAT, 22600: { ce: [9e5, 7e5], pe: [1e5, 1e5] }, 22300: { pe: [5e5, 5e5], ce: [1e5, 1e5] } });
    const a = analyzeStrikes(f, bars([22300, 22500]), 1)!;
    expect(a.verdict).toBe("continuation_up");
    expect(a.bias).toBeGreaterThan(0);
    expect(a.resistance!.state).toBe("unwinding");
  });

  it("reads put writers abandoning a level into a fall as downside continuation", () => {
    const f = frameOf({ ...FLAT, 22400: { pe: [9e5, 7e5], ce: [1e5, 1e5] }, 22700: { ce: [5e5, 5e5], pe: [1e5, 1e5] } });
    const a = analyzeStrikes(f, bars([22700, 22500]), 1)!;
    expect(a.verdict).toBe("continuation_down");
    expect(a.bias).toBeLessThan(0);
  });

  it("reads fresh call writing at a level price is pressed against as reversal risk", () => {
    const f = frameOf({
      ...FLAT,
      22600: { ce: [5e5, 7e5], pe: [1e5, 1e5] }, // building resistance just above
      22200: { pe: [6e5, 6e5], ce: [1e5, 1e5] }, // distant support → high positionInRange
    });
    const a = analyzeStrikes(f, bars([22550, 22550]), 1)!;
    expect(a.verdict).toBe("reversal_from_resistance");
    expect(a.bias).toBeLessThan(0);
  });

  it("maps verdicts to trade stance symmetrically", () => {
    expect(levelSupports("continuation_up", "long")).toBe("supports");
    expect(levelSupports("continuation_up", "short")).toBe("opposes");
    expect(levelSupports("reversal_from_resistance", "long")).toBe("opposes");
    expect(levelSupports("reversal_from_support", "long")).toBe("supports");
    expect(levelSupports("range_bound", "long")).toBe("neutral");
  });

  it("finds the next wall for a target extension", () => {
    const f = frameOf({ ...FLAT, 22700: { ce: [9e5, 9e5], pe: [1e5, 1e5] } });
    const a = analyzeStrikes(f, bars([22500, 22500]), 1)!;
    expect(nextWallBeyond(a, "long", 22600)).toBe(22700);
    expect(nextWallBeyond(a, "long", 22800)).toBeNull();
  });

  it("penalises a weakening floor even when no clean verdict fires", () => {
    // support trimmed, price flat → no continuation/reversal verdict, but
    // the withdrawal of the floor must still register as a negative
    const weakening = frameOf({ ...FLAT, 22300: { pe: [9e5, 8.4e5], ce: [1e5, 1e5] }, 22700: { ce: [5e5, 5e5], pe: [1e5, 1e5] } });
    const a = analyzeStrikes(weakening, bars([22400, 22400]), 1)!;
    expect(["undecided", "range_bound"]).toContain(a.verdict);
    expect(a.bias).toBeLessThan(0);
    expect(a.notes.join(" ")).toMatch(/support is weakening/);
  });

  it("rewards a reinforced floor in the same fallback branch", () => {
    // mid-range price → range_bound, so the wall-maintenance adjustment
    // (not the near-support reversal rule) is what must fire
    const firming = frameOf({ ...FLAT, 22300: { pe: [8e5, 9e5], ce: [1e5, 1e5] }, 22700: { ce: [5e5, 5e5], pe: [1e5, 1e5] } });
    const a = analyzeStrikes(firming, bars([22500, 22500]), 1)!;
    expect(a.verdict).toBe("range_bound");
    expect(a.bias).toBeGreaterThan(0);
    expect(a.notes.join(" ")).toMatch(/floor is being reinforced/);
  });

  it("near-support writing still takes priority as a reversal signal", () => {
    const firming = frameOf({ ...FLAT, 22300: { pe: [8e5, 9e5], ce: [1e5, 1e5] }, 22700: { ce: [5e5, 5e5], pe: [1e5, 1e5] } });
    const a = analyzeStrikes(firming, bars([22400, 22400]), 1)!;
    expect(a.verdict).toBe("reversal_from_support");
    expect(levelSupports(a.verdict, "long")).toBe("supports");
  });

  it("returns null rather than inventing levels when the chain is absent", () => {
    expect(analyzeStrikes(null, bars([22500]), 0)).toBeNull();
  });
});

describe("order flow", () => {
  it("signs volume by close location within the candle", () => {
    const strong: Candle = { ts: TS0, open: 100, high: 110, low: 100, close: 110, volume: 1000, oi: null };
    const weak: Candle = { ts: TS0, open: 110, high: 110, low: 100, close: 100, volume: 1000, oi: null };
    expect(candleDelta(strong)).toBeCloseTo(1000, 6);
    expect(candleDelta(weak)).toBeCloseTo(-1000, 6);
  });

  it("reports buyers in control on a persistent advance", () => {
    const c = Array.from({ length: 30 }, (_, i) => ({
      ts: TS0 + i * STEP, open: 100 + i, high: 101 + i, low: 99.5 + i, close: 101 + i,
      volume: 5000, oi: null,
    }));
    const f = computeOrderFlow(c, 29, "spot");
    expect(f.available).toBe(true);
    expect(f.pressure).toBe("buyers");
    expect(f.score).toBeGreaterThan(0);
    expect(f.notes[0]).toMatch(/candle-derived estimate/);
  });

  it("is unavailable rather than fabricated when no volume is published", () => {
    const c = bars([100, 101, 102, 103], 0);
    expect(computeOrderFlow(c, 3, "spot").available).toBe(false);
    expect(orderFlowFor(c, null, 3).available).toBe(false);
  });

  it("falls back to futures volume for an index with none", () => {
    const spot = bars([100, 101, 102, 103, 104], 0);
    const fut = spot.map((c) => ({ ...c, volume: 8000 }));
    const f = orderFlowFor(spot, fut, 4);
    expect(f.available).toBe(true);
    expect(f.source).toBe("futures");
  });
});

/* ------------------------------------------------------------------ */

const BASE: AdvisoryInput = {
  direction: "long",
  entryPrice: 100, stop: 98, target1: 102, currentTarget: 104, lastPrice: 101,
  state: "bullish_continuation",
  regimeDirection: 1, regimeStrength: 0.6,
  levelVerdict: "continuation_up", levelBias: 0.5,
  orderFlowScore: 0.4, orderFlowAbsorption: false,
  nextWall: null, atr: 1,
};

describe("trade lifecycle advisories", () => {
  it("holds while the thesis is intact", () => {
    expect(decideAdvisory(BASE).action).toBe("hold");
  });

  it("reports a stop or target reached from real prices", () => {
    expect(decideAdvisory({ ...BASE, lastPrice: 97.9 }).action).toBe("stopped_out");
    expect(decideAdvisory({ ...BASE, lastPrice: 104.2 }).action).toBe("target_hit");
    expect(decideAdvisory({ ...BASE, direction: "short", entryPrice: 100, stop: 102, target1: 98, currentTarget: 96, lastPrice: 102.5 }).action)
      .toBe("stopped_out");
  });

  it("EXITS an open position when sentiment turns against it", () => {
    const a = decideAdvisory({
      ...BASE,
      lastPrice: 101.5, // already moved, so it is a live position
      state: "bearish_continuation",
      regimeDirection: -1, regimeStrength: 0.7,
      levelVerdict: "reversal_from_resistance", levelBias: -0.5,
      orderFlowScore: -0.4,
    });
    expect(a.action).toBe("exit");
    expect(a.adverse).toBeGreaterThanOrEqual(2);
    expect(a.reasons.join(" ")).toMatch(/Sentiment changed against an open position/);
  });

  it("says AVOID instead of EXIT when price never left the entry", () => {
    const a = decideAdvisory({
      ...BASE,
      lastPrice: 100.05, // still at entry → the trade can simply be skipped
      state: "bearish_continuation",
      regimeDirection: -1, regimeStrength: 0.7,
      levelVerdict: "reversal_from_resistance", levelBias: -0.6,
    });
    expect(a.action).toBe("avoid");
    expect(a.reasons.join(" ")).toMatch(/skip this one/i);
  });

  it("EXTENDS the target to the next option wall while momentum continues", () => {
    const a = decideAdvisory({ ...BASE, lastPrice: 102.5, nextWall: 106 });
    expect(a.action).toBe("extend_target");
    expect(a.newTarget).toBe(106);
    expect(a.reasons.join(" ")).toMatch(/next option wall at 106/);
  });

  it("extends by 1R when no further wall exists inside the band", () => {
    const a = decideAdvisory({ ...BASE, lastPrice: 102.5, nextWall: null });
    expect(a.action).toBe("extend_target");
    expect(a.newTarget).toBeCloseTo(106, 6); // 104 + 2 (1R)
  });

  it("never extends into opposing levels or flow", () => {
    expect(decideAdvisory({ ...BASE, lastPrice: 102.5, levelVerdict: "reversal_from_resistance" }).action)
      .not.toBe("extend_target");
    expect(decideAdvisory({ ...BASE, lastPrice: 102.5, orderFlowScore: -0.5 }).action)
      .not.toBe("extend_target");
  });

  it("applies the same rules symmetrically to shorts", () => {
    const short: AdvisoryInput = {
      ...BASE, direction: "short",
      entryPrice: 100, stop: 102, target1: 98, currentTarget: 96, lastPrice: 97.5,
      state: "bearish_continuation", regimeDirection: -1,
      levelVerdict: "continuation_down", levelBias: -0.5, orderFlowScore: -0.4,
      nextWall: 94,
    };
    const a = decideAdvisory(short);
    expect(a.action).toBe("extend_target");
    expect(a.newTarget).toBe(94);
  });

  it("flags exhaustion of the prevailing move as adverse evidence", () => {
    const a = decideAdvisory({ ...BASE, lastPrice: 101.5, state: "bullish_exhaustion", orderFlowScore: -0.4 });
    expect(a.adverse).toBeGreaterThanOrEqual(2);
    expect(["exit", "avoid"]).toContain(a.action);
  });
});
