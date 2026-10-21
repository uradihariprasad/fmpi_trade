import { describe, expect, it } from "vitest";
import { atr, clamp, logistic, mad, percentileRank, quantile, robustZ, stdev, Ema, Ring, tanh } from "@/lib/fmpi/math";

describe("math primitives", () => {
  it("clamps and bounds", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(tanh(100)).toBe(1);
    expect(logistic(0)).toBe(0.5);
    expect(logistic(100) ).toBeGreaterThan(0.9999999);
  });
  it("quantile is exact on known data", () => {
    const s = Array.from({ length: 101 }, (_, i) => i); // 0..100
    expect(quantile(s, 50)).toBe(50);
    expect(quantile(s, 5)).toBeCloseTo(5, 6);
    expect(quantile(s, 95)).toBeCloseTo(95, 6);
  });
  it("robustZ resists outliers", () => {
    const xs = [1, 2, 3, 2, 1, 2, 3, 2, 1, 2_000_000];
    expect(Math.abs(robustZ(3, xs))).toBeLessThan(3.1);
    expect(stdev(xs)).toBeGreaterThan(1000); // std explodes, MAD does not
    expect(mad(xs)).toBeLessThan(2);
  });
  it("percentileRank is 0..1 inclusive of the point", () => {
    expect(percentileRank([1, 2, 3, 4], 3)).toBe(0.75);
    expect(percentileRank([], 5)).toBe(0.5);
  });
  it("EMA is causal and converges to the input level", () => {
    const e = new Ema(0.4);
    let v = 0;
    for (let i = 0; i < 50; i++) v = e.next(10);
    expect(v).toBeGreaterThan(9.9);
    expect(e.next(0)).toBeLessThan(7);
  });
  it("Ring evicts oldest beyond capacity", () => {
    const r = new Ring(3);
    [1, 2, 3, 4, 5].forEach((x) => r.push(x));
    expect(r.values).toEqual([3, 4, 5]);
  });
  it("atr is positive and causal", () => {
    const h = [10, 11, 12, 13, 14];
    const l = [9, 9.5, 10, 11, 12];
    const c = [9.5, 10.5, 11.5, 12.5, 13.5];
    expect(atr(h, l, c, 4, 3)).toBeGreaterThan(0);
    expect(atr(h, l, c, 0, 3)).toBe(0);
  });
});
