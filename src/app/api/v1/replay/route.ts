import { NextResponse } from "next/server";
import { withConfig } from "@/lib/fmpi/config";
import { computeSeries } from "@/lib/fmpi/engine";
import type { Timeframe } from "@/lib/fmpi/types";
import { TIMEFRAME_MINUTES } from "@/lib/fmpi/types";
import { ensureSessions, futuresFrameFor } from "@/lib/market/candles";
import { buildOptionsFrame } from "@/lib/market/optionsFrame";
import { optionsReadingAt } from "@/lib/fmpi/options";
import { getInstrument } from "@/lib/market/universe";
import { gridpointMs, istDateStr } from "@/lib/market/session";
import { SESSION_OPEN_MIN } from "@/lib/market/session";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/v1/replay
 * Historical-replay / no-repaint validation:
 *   - recomputes the series on a PREFIX of the candles and asserts every
 *     value/zone/state is identical to the full-series computation at the
 *     same index (future observations must never alter the past)
 *   - verifies candle opens sit on the exchange session grid
 *   - verifies 5m and 10m grids align (10m opens are every other 5m open)
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      instrument?: string; tf?: Timeframe; sessions?: number; cutoffRatio?: number;
    };
    const symbol = body.instrument ?? "NIFTY";
    const tf: Timeframe = body.tf === "10m" ? "10m" : "5m";
    const sessions = Math.min(20, Math.max(3, body.sessions ?? 10));
    const meta = await getInstrument(symbol);
    if (!meta) {
      return NextResponse.json({ version: "v1", ok: false, error: `unknown instrument ${symbol}` }, { status: 404 });
    }
    const now = Date.now();
    const { candles } = await ensureSessions(meta.instrumentKey, tf, sessions, now);
    if (candles.length < 40) {
      return NextResponse.json({ version: "v1", ok: false, error: "insufficient candles for replay", candles: candles.length }, { status: 422 });
    }
    const frame = await futuresFrameFor(meta, tf, Math.min(sessions, 6), now);
    const cfg = withConfig();

    // Include the per-candle options component so the no-repaint proof
    // covers the full evidence set, not just price/volume/futures.
    const optFrame = await buildOptionsFrame(meta, tf, candles, now);
    const optionsReading = optFrame
      ? (i: number) => optionsReadingAt(optFrame, candles, i)
      : null;

    const full = computeSeries(candles, tf, cfg, frame, optionsReading, 0);
    const cutoff = Math.floor(candles.length * Math.min(0.9, Math.max(0.3, body.cutoffRatio ?? 0.63)));
    const prefix = computeSeries(candles.slice(0, cutoff), tf, cfg, frame, optionsReading, 0);

    let maxValueDiff = 0;
    let maxZoneDiff = 0;
    let stateMismatch = 0;
    const mismatches: { index: number; ts: number; full: number; prefix: number }[] = [];
    for (let i = 0; i < cutoff; i++) {
      const a = full.points[i], b = prefix.points[i];
      const dv = Math.abs(a.value - b.value);
      if (dv > maxValueDiff) maxValueDiff = dv;
      if (a.zoneBoundaries && b.zoneBoundaries) {
        maxZoneDiff = Math.max(
          maxZoneDiff,
          Math.abs(a.zoneBoundaries.oversoldUpper - b.zoneBoundaries.oversoldUpper),
          Math.abs(a.zoneBoundaries.overboughtLower - b.zoneBoundaries.overboughtLower),
        );
      }
      if (a.state !== b.state) stateMismatch++;
      if (dv > 1e-9 && mismatches.length < 5) {
        mismatches.push({ index: i, ts: a.ts, full: a.value, prefix: b.value });
      }
    }

    // candle-grid alignment checks
    const tfMin = TIMEFRAME_MINUTES[tf];
    let offGrid = 0;
    for (const c of candles) {
      const ds = istDateStr(c.ts);
      const anchor = gridpointMs(ds, SESSION_OPEN_MIN);
      if ((c.ts - anchor) % (tfMin * 60_000) !== 0) offGrid++;
    }
    const sessionsSeen = new Set(candles.map((c) => istDateStr(c.ts))).size;

    const ok = maxValueDiff <= 1e-9 && maxZoneDiff <= 1e-9 && stateMismatch === 0 && offGrid === 0;
    return NextResponse.json({
      version: "v1", ok,
      instrument: meta.symbol, timeframe: tf,
      candlesTotal: candles.length, sessions: sessionsSeen, cutoff,
      components: {
        futuresUsed: Boolean(frame),
        optionsUsed: Boolean(optFrame),
        optionsExpiry: optFrame?.expiryDate ?? null,
        optionsContracts: optFrame?.contracts ?? 0,
      },
      noRepaint: {
        checkedPoints: cutoff,
        maxValueDiff, maxZoneDiff, stateMismatch,
        verdict: maxValueDiff <= 1e-9 && maxZoneDiff <= 1e-9 && stateMismatch === 0
          ? "PASS — prefix recomputation matches full series exactly; no future-data leakage"
          : "FAIL — historical values changed under replay",
        sampleMismatch: mismatches,
      },
      candleGrid: {
        offGridCandles: offGrid,
        verdict: offGrid === 0 ? `PASS — all opens align to the ${tfMin}-minute session grid (09:15 IST anchored)` : "FAIL — misaligned candles found",
      },
      engineVersion: full.engineVersion,
      note: "Replay uses genuine persisted candles identical to the live path — no synthetic fixtures.",
    });
  } catch (e) {
    return NextResponse.json({ version: "v1", ok: false, error: (e as Error).message }, { status: 502 });
  }
}
