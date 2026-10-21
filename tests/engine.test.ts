import { describe, expect, it } from "vitest";
import { withConfig } from "@/lib/fmpi/config";
import { computeSeries, combineStates } from "@/lib/fmpi/engine";
import type { Candle } from "@/lib/fmpi/types";
import { genCandles, peakPattern } from "./helpers";

const cfg = withConfig();

describe("FMPI engine — hard guarantees", () => {
  const candles = genCandles({ n: 400, drift: 0.0006, withVolume: true });

  it("every value stays bounded in [0, 100]", () => {
    const r = computeSeries(candles, "5m", cfg);
    for (const p of r.points) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.value).toBeLessThanOrEqual(100);
    }
  });

  it("is causal: prefix recomputation reproduces the original history exactly (no repaint)", () => {
    const full = computeSeries(candles, "5m", cfg);
    const cut = 260;
    const prefix = computeSeries(candles.slice(0, cut), "5m", cfg);
    for (let i = 0; i < cut; i++) {
      expect(prefix.points[i].value).toBe(full.points[i].value);
      expect(prefix.points[i].state).toBe(full.points[i].state);
      const az = full.points[i].zoneBoundaries;
      const bz = prefix.points[i].zoneBoundaries;
      if (az && bz) {
        expect(bz.oversoldUpper).toBe(az.oversoldUpper);
        expect(bz.overboughtLower).toBe(az.overboughtLower);
      } else {
        expect(bz).toBe(az);
      }
    }
  });

  it("zones are dynamic and ordered; they differ between regimes", () => {
    const up = computeSeries(genCandles({ n: 400, drift: 0.0018, vol: 0.001, withVolume: true }), "5m", cfg);
    const down = computeSeries(genCandles({ n: 400, drift: -0.0018, vol: 0.001, withVolume: true }), "5m", cfg);
    expect(up.zones).not.toBeNull();
    expect(down.zones).not.toBeNull();
  const z = up.zones!;
    expect(z.oversoldLower).toBeLessThanOrEqual(z.oversoldUpper);
    expect(z.oversoldUpper).toBeLessThanOrEqual(z.equilibriumLower);
    expect(z.equilibriumLower).toBeLessThanOrEqual(z.equilibriumUpper);
    expect(z.equilibriumUpper).toBeLessThanOrEqual(z.overboughtLower);
    expect(z.overboughtLower).toBeLessThanOrEqual(z.overboughtUpper);
    expect(z.samples).toBeGreaterThanOrEqual(cfg.zoneMinSamples);
    // a persistent uptrend lifts the overbought threshold relative to a downtrend
    expect(up.zones!.overboughtLower).toBeGreaterThan(down.zones!.overboughtLower);
  });

  it("does not appear before the warm-up window and flags insufficient data", () => {
    const short = computeSeries(genCandles({ n: 20, withVolume: true }), "5m", cfg);
    expect(short.zones).toBeNull();
    for (const p of short.points) {
      expect(p.state).toBe("insufficient_data");
      expect(p.quality).toBe("warming_up");
    }
  });

  it("extreme zones never flip sides: overbought ⇒ bullish-family, oversold ⇒ bearish-family", () => {
    const series = [
      computeSeries(genCandles({ n: 350, drift: 0.0028, vol: 0.0008, withVolume: true }), "5m", cfg),
      computeSeries(genCandles({ n: 350, drift: -0.0028, vol: 0.0008, withVolume: true }), "5m", cfg),
      computeSeries(genCandles({ n: 350, drift: 0.0005, vol: 0.0018, withVolume: true }), "5m", cfg),
    ];
    let sawOverbought = 0, sawOversold = 0;
    for (const r of series) {
      for (const p of r.points) {
        if (p.zone === "overbought") { sawOverbought++; expect(p.state).toMatch(/^bullish|^neutral|^transition/); }
        if (p.zone === "oversold") { sawOversold++; expect(p.state).toMatch(/^bearish|^neutral|^transition/); }
        // reversal watch is only allowed with corroborating divergence
        if (p.state === "bullish_reversal_watch") expect(p.divergence).toMatch(/bearish/);
        if (p.state === "bearish_reversal_watch") expect(p.divergence).toMatch(/bullish/);
      }
    }
    expect(sawOverbought).toBeGreaterThan(0);
    expect(sawOversold).toBeGreaterThan(0);
  });

  it("a strong trend reads as continuation-family, never as an automatic reversal trade", () => {
    const up = computeSeries(genCandles({ n: 350, drift: 0.0028, vol: 0.0008, withVolume: true }), "5m", cfg);
    const obPts = up.points.filter((p) => p.zone === "overbought");
    expect(obPts.length).toBeGreaterThan(3);
    const states = new Set(obPts.map((p) => p.state));
    // none of the extreme-zone states may be a bearish action
    for (const s of states) expect(s.startsWith("bullish") || s === "neutral" || s === "transition").toBe(true);
    const last = up.points[up.points.length - 1];
    expect(last.state).not.toMatch(/reversal_watch/);
    const down = computeSeries(genCandles({ n: 350, drift: -0.0028, vol: 0.0008, withVolume: true }), "10m", cfg);
    const osPts = down.points.filter((p) => p.zone === "oversold");
    expect(osPts.length).toBeGreaterThan(3);
    for (const p of osPts) expect(p.state.startsWith("bullish")).toBe(false); // no auto-buy on extreme lows
  });

  it("labels missing components honestly and shrinks coverage", () => {
    const indexLike = genCandles({ n: 300, withVolume: false }); // volume unavailable (like NIFTY)
    const r = computeSeries(indexLike, "5m", cfg);
    const last = r.points[r.points.length - 1];
    expect(last.missingComponents).toContain("volume_participation");
    expect(last.missingComponents).toContain("futures_positioning");
    expect(last.missingComponents).toContain("options_positioning");
    expect(last.coverage).toBeLessThan(1);
    expect(last.explanation.join(" ")).toMatch(/Volume evidence excluded/);
  });

  it("swing pivots confirm only after the confirmation window (never backdated)", () => {
    const candles2 = peakPattern();
    const r = computeSeries(candles2, "5m", cfg);
    const confirmedPeaks = r.turningPoints.filter((t) => t.kind === "peak" && t.confirmed);
    expect(confirmedPeaks.length).toBeGreaterThan(0);
    for (const t of confirmedPeaks) {
      expect(t.confirmedTs).not.toBeNull();
      const piv = candles2[t.index].ts;
      expect(t.confirmedTs!).toBeGreaterThan(piv); // became knowable strictly later
      const delayMs = t.confirmedTs! - piv;
      expect(delayMs).toBeGreaterThanOrEqual(cfg.swingConfirmBars * 5 * 60_000);
      expect(t.value).toBeGreaterThan(0);
      expect(t.value).toBeLessThanOrEqual(100);
    }
  });

  it("5m and 10m engines run independently on their own candles", () => {
    const five = computeSeries(genCandles({ n: 390, withVolume: true, drift: 0.0004 }), "5m", cfg);
    const ten = computeSeries(genCandles({ n: 390, withVolume: true, drift: 0.0004, tfMs: 600_000 }), "10m", cfg);
    expect(five.points[five.points.length - 1].value).not.toBe(ten.points[ten.points.length - 1].value);
  });
});

