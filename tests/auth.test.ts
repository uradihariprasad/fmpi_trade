import { describe, expect, it } from "vitest";
import { comparePasscode, maskToken, tokenExpiryFrom } from "@/lib/market/token";
import { istDateStr, istMinutes } from "@/lib/market/session";

describe("Upstox session handling", () => {
  it("expires at 03:30 IST the next morning when issued during market hours", () => {
    const issued = Date.UTC(2026, 9, 12, 4, 0); // 09:30 IST, 12 Oct
    const exp = tokenExpiryFrom(issued);
    expect(istDateStr(exp.getTime())).toBe("2026-10-13");
    expect(istMinutes(exp.getTime())).toBe(3 * 60 + 30);
    expect(exp.getTime()).toBeGreaterThan(issued);
  });

  it("expires at 03:30 IST the same morning when issued just after midnight", () => {
    const issued = Date.UTC(2026, 9, 11, 19, 0); // 00:30 IST, 12 Oct
    const exp = tokenExpiryFrom(issued);
    expect(istDateStr(exp.getTime())).toBe("2026-10-12");
    expect(istMinutes(exp.getTime())).toBe(3 * 60 + 30);
    expect(exp.getTime() - issued).toBeLessThan(4 * 3600_000);
  });

  it("always produces a future expiry", () => {
    for (const h of [0, 3, 4, 9, 15, 21, 23]) {
      const issued = Date.UTC(2026, 9, 12, h, 17);
      expect(tokenExpiryFrom(issued).getTime()).toBeGreaterThan(issued);
    }
  });

  it("masks tokens so the raw value never leaks", () => {
    const token = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.SECRETBODY.sig";
    const masked = maskToken(token);
    expect(masked).toBe("eyJ0••••.sig");
    expect(masked).not.toContain("SECRETBODY");
    expect(maskToken("short")).toBe("••••");
  });

  it("passcode gate is open when unset and strict when set", () => {
    expect(comparePasscode(undefined, null)).toBe(true);
    expect(comparePasscode("s3cret", "s3cret")).toBe(true);
    expect(comparePasscode("s3cret", "wrong!")).toBe(false);
    expect(comparePasscode("s3cret", null)).toBe(false);
    expect(comparePasscode("s3cret", "s3cre")).toBe(false);
  });
});
