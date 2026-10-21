import { NextResponse } from "next/server";
import { ensureScan } from "@/lib/fmpi/scanRunner";
import { ensureSuggestions } from "@/lib/fmpi/suggestions";
import type { Timeframe } from "@/lib/fmpi/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/v1/trade-suggestions?limit=5&tf=5m
 *
 * Conviction-ranked trade ideas across F&O stocks plus NIFTY and SENSEX.
 * Reflects whatever the background scanner has genuinely computed, and
 * may legitimately return fewer ideas than requested.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const tf = (url.searchParams.get("tf") ?? "5m") as Timeframe;
    const limit = Math.min(10, Math.max(1, Number(url.searchParams.get("limit") ?? 5) || 5));
    const state = ensureScan(tf === "10m" ? "10m" : "5m");
    const payload = ensureSuggestions(
      state.rows,
      state.status,
      state.progress,
      limit,
      tf === "10m" ? "10m" : "5m",
    );
    return NextResponse.json({ version: "v1", ...payload });
  } catch (e) {
    return NextResponse.json({ version: "v1", error: (e as Error).message }, { status: 502 });
  }
}
