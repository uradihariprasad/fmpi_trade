import type { DataQuality, MomentumState, ZoneId } from "@/lib/fmpi/types";

export function fmtNum(x: number | null | undefined, d = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return x.toFixed(d);
}

export function fmtSigned(x: number | null | undefined, d = 1): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return `${x > 0 ? "+" : ""}${x.toFixed(d)}`;
}

export function fmtPrice(x: number): string {
  return x >= 5000
    ? x.toLocaleString("en-IN", { maximumFractionDigits: 1, minimumFractionDigits: 1 })
    : x.toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

export const STATE_LABEL: Record<MomentumState, string> = {
  bullish_acceleration: "BULLISH ACCELERATION",
  bullish_continuation: "BULLISH CONTINUATION",
  bullish_momentum: "BULLISH MOMENTUM",
  bullish_exhaustion: "BULLISH EXHAUSTION",
  bullish_reversal_watch: "BULL REVERSAL WATCH",
  bearish_acceleration: "BEARISH ACCELERATION",
  bearish_continuation: "BEARISH CONTINUATION",
  bearish_momentum: "BEARISH MOMENTUM",
  bearish_exhaustion: "BEARISH EXHAUSTION",
  bearish_reversal_watch: "BEAR REVERSAL WATCH",
  bearish_pullback: "DOWNTREND · PULLBACK",
  bullish_pullback: "UPTREND · PULLBACK",
  neutral: "NEUTRAL / CHOPPY",
  transition: "TRANSITION",
  conflicting_signals: "CONFLICTING SIGNALS",
  insufficient_data: "INSUFFICIENT DATA",
};

export function stateColor(s: MomentumState | null | undefined): string {
  switch (s) {
    case "bullish_acceleration": return "#6dffa9";
    case "bullish_continuation": return "#2fd47b";
    case "bullish_momentum": return "#27ae60";
    case "bullish_exhaustion": return "#f5b53f";
    case "bullish_reversal_watch": return "#fb923c";
    case "bearish_acceleration": return "#ff5d7e";
    case "bearish_continuation": return "#f0506e";
    case "bearish_momentum": return "#d13a56";
    case "bearish_exhaustion": return "#f5b53f";
    case "bearish_reversal_watch": return "#fb923c";
    // pullbacks keep the colour of the PREVAILING trend, not the bounce
    case "bearish_pullback": return "#d13a56";
    case "bullish_pullback": return "#27ae60";
    case "neutral": return "#7c93b8";
    case "transition": return "#9aa9c2";
    case "conflicting_signals": return "#c084fc";
    default: return "#6b7280";
  }
}

export const ZONE_META: Record<ZoneId, { label: string; color: string; fill: string }> = {
  overbought: { label: "Dynamic Overbought", color: "#f5b53f", fill: "rgba(245,181,63,0.10)" },
  bullish: { label: "Strong Bullish", color: "#2fd47b", fill: "rgba(47,212,123,0.075)" },
  equilibrium: { label: "Equilibrium", color: "#7c93b8", fill: "rgba(124,147,184,0.06)" },
  bearish: { label: "Strong Bearish", color: "#f0506e", fill: "rgba(240,80,110,0.075)" },
  oversold: { label: "Dynamic Oversold", color: "#f5b53f", fill: "rgba(245,181,63,0.10)" },
};

export function qualityMeta(q: DataQuality | undefined): { label: string; color: string } {
  switch (q) {
    case "valid": return { label: "VALID", color: "#2fd47b" };
    case "partial": return { label: "PARTIAL", color: "#f5b53f" };
    case "stale": return { label: "STALE FEED", color: "#fb923c" };
    case "warming_up": return { label: "WARMING UP", color: "#7c93b8" };
    default: return { label: "UNAVAILABLE", color: "#6b7280" };
  }
}
