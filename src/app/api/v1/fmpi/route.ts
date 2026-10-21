import { NextResponse } from "next/server";
import { getFmpiSeries } from "@/lib/fmpi/service";
import type { Timeframe } from "@/lib/fmpi/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/v1/fmpi?instrument=RELIANCE&tf=5m|10m&sessions=14
 * Versioned contract — fields documented in src/lib/fmpi/types.ts.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const instrument = url.searchParams.get("instrument");
    const tf = (url.searchParams.get("tf") ?? "5m") as Timeframe;
    const sessions = Math.min(30, Math.max(2, Number(url.searchParams.get("sessions") ?? 14) || 14));
    if (!instrument) {
      return NextResponse.json({ version: "v1", error: "query param 'instrument' is required" }, { status: 400 });
    }
    if (tf !== "5m" && tf !== "10m") {
      return NextResponse.json(
        { version: "v1", error: "FMPI is computed only on 5-minute and 10-minute timeframes" },
        { status: 400 },
      );
    }
    const payload = await getFmpiSeries(instrument, tf, sessions);
    return NextResponse.json({ version: "v1", ...payload });
  } catch (e) {
    const err = e as Error & { code?: string };
    const status = err.code === "UNKNOWN_INSTRUMENT" ? 404 : 502;
    return NextResponse.json({ version: "v1", error: err.message, code: err.code ?? "UPSTREAM" }, { status });
  }
}
