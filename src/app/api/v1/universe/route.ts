import { NextResponse } from "next/server";
import { getUniverse, syncUniverse } from "@/lib/market/universe";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET /api/v1/universe?q=reli — dynamic Upstox F&O instrument universe */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = (url.searchParams.get("q") ?? "").toUpperCase();
    let uni = await getUniverse();
    if (q) uni = uni.filter((m) => m.symbol.toUpperCase().includes(q) || m.name.toUpperCase().includes(q));
    return NextResponse.json({
      version: "v1", count: uni.length,
      source: "https://assets.upstox.com/market-quote/instruments/exchange/{NSE,BSE}.json.gz",
      instruments: uni,
    });
  } catch (e) {
    return NextResponse.json({ version: "v1", error: (e as Error).message }, { status: 502 });
  }
}

/** POST /api/v1/universe — force re-sync from the instrument master */
export async function POST() {
  try {
    const count = await syncUniverse();
    return NextResponse.json({ version: "v1", ok: true, count, syncedAt: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ version: "v1", ok: false, error: (e as Error).message }, { status: 502 });
  }
}
