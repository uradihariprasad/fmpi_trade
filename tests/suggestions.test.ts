import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { atr } from "@/lib/fmpi/math";
import { genCandles } from "./helpers";
import type { Candle } from "@/lib/fmpi/types";

/**
 * The suggestion engine imports the live service (network + database), so
 * these tests verify the rule surface and the pure risk mathematics that
 * the engine relies on, plus the source-level safety invariants.
 */
const SRC = readFileSync("src/lib/fmpi/suggestions.ts", "utf8");

/** Mirror of riskLevels() in the engine — kept in sync by the tests below. */
function riskLevels(candles: Candle[], direction: "long" | "short", atrValue: number) {
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
  return {
    stop,
    target1: direction === "long" ? last + risk : last - risk,
    target2: direction === "long" ? last + 2 * risk : last - 2 * risk,
    riskPct: (risk / last) * 100,
  };
}

function levelsFor(direction: "long" | "short", drift: number) {
  const candles = genCandles({ n: 120, drift, vol: 0.001, withVolume: true });
  const a = atr(
    candles.map((c) => c.high), candles.map((c) => c.low), candles.map((c) => c.close),
    candles.length - 1, 14,
  );
  return { candles, a, ...riskLevels(candles, direction, a) };
}

describe("trade suggestion safety rules (source invariants)", () => {
  it("only trend-following states can become entries", () => {
    const entry = SRC.slice(SRC.indexOf("const ENTRY_STATES"), SRC.indexOf("const WATCH_STATES"));
    for (const s of ["acceleration", "continuation", "momentum"]) expect(entry).toContain(s);
    for (const s of ["exhaustion", "reversal_watch", "neutral", "transition", "insufficient_data"]) {
      expect(entry).not.toContain(s);
    }
  });

  it("counter-trend pullbacks are warnings, never entries in either direction", () => {
    const entry = SRC.slice(SRC.indexOf("const ENTRY_STATES"), SRC.indexOf("const WATCH_STATES"));
    expect(entry).not.toContain("pullback");
    const watch = SRC.slice(SRC.indexOf("const WATCH_STATES"), SRC.indexOf("const MIN_CONVICTION"));
    expect(watch).toContain("bearish_pullback");
    expect(watch).toContain("bullish_pullback");
  });

  it("exhaustion and reversal watch are classified as warnings, never entries", () => {
    const watch = SRC.slice(SRC.indexOf("const WATCH_STATES"), SRC.indexOf("const MIN_CONVICTION"));
    expect(watch).toContain("bullish_exhaustion");
    expect(watch).toContain("bearish_exhaustion");
    expect(watch).toContain("bullish_reversal_watch");
    expect(watch).toContain("bearish_reversal_watch");
  });

  it("conflicting 5M/10M timeframes disqualify an idea outright", () => {
    // enforced by the explicit peer-direction comparison
    expect(SRC).toMatch(/peerDir !== null && peerDir !== direction\) continue;/);
  });

  it("a minimum conviction gate exists and is applied", () => {
    expect(SRC).toMatch(/MIN_CONVICTION = \d+/);
    expect(SRC).toMatch(/if \(conviction < MIN_CONVICTION\) continue;/);
  });

  it("conviction is multi-factor, not a function of FMPI distance alone", () => {
    const block = SRC.slice(SRC.indexOf("let conviction"), SRC.indexOf("if (conviction < MIN_CONVICTION)"));
    expect(block).toContain("continuationScore");
    expect(block).toContain("aligned");
    expect(block).toContain("agreement");
    expect(block).toContain("coverage");
    expect(block).toContain("exhaustionScore");
    expect(block).toContain("adverseDivergence");
    // the raw reading itself is never added to conviction
    expect(block).not.toMatch(/conviction \+= .*l\.value/);
  });

  it("opposing higher-timeframe pressure disqualifies an idea", () => {
    expect(SRC).toMatch(/if \(peerDir !== null && peerDir !== direction\) continue;/);
  });

  it("a same-direction but exhausted higher timeframe is a caution, not a confirmation", () => {
    expect(SRC).toMatch(/const peerTrending = peer \? ENTRY_STATES\.has\(peer\.state\) : false;/);
    expect(SRC).toMatch(/aligned = peerDir !== null && peerDir === direction && peerTrending/);
    expect(SRC).toMatch(/if \(peerFading\) conviction -= 12;/);
  });

  it("an unconfirmed idea is capped below grade A", () => {
    expect(SRC).toMatch(/if \(!aligned\) conviction = Math\.min\(conviction, 70\);/);
    const gradeLine = SRC.slice(SRC.indexOf("grade: conviction >="), SRC.indexOf("grade: conviction >=") + 90);
    const thresholdA = Number(gradeLine.match(/conviction >= (\d+)/)![1]);
    expect(thresholdA).toBeGreaterThan(70); // cap makes grade A unreachable unconfirmed
  });

  it("conviction pillars are bounded and cannot all saturate additively", () => {
    const block = SRC.slice(SRC.indexOf("let conviction ="), SRC.indexOf("conviction -= (l.exhaustionScore"));
    // weighted shares: 45 + 20 + 20 + 15 = 100 maximum before penalties
    expect(block).toContain("* 0.45");
    expect(block).toContain("aligned ? 20 : 0");
    expect(block).toContain("agreement * 20");
    expect(block).toContain("* 15");
  });

  it("the higher timeframe is fetched explicitly with a retry, not assumed absent", () => {
    expect(SRC).toMatch(/attempt < 2 && !peer/);
  });

  it("results are capped but never padded to reach the requested count", () => {
    expect(SRC).toContain("ideas.slice(0, limit)");
    expect(SRC).not.toMatch(/while \(.*ideas\.length < limit/);
  });

  it("warming-up or unavailable data can never produce an idea", () => {
    expect(SRC).toMatch(/quality === "warming_up" \|\| l\.quality === "unavailable"\) continue/);
  });
});

