import { describe, expect, it } from "vitest";
import { optionsReadingAt } from "@/lib/fmpi/options";
import type { OptionsFrame, OptionPoint } from "@/lib/market/optionsFrame";
import type { Candle } from "@/lib/fmpi/types";

const TS0 = Date.UTC(2026, 9, 9, 3, 45);
const STEP = 5 * 60_000;

function candles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    ts: TS0 + i * STEP, open: c, high: c + 2, low: c - 2, close: c, volume: 1000, oi: null,
  }));
}

/** Builds a frame where CE/PE OI grow by the supplied per-bar deltas. */
function frameWith(opts: {
  strikes: number[]; bars: number; ceDelta: number; peDelta: number;
  ceBase?: number; peBase?: number; ceVol?: number; peVol?: number;
  /** per-bar premium drift; negative = premium falling = writer-led */
  cePrem?: number; pePrem?: number;
}): OptionsFrame {
  const ce = new Map<number, Map<number, OptionPoint>>();
  const pe = new Map<number, Map<number, OptionPoint>>();
  for (const s of opts.strikes) {
    const cs = new Map<number, OptionPoint>();
    const ps = new Map<number, OptionPoint>();
    for (let i = 0; i < opts.bars; i++) {
      cs.set(TS0 + i * STEP, {
        oi: (opts.ceBase ?? 100_000) + i * opts.ceDelta,
        vol: opts.ceVol ?? 5_000,
        close: 100 + i * (opts.cePrem ?? 0),
      });
      ps.set(TS0 + i * STEP, {
        oi: (opts.peBase ?? 100_000) + i * opts.peDelta,
        vol: opts.peVol ?? 5_000,
        close: 100 + i * (opts.pePrem ?? 0),
      });
    }
    ce.set(s, cs);
    pe.set(s, ps);
  }
  return {
    expiryDate: "2026-10-13", strikeStep: 50, strikes: [...opts.strikes].sort((a, b) => a - b),
    ce, pe, contracts: opts.strikes.length * 2, from: TS0,
    note: "test frame",
  };
}

const STRIKES = [22400, 22450, 22500, 22550, 22600];

describe("options positioning component", () => {
  it("reads put WRITING (PE OI up, premium down) as bullish support", () => {
    const c = candles([22500, 22500, 22500, 22500]);
    const f = frameWith({ strikes: STRIKES, bars: 4, ceDelta: 0, peDelta: 40_000, pePrem: -4 });
    const r = optionsReadingAt(f, c, 3);
    expect(r.available).toBe(true);
    expect(r.score!).toBeGreaterThan(0);
    expect(r.evidence.join(" ")).toMatch(/OI flow supportive/);
  });

  it("reads put LONG BUILDUP (PE OI up, premium up) as bearish", () => {
    const c = candles([22500, 22500, 22500, 22500]);
    const f = frameWith({ strikes: STRIKES, bars: 4, ceDelta: 0, peDelta: 40_000, pePrem: +4 });
    expect(optionsReadingAt(f, c, 3).score!).toBeLessThan(0);
  });

  it("reads call WRITING (CE OI up, premium down) as bearish resistance", () => {
    const c = candles([22500, 22500, 22500, 22500]);
    const f = frameWith({ strikes: STRIKES, bars: 4, ceDelta: 40_000, peDelta: 0, cePrem: -4 });
    const r = optionsReadingAt(f, c, 3);
    expect(r.score!).toBeLessThan(0);
    expect(r.evidence.join(" ")).toMatch(/OI flow capping/);
  });

  it("surfaces OI walls as support and resistance levels", () => {
    const c = candles([22500, 22500]);
    const f = frameWith({ strikes: STRIKES, bars: 2, ceDelta: 1_000, peDelta: 1_000, pePrem: -1 });
    expect(optionsReadingAt(f, c, 1).evidence.join(" ")).toMatch(/OI walls: support \d+ .* resistance \d+/);
  });

  
  
  it("stays bounded in [-1, 1] and reports PCR + expiry", () => {
    const c = candles([22500, 22500, 22500]);
    const f = frameWith({ strikes: STRIKES, bars: 3, ceDelta: 0, peDelta: 5_000_000, peBase: 9_000_000 });
    const r = optionsReadingAt(f, c, 2);
    expect(r.score!).toBeLessThanOrEqual(1);
    expect(r.score!).toBeGreaterThanOrEqual(-1);
    expect(r.evidence[0]).toMatch(/PCR\(OI\) \d/);
    expect(r.evidence[0]).toMatch(/exp 2026-10-13/);
  });

  it("is causal — the reading at bar i ignores later bars entirely", () => {
    const c = candles([22500, 22500, 22500, 22500, 22500]);
    const full = frameWith({ strikes: STRIKES, bars: 5, ceDelta: 10_000, peDelta: 60_000 });
    const truncated = frameWith({ strikes: STRIKES, bars: 3, ceDelta: 10_000, peDelta: 60_000 });
    const a = optionsReadingAt(full, c, 2);
    const b = optionsReadingAt(truncated, c.slice(0, 3), 2);
    expect(b.score).toBe(a.score);
    expect(b.evidence).toEqual(a.evidence);
  });

  it("tracks ATM from the candle's own close, not a later price", () => {
    const c = candles([22400, 22600]);
    const f = frameWith({ strikes: STRIKES, bars: 2, ceDelta: 1_000, peDelta: 2_000 });
    expect(optionsReadingAt(f, c, 0).evidence[0]).toMatch(/ATM 22400/);
    expect(optionsReadingAt(f, c, 1).evidence[0]).toMatch(/ATM 22600/);
  });

  it("reports unavailable instead of fabricating when data is missing", () => {
    const c = candles([22500, 22500]);
    expect(optionsReadingAt(null, c, 1).available).toBe(false);
    // candle before the reconstructed window
    const f = frameWith({ strikes: STRIKES, bars: 2, ceDelta: 1, peDelta: 1 });
    const older: Candle[] = [{ ...c[0], ts: TS0 - 10 * STEP }, ...c];
    const r = optionsReadingAt(f, older, 0);
    expect(r.available).toBe(false);
    expect(r.score).toBeNull();
    expect(r.evidence[0]).toMatch(/outside the reconstructed option window/);
  });

  it("requires enough strikes around the money", () => {
    const c = candles([22500]);
    const thin = frameWith({ strikes: [22500], bars: 1, ceDelta: 0, peDelta: 0 });
    const r = optionsReadingAt(thin, c, 0);
    expect(r.available).toBe(false);
    expect(r.evidence[0]).toMatch(/too few strikes/);
  });
});
