import { describe, expect, it } from "vitest";
import { withConfig } from "@/lib/fmpi/config";
import { computeRegimes } from "@/lib/fmpi/regime";
import { computeSeries } from "@/lib/fmpi/engine";
import { genCandles } from "./helpers";
import type { Candle, MomentumState } from "@/lib/fmpi/types";

const cfg = withConfig();

/** Downtrend, then a sharp multi-candle retest bounce, then resumption. */
function downtrendWithBounce(bounceBars: number): Candle[] {
  const down = Array.from({ length: 110 }, () => -0.0022);
  const bounce = Array.from({ length: bounceBars }, () => +0.0085);
  const resume = Array.from({ length: 25 }, () => -0.0022);
  return genCandles(
    { n: 110 + bounceBars + 25, start: 2000, vol: 0.0003, withVolume: true },
    [...down, ...bounce, ...resume],
  );
}

const BULLISH_ENTRY: MomentumState[] = [
  "bullish_continuation", "bullish_acceleration", "bullish_momentum",
];

describe("trend regime detection", () => {
  it("identifies a sustained downtrend and uptrend", () => {
    const bear = computeRegimes(genCandles({ n: 200, drift: -0.002, vol: 0.0004 }), cfg);
    const bull = computeRegimes(genCandles({ n: 200, drift: 0.002, vol: 0.0004 }), cfg);
    expect(bear[199].direction).toBe(-1);
    expect(bull[199].direction).toBe(1);
    expect(bear[199].strength).toBeGreaterThan(cfg.regimeMinStrength);
    expect(bear[199].label).toMatch(/bear/);
    expect(bull[199].label).toMatch(/bull/);
  });

  it("reports rangebound when there is no trend", () => {
    const chop = genCandles({ n: 200, start: 1000, vol: 0.0002, withVolume: true },
      Array.from({ length: 8 }, (_, i) => (i % 2 ? 0.0012 : -0.0012)));
    expect(computeRegimes(chop, cfg)[199].direction).toBe(0);
  });

  it("is causal — a prefix produces identical regime history", () => {
    const c = downtrendWithBounce(4);
    const full = computeRegimes(c, cfg);
    const prefix = computeRegimes(c.slice(0, 100), cfg);
    for (let i = 0; i < 100; i++) {
      expect(prefix[i].direction).toBe(full[i].direction);
      expect(prefix[i].strength).toBeCloseTo(full[i].strength, 12);
    }
  });

  it("flags a counter-trend bounce as a pullback", () => {
    const regimes = computeRegimes(downtrendWithBounce(4), cfg);
    expect(regimes.slice(110, 116).some((r) => r.pullback)).toBe(true);
  });
});

describe("pullback is not mistaken for a reversal (the v2 fix)", () => {
  it("a short retest bounce inside a downtrend never reads as bullish continuation", () => {
    const candles = downtrendWithBounce(4);
    const { points } = computeSeries(candles, "5m", cfg);
    const bounce = points.slice(110, 116);
    for (const p of bounce) {
      expect(BULLISH_ENTRY).not.toContain(p.state);
    }
    // and it is explicitly labelled as a pullback inside the downtrend
    expect(bounce.some((p) => p.state === "bearish_pullback")).toBe(true);
  });

  it("explains the pullback instead of implying a buy", () => {
    const { points } = computeSeries(downtrendWithBounce(4), "5m", cfg);
    const p = points.slice(110, 116).find((x) => x.state === "bearish_pullback");
    expect(p).toBeDefined();
    expect(p!.explanation.join(" ")).toMatch(/PULLBACK inside a downtrend, not a reversal/);
    expect(p!.regime?.direction).toBe(-1);
  });

  it("counter-trend pressure is damped, so FMPI does not spike out of the bearish zone", () => {
    const candles = downtrendWithBounce(4);
    const anchored = computeSeries(candles, "5m", cfg).points;
    const unanchored = computeSeries(candles, "5m",
      withConfig({ regimeAnchor: 0, counterTrendDamping: 0, regimeFlipBars: 0 })).points;
    const peakAnchored = Math.max(...anchored.slice(110, 118).map((p) => p.value));
    const peakRaw = Math.max(...unanchored.slice(110, 118).map((p) => p.value));
    expect(peakAnchored).toBeLessThan(peakRaw);
  });

  it("a sustained reversal is still allowed through", () => {
    // long, persistent advance after the downtrend — a real regime change
    const candles = downtrendWithBounce(90);
    const { points } = computeSeries(candles, "5m", cfg);
    const late = points.slice(185, 200);
    expect(late.some((p) => BULLISH_ENTRY.includes(p.state))).toBe(true);
  });

  it("remains causal end to end with the regime layer active", () => {
    const candles = downtrendWithBounce(10);
    const full = computeSeries(candles, "5m", cfg);
    const cut = 120;
    const prefix = computeSeries(candles.slice(0, cut), "5m", cfg);
    for (let i = 0; i < cut; i++) {
      expect(prefix.points[i].value).toBe(full.points[i].value);
      expect(prefix.points[i].state).toBe(full.points[i].state);
    }
  });
});

describe("options weighting", () => {
  it("options positioning carries 50% of the composite", () => {
    expect(cfg.weights.options_positioning).toBe(0.5);
    const total = Object.values(cfg.weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("remaining weight is split across the confirming components", () => {
    const { options_positioning, ...rest } = cfg.weights;
    expect(options_positioning).toBe(0.5);
    expect(Object.values(rest).reduce((a, b) => a + b, 0)).toBeCloseTo(0.5, 10);
    for (const w of Object.values(rest)) expect(w).toBeLessThan(options_positioning);
  });
});