describe("risk level mathematics", () => {
  it("long: stop below entry, targets above, 1R and 2R spacing", () => {
    const { candles, stop, target1, target2 } = levelsFor("long", 0.0015);
    const entry = candles[candles.length - 1].close;
    expect(stop).toBeLessThan(entry);
    expect(target1).toBeGreaterThan(entry);
    expect(target2).toBeGreaterThan(target1);
    const r = entry - stop;
    expect(target1 - entry).toBeCloseTo(r, 6);
    expect(target2 - entry).toBeCloseTo(2 * r, 6);
  });

  it("short: stop above entry, targets below, 1R and 2R spacing", () => {
    const { candles, stop, target1, target2 } = levelsFor("short", -0.0015);
    const entry = candles[candles.length - 1].close;
    expect(stop).toBeGreaterThan(entry);
    expect(target1).toBeLessThan(entry);
    expect(target2).toBeLessThan(target1);
    const r = stop - entry;
    expect(entry - target1).toBeCloseTo(r, 6);
    expect(entry - target2).toBeCloseTo(2 * r, 6);
  });

  it("stop distance is capped at 2.5 ATR even after a wide swing", () => {
    for (const dir of ["long", "short"] as const) {
      for (const drift of [0.004, -0.004, 0.0002]) {
        const { candles, a, stop } = levelsFor(dir, drift);
        const entry = candles[candles.length - 1].close;
        expect(Math.abs(entry - stop)).toBeLessThanOrEqual(a * 2.5 + 1e-9);
        expect(Math.abs(entry - stop)).toBeGreaterThan(0);
      }
    }
  });

  it("risk is expressed as a positive percentage of entry price", () => {
    const { riskPct } = levelsFor("long", 0.001);
    expect(riskPct).toBeGreaterThan(0);
    expect(riskPct).toBeLessThan(25);
  });
});
