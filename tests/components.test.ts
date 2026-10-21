import { describe, expect, it } from "vitest";
import { withConfig } from "@/lib/fmpi/config";
import { futuresPositioning, optionsPositioning, volumeParticipation, pricePressure } from "@/lib/fmpi/components";
import type { Candle, FuturesFrame } from "@/lib/fmpi/types";
import { genCandles } from "./helpers";

const cfg = withConfig();

function fr(spot: Candle[], rows: [number, Partial<Candle>][]): FuturesFrame {
  const byTs = new Map<number, Candle>();
  for (const [i, patch] of rows) {
    const base = spot[i];
    byTs.set(base.ts, { ...base, ...patch });
  }
  return { byTs, spotTs: new Set(spot.map((c) => c.ts)) };
}

describe("futures positioning — price/OI classification", () => {
  const spot = genCandles({ n: 80, withVolume: false });

  it("price↑ + OI↑ = long buildup (positive evidence)", () => {
    const i = 60;
    const frame = fr(spot, [
      [i - 1, { close: spot[i - 1].close * 0.99, oi: 1_000_000 }],
      [i, { close: spot[i].close * 1.01, oi: 1_020_000 }],
    ]);
    const r = futuresPositioning(spot, i, frame);
    expect(r.available).toBe(true);
    expect(r.score!).toBeGreaterThan(0);
    expect(r.evidence.join(" ")).toMatch(/long buildup/);
  });

  it("price↓ + OI↑ = short buildup (negative evidence)", () => {
    const i = 60;
    const frame = fr(spot, [
      [i - 1, { close: spot[i - 1].close * 1.02, oi: 1_000_000 }],
      [i, { close: spot[i].close * 0.98, oi: 1_030_000 }],
    ]);
    const r = futuresPositioning(spot, i, frame);
    expect(r.score!).toBeLessThan(0);
    expect(r.evidence.join(" ")).toMatch(/short buildup/);
  });

  it("price↑ + OI↓ = short covering (moderate positive)", () => {
    const i = 60;
    const frame = fr(spot, [
      [i - 1, { close: spot[i - 1].close * 0.99, oi: 1_000_000 }],
      [i, { close: spot[i].close * 1.01, oi: 980_000 }],
    ]);
    const r = futuresPositioning(spot, i, frame);
    expect(r.evidence.join(" ")).toMatch(/short covering/);
  });

  it("missing OI is never substituted with zero", () => {
    const i = 60;
    const frame = fr(spot, [[i, { close: spot[i].close * 1.01, oi: null }]]);
    const r = futuresPositioning(spot, i, frame);
    expect(r.available).toBe(false);
    expect(r.evidence.join(" ")).toMatch(/never substituted/);
  });

  it("no futures contract → unavailable, not fabricated", () => {
    const r = futuresPositioning(spot, 60, null);
    expect(r.available).toBe(false);
    expect(r.score).toBeNull();
  });
});

describe("volume participation", () => {
  it("is unavailable when the exchange supplies no volume (indices)", () => {
    const c = genCandles({ n: 60, withVolume: false });
    const r = volumeParticipation(c, 50, cfg);
    expect(r.available).toBe(false);
    expect(r.score).toBeNull();
  });
  it("scores positive on volume-confirmed up moves", () => {
    const c = genCandles({ n: 90, drift: 0.004, vol: 0.0004, withVolume: true });
    const r = volumeParticipation(c, 89, cfg);
    expect(r.available).toBe(true);
  });
});

describe("component sanity", () => {
  it("price pressure is positive across a steady advance", () => {
    const c = genCandles({ n: 120, drift: 0.0035, vol: 0.0005, withVolume: true });
    const r = pricePressure(c, 119, cfg);
    expect(r.score!).toBeGreaterThan(0.15);
  });
  it("options component passes through a supplied per-candle reading", () => {
    const supplied = { score: 0.42, available: true, evidence: ["PCR(OI) 1.30"] };
    expect(optionsPositioning(supplied)).toBe(supplied);
  });

  it("options component reports missing rather than fabricating a neutral score", () => {
    const r = optionsPositioning(null);
    expect(r.available).toBe(false);
    expect(r.score).toBeNull();
    expect(r.evidence.join(" ")).toMatch(/not fabricated/);
  });
});
