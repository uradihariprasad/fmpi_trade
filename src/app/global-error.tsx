"use client";

/** Last-resort boundary when even the root layout fails. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#04070c", color: "#dce6f2", fontFamily: "system-ui" }}>
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          <section style={{ maxWidth: 420, textAlign: "center", border: "1px solid #233044", borderRadius: 12, padding: 24, background: "#0a1018" }}>
            <h1 style={{ fontSize: 16 }}>FMPI encountered a display error</h1>
            <p style={{ color: "#8ea3c4", fontSize: 12, lineHeight: 1.6 }}>
              Retry the interface. If the server was restarting, wait a few seconds and try again.
            </p>
            <button onClick={reset} style={{ marginTop: 10, border: "1px solid #41c8ff", borderRadius: 6, padding: "9px 18px", background: "#0c2733", color: "#41c8ff", fontWeight: 700, cursor: "pointer" }}>
              RETRY
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
