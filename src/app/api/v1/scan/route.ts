import { NextResponse } from "next/server";
import { ensureScan } from "@/lib/fmpi/scanRunner";
import type { Timeframe } from "@/lib/fmpi/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/scan?tf=5m — momentum scanner across the dynamic universe.
 * Non-blocking: returns current rows plus a truthful build status; clients
 * poll while `status === "building"`.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const tf = (url.searchParams.get("tf") ?? "5m") as Timeframe;
  const state = ensureScan(tf === "10m" ? "10m" : "5m");
  return NextResponse.json({
    version: "v1",
    timeframe: tf === "10m" ? "10m" : "5m",
    status: state.status,
    progress: state.progress,
    count: state.rows.length,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    finishedAt: state.finishedAt ? new Date(state.finishedAt).toISOString() : null,
    rows: state.rows,
  });
}
