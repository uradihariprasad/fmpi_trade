import { NextResponse } from "next/server";
import { clearToken, getStatus, passcodeValid, saveToken } from "@/lib/market/auth";

export const dynamic = "force-dynamic";

/** GET — masked session status. Never returns the raw token. */
export async function GET() {
  try {
    return NextResponse.json({ version: "v1", ...(await getStatus()) });
  } catch (e) {
    return NextResponse.json({ version: "v1", error: (e as Error).message }, { status: 500 });
  }
}

/**
 * POST { accessToken, passcode? } — validates the token against the live
 * Upstox profile endpoint before persisting it. Invalid tokens are
 * rejected and nothing is stored.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { accessToken?: string; passcode?: string };
    if (!passcodeValid(body.passcode ?? req.headers.get("x-fmpi-passcode"))) {
      return NextResponse.json({ version: "v1", error: "Invalid admin passcode." }, { status: 401 });
    }
    const token = (body.accessToken ?? "").trim();
    if (!token) {
      return NextResponse.json({ version: "v1", error: "accessToken is required." }, { status: 400 });
    }
    const status = await saveToken(token);
    return NextResponse.json({ version: "v1", ok: true, ...status });
  } catch (e) {
    return NextResponse.json({ version: "v1", ok: false, error: (e as Error).message }, { status: 400 });
  }
}

/** DELETE — signs out and removes the stored token. */
export async function DELETE(req: Request) {
  try {
    const supplied = req.headers.get("x-fmpi-passcode") ?? new URL(req.url).searchParams.get("passcode");
    if (!passcodeValid(supplied)) {
      return NextResponse.json({ version: "v1", error: "Invalid admin passcode." }, { status: 401 });
    }
    await clearToken();
    return NextResponse.json({ version: "v1", ok: true, ...(await getStatus()) });
  } catch (e) {
    return NextResponse.json({ version: "v1", ok: false, error: (e as Error).message }, { status: 500 });
  }
}
