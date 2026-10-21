import { describe, expect, it } from "vitest";
import {
  fmtIstTime, gridpointMs, istDateStr, lastCompletedOpen, marketPhase,
  sessionGrid, SESSION_CLOSE_MIN, SESSION_OPEN_MIN,
} from "@/lib/market/session";

describe("exchange session grid", () => {
  it("5-minute grid yields 75 aligned opens", () => {
    const g = sessionGrid(5);
    expect(g[0]).toBe(SESSION_OPEN_MIN);
    expect(g[g.length - 1]).toBe(SESSION_CLOSE_MIN - 5);
    expect(g.length).toBe(75);
  });
  it("10-minute grid yields 38 opens with a truncated closing candle", () => {
    const g = sessionGrid(10);
    expect(g.length).toBe(38);
    const last = g[g.length - 1];
    expect(SESSION_CLOSE_MIN - last).toBe(5); // 15:25→15:30 truncated candle
  });
  it("gridpoints convert IST minutes to UTC correctly", () => {
    const open = gridpointMs("2026-10-09", SESSION_OPEN_MIN);
    expect(istDateStr(open)).toBe("2026-10-09");
    expect(fmtIstTime(open)).toBe("09:15");
    expect(new Date(open).toISOString()).toBe("2026-10-09T03:45:00.000Z");
  });
  it("lastCompletedOpen respects candle duration", () => {
    const at = gridpointMs("2026-10-09", 10 * 60); // exactly 10:00 IST
    expect(lastCompletedOpen(at, 5)).toBe(9 * 60 + 55); // 09:55 candle just closed
    const beforeClose = gridpointMs("2026-10-09", 15 * 60 + 29); // 15:29 IST
    // 10m grid opens: …15:05, 15:15, 15:25 — the 15:15 candle (15:15→15:25) is
    // done at 15:29; the final truncated 15:25→15:30 candle is still forming
    expect(lastCompletedOpen(beforeClose, 10)).toBe(15 * 60 + 15);
    const afterClose = gridpointMs("2026-10-09", 15 * 60 + 31);
    expect(lastCompletedOpen(afterClose, 10)).toBe(15 * 60 + 25);
  });
  it("market phase respects weekends", () => {
    const saturday = Date.UTC(2026, 9, 10, 6, 0); // Sat 11:30 IST
    expect(marketPhase(saturday)).toBe("closed");
    const wednesday = Date.UTC(2026, 9, 7, 4, 0); // Wed 09:30 IST
    expect(marketPhase(wednesday)).toBe("open");
  });
});