describe("multi-timeframe conflicts (Scenario E)", () => {
  it("flags conflicting zones without overwriting either reading", () => {
    const combo = combineStates(
      { value: 82, zone: "overbought", state: "bullish_continuation" },
      { value: 18, zone: "oversold", state: "bearish_continuation" },
    );
    expect(combo.combined).toBe("conflicting_signals");
    expect(combo.note).toMatch(/timeframes disagree/i);
  });
  it("passes through agreement", () => {
    const combo = combineStates(
      { value: 70, zone: "bullish", state: "bullish_continuation" },
      { value: 66, zone: "bullish", state: "bullish_continuation" },
    );
    expect(combo.combined).toBe("bullish_continuation");
  });

  it("treats different intensities of the same direction as agreement", () => {
    const combo = combineStates(
      { value: 21, zone: "oversold", state: "bearish_continuation" },
      { value: 38, zone: "bearish", state: "bearish_momentum" },
    );
    expect(combo.combined).toBe("bearish_continuation");
    expect(combo.note).toMatch(/agree on direction/);
  });

  it("downgrades to transition when one timeframe is undecided", () => {
    const combo = combineStates(
      { value: 72, zone: "bullish", state: "bullish_continuation" },
      { value: 52, zone: "equilibrium", state: "transition" },
    );
    expect(combo.combined).toBe("transition");
  });
});
