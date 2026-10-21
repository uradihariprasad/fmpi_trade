"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Route-level recovery boundary. It does not hide the error: the safe
 * message is rendered and the full exception remains in browser logs.
 * `reset` remounts the route without throwing users into Next's generic
 * disabled-page screen.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[FMPI UI] recoverable route error", error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-[#04070c] p-5 text-[#dce6f2]">
      <section className="panel w-full max-w-md p-5 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-[#f5b53f]" />
        <h1 className="mt-3 text-base font-bold tracking-wider">FMPI VIEW NEEDS TO RECOVER</h1>
        <p className="mt-2 text-[11px] leading-relaxed text-[#8ea3c4]">
          The market-data service is still running. Retry the view; genuine readings are never replaced with fabricated values.
        </p>
        {error.digest && <p className="mono mt-2 text-[9px] text-[#4a586e]">reference {error.digest}</p>}
        <button
          onClick={reset}
          className="mt-4 inline-flex items-center gap-2 rounded-md border border-[rgba(65,200,255,0.4)] bg-[rgba(65,200,255,0.1)] px-4 py-2 text-[11px] font-bold tracking-widest text-[#41c8ff]"
        >
          <RefreshCw className="h-3.5 w-3.5" /> RETRY VIEW
        </button>
      </section>
    </main>
  );
}
