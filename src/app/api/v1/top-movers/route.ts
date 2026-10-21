import { NextResponse } from "next/server";
import { topMovers } from "@/lib/fmpi/scanRunner";
import type { Timeframe } from "@/lib/fmpi/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/top-movers?tf=5m&limit=10
 * Top buying / selling pressure stocks ranked by their own FMPI value.
 * Non-blocking: reflects whatever the background scanner has genuinely
 * computed so far, together with its coverage progress.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tf = (url.searchParams.get("tf") ?? "5m") as Timeframe;
  const limit = Math.min(25, Math.max(3, Number(url.searchParams.get("limit") ?? 10) || 10));
  const data = topMovers(tf === "10m" ? "10m" : "5m", limit);
  return NextResponse.json({ version: "v1", ...data });
}
