"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Gauge, LogIn, Menu, Minus, Radio, RefreshCw,
  ShieldCheck, Workflow, X,
} from "lucide-react";
import type { FmpiSeriesPayload, InstrumentMeta, ScanRow, Timeframe } from "@/lib/fmpi/types";
import { fmtIstTime } from "@/lib/market/session";
import {
  fmtNum, fmtPrice, fmtSigned, qualityMeta, STATE_LABEL, stateColor, ZONE_META,
} from "@/lib/client/format";
import { ChartCanvas } from "./chart-canvas";
import { Sidebar } from "./sidebar";
import type { TopMoversPayload } from "./sidebar";
import type { SuggestionPayload } from "@/lib/fmpi/suggestions";
import { IntelPanel } from "./intel-panel";
import { LoginModal, expiryText, sessionTone } from "./login-modal";
import type { SessionStatus } from "./login-modal";

interface HoverState { i: number; x: number; y: number }

export function Terminal() {
  const [symbol, setSymbol] = useState("NIFTY");
  const [tf, setTf] = useState<Timeframe>("5m");
  const [payload, setPayload] = useState<FmpiSeriesPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instruments, setInstruments] = useState<InstrumentMeta[]>([]);
  const [scanRows, setScanRows] = useState<Map<string, ScanRow>>(new Map());
  const [scanStatus, setScanStatus] = useState<"idle" | "building" | "ready">("idle");
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [movers, setMovers] = useState<TopMoversPayload | null>(null);
  const [trades, setTrades] = useState<SuggestionPayload | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [clock, setClock] = useState("");
  const [spinning, setSpinning] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [authEpoch, setAuthEpoch] = useState(0);
  const [wrapW, setWrapW] = useState(900);
  const wrapRef = useRef<HTMLDivElement>(null);
  const payloadRef = useRef<FmpiSeriesPayload | null>(null);

  /* IST clock */
  useEffect(() => {
    const tick = () => setClock(`${fmtIstTime(Date.now())}:${String(new Date(Date.now() + 5.5 * 3600e3).getUTCSeconds()).padStart(2, "0")} IST`);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  /* ESC collapses the expanded panel, matching the close button */
  useEffect(() => {
    if (!panelExpanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanelExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panelExpanded]);

  /* measure chart wrapper for tooltip clamping */
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver((es) => setWrapW(es[0].contentRect.width));
    ro.observe(node);
    return () => ro.disconnect();
  }, [payload != null]);

  /* upstox session status (also catches the 03:30 IST daily expiry) */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/v1/auth/upstox");
        const json = await res.json();
        if (alive && res.ok) setSession(json as SessionStatus);
      } catch { /* status is advisory */ }
    };
    void poll();
    const id = setInterval(poll, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  /* universe */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let res = await fetch("/api/v1/universe");
        let json = await res.json();
        if ((!json.instruments || json.instruments.length === 0) && res.ok) {
          await fetch("/api/v1/universe", { method: "POST" });
          res = await fetch("/api/v1/universe");
          json = await res.json();
        }
        if (alive && json.instruments) setInstruments(json.instruments);
      } catch { /* retry-free: scan rows still populate */ }
    })();
    return () => { alive = false; };
  }, []);

  /* FMPI series with adaptive polling */
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (initial: boolean) => {
      try {
        if (initial) setSpinning(true);
        const res = await fetch(`/api/v1/fmpi?instrument=${encodeURIComponent(symbol)}&tf=${tf}&sessions=14`);
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) setError(json.error ?? "upstream error");
        else {
          setError(null);
          payloadRef.current = json;
          setPayload(json);
          timer = setTimeout(() => void load(false), json.marketState === "open" ? 9000 : 60000);
          return;
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setSpinning(false);
      }
      timer = setTimeout(() => void load(false), 15000);
    };
    payloadRef.current = null;
    setPayload(null);
    void load(true);
    return () => { alive = false; clearTimeout(timer); };
  }, [symbol, tf, authEpoch]);

  /* momentum scanner + top-movers polling (single source for both sidebars) */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const [scanRes, moversRes] = await Promise.all([
          fetch("/api/v1/scan?tf=5m"),
          fetch("/api/v1/top-movers?tf=5m&limit=10"),
        ]);
        const json = await scanRes.json();
        if (!alive) return;
        setScanStatus(json.status);
        setScanProgress(json.progress ?? { done: 0, total: 0 });
        if (Array.isArray(json.rows)) {
          setScanRows(new Map(json.rows.map((r: ScanRow) => [r.instrument.symbol, r])));
        }
        if (moversRes.ok) {
          const mv = await moversRes.json();
          if (alive) setMovers(mv);
        }
      } catch { /* scanner is opportunistic */ }
    };
    void poll();
    const id = setInterval(poll, 20000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  /* trade suggestions — slower cadence, deep multi-factor analysis */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch("/api/v1/trade-suggestions?limit=5");
        if (!res.ok) return;
        const json = await res.json();
        if (alive && !json.error) setTrades(json as SuggestionPayload);
      } catch { /* suggestions are advisory */ }
    };
    void poll();
    const id = setInterval(poll, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const onHover = useCallback((i: number | null, cx: number, cy: number) => {
    if (i === null) { setHover(null); return; }
    const rect = wrapRef.current?.getBoundingClientRect();
    setHover({ i, x: cx - (rect?.left ?? 0), y: cy - (rect?.top ?? 0) });
  }, []);

  const onReplay = useCallback(async () => {
    const res = await fetch("/api/v1/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instrument: symbol, tf }),
    });
    return res.ok ? await res.json() : null;
  }, [symbol, tf]);

  const l = payload?.latest ?? null;
  const sc = stateColor(l?.state ?? "insufficient_data");
  const candle = payload?.candles.length ? payload.candles[payload.candles.length - 1] : null;
  const prevCandle = payload && payload.candles.length > 1 ? payload.candles[payload.candles.length - 2] : null;
  const pxChange = candle && prevCandle ? (candle.close / prevCandle.close - 1) * 100 : null;
  const meta = payload?.instrument ?? instruments.find((m) => m.symbol === symbol) ?? null;
  const scanTop = useMemo(
    () => [...scanRows.values()].filter((r) => r.value != null).slice(0, 30),
    [scanRows],
  );

  const hoverPoint = hover && payload ? payload.points[hover.i] : null;
  const hoverCandle = hover && payload ? payload.candles[hover.i] : null;

  const fut = payload?.futures;

  const toolbar = (
    <div className="panel flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-extrabold tracking-wide text-white">{symbol}</span>
            <span className="chip mono text-[8.5px] text-[#7d8ca3]">{meta?.exchange ?? "NSE"} · {meta?.segment?.toUpperCase() ?? "—"}</span>
            <span className="chip mono text-[8.5px] text-[#41c8ff]" title="Price panel shows the SPOT series">
              SPOT PRICES
            </span>
          </div>
          {candle && (
            <div className="mono mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
              <span className="text-[#c8d6ea]">{fmtPrice(candle.close)}</span>
              {pxChange != null && (
                <span style={{ color: pxChange >= 0 ? "#2fd47b" : "#f0506e" }}>{fmtSigned(pxChange, 2)}%</span>
              )}
              {l?.provisional && <span className="text-[#41c8ff]">· LIVE FORMING</span>}
              <span className="text-[#4a586e]">· {payload?.timeframe.toUpperCase()}</span>
              {fut?.used && fut.lastClose != null && (
                <span className="text-[#c9a45c]" title={`Linked futures ${fut.instrumentKey}`}>
                  · FUT {fmtPrice(fut.lastClose)} ({fut.basisPct != null ? `${fmtSigned(fut.basisPct, 2)}% basis` : "—"})
                </span>
              )}
            </div>
          )}
        </div>
        <div className="hidden h-8 w-px bg-[rgba(125,165,220,0.12)] sm:block" />
        {/* FMPI header readout — actual computed values */}
        <div className="flex items-center gap-2.5">
          <Workflow className="h-4 w-4 shrink-0 text-[#41c8ff]" />
          <div>
            <div className="mono text-[8.5px] tracking-[0.18em] text-[#4a586e]">FMPI ({tf === "5m" ? "5M" : "10M"})</div>
            <div className="flex items-baseline gap-2">
              <span className="mono text-[18px] font-extrabold leading-none tracking-tight sm:text-[20px]" style={{ color: sc }}>
                {l ? fmtNum(l.value) : "—"}
              </span>
              {l?.change != null && (
                <span className="mono flex items-center text-[12px] font-bold" style={{ color: l.change >= 0 ? "#2fd47b" : "#f0506e" }}>
                  {l.change > 0.04 ? <ArrowUpRight className="h-3.5 w-3.5" /> : l.change < -0.04 ? <ArrowDownRight className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                  {fmtNum(Math.abs(l.change))}
                </span>
              )}
            </div>
          </div>
          <span className="chip mono text-[9.5px] font-bold" style={{ borderColor: `${sc}66`, color: sc, background: `${sc}14` }}>
            {l ? STATE_LABEL[l.state] : "LOADING"}
          </span>
          {payload?.peer && (
            <span className="chip mono hidden text-[9px] text-[#7d8ca3] md:inline-flex">
              {payload.peer.timeframe.toUpperCase()} {fmtNum(payload.peer.value)} · {STATE_LABEL[payload.peer.state]}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {spinning && <RefreshCw className="h-3.5 w-3.5 animate-spin text-[#41c8ff]" />}
        <div className="flex rounded-lg border border-[rgba(125,165,220,0.15)] bg-[rgba(4,7,12,0.55)] p-1">
          <button className={`seg-btn ${tf === "5m" ? "active" : ""}`} onClick={() => setTf("5m")}>5 MIN</button>
          <button className={`seg-btn ${tf === "10m" ? "active" : ""}`} onClick={() => setTf("10m")}>10 MIN</button>
        </div>
      </div>
    </div>
  );

  const chartBlock = (
    <div key="chart" className="panel relative h-[56svh] min-h-[360px] shrink-0 overflow-hidden lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink">
      <div ref={wrapRef} className="absolute inset-0">
        {payload && payload.points.length > 0 ? (
          <>
            <ChartCanvas payload={payload} hovered={hover?.i ?? null} onHover={onHover} />
            {hover && hoverPoint && hoverCandle && (
              <Tooltip payload={payload} hover={hover} width={wrapW} />
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <div className="shimmer h-40 w-full max-w-lg rounded-xl" />
            <span className="mono text-[11px] text-[#54637a]">
              fetching genuine {tf === "5m" ? "5-minute" : "10-minute"} candles from Upstox…
            </span>
          </div>
        )}
        {payload && payload.marketState !== "open" && (
          <div className="mono absolute bottom-2 right-2 rounded border border-[rgba(125,165,220,0.2)] bg-[rgba(4,7,12,0.8)] px-2 py-1 text-[9px] tracking-widest text-[#7d8ca3]">
            MARKET {payload.marketState === "pre_open" ? "PRE-OPEN" : "CLOSED"} · LATEST GENUINE SESSION
          </div>
        )}
      </div>
    </div>
  );

  const scannerStrip = (
    <div className="panel shrink-0 overflow-hidden">
      <div className="flex items-center justify-between border-b border-[rgba(125,165,220,0.08)] px-3 py-1.5">
        <span className="panel-title">MOMENTUM SCANNER · 5M FMPI</span>
        <span className="mono text-[9px] text-[#4a586e]">
          {scanStatus === "building" ? `building ${scanRows.size}…` : `${scanRows.size} instruments`}
        </span>
      </div>
      <div className="flex gap-1 overflow-x-auto px-2 py-1.5">
        {scanTop.map((r) => (
          <button
            key={r.instrument.instrumentKey}
            onClick={() => setSymbol(r.instrument.symbol)}
            className={`mono flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-[7px] text-[10px] transition ${
              r.instrument.symbol === symbol
                ? "border-[rgba(65,200,255,0.5)] bg-[rgba(65,200,255,0.1)]"
                : "border-[rgba(125,165,220,0.1)] hover:border-[rgba(125,165,220,0.3)]"
            }`}
          >
            <span className="font-bold text-[#c8d6ea]">{r.instrument.symbol}</span>
            <span style={{ color: stateColor(r.state) }}>{fmtNum(r.value)}</span>
            <span className="text-[8px] text-[#4a586e]">{(r.zone ?? "").toUpperCase().slice(0, 4)}</span>
          </button>
        ))}
        {scanTop.length === 0 && (
          <span className="mono px-2 py-1 text-[10px] leading-snug text-[#54637a]">
            scanner warming up — uninitialised symbols show no value rather than a fabricated one
          </span>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex min-h-dvh flex-col gap-2 p-2 lg:h-dvh lg:overflow-hidden">
      {/* ─── top bar ─── */}
      <header className="panel flex h-11 shrink-0 items-center justify-between px-2.5 sm:px-3">
        <div className="flex items-center gap-2.5">
          <button
            className="rounded-md border border-[rgba(125,165,220,0.18)] p-1.5 text-[#8ea3c4] lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open instrument list"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-[#2fd47b] to-[#0e9f6e] shadow-[0_0_18px_rgba(47,212,123,0.35)]">
            <Gauge className="h-4 w-4 text-[#03140b]" />
          </div>
          <div className="hidden sm:block">
            <div className="text-[13px] font-extrabold tracking-[0.18em] text-white">
              FMPI <span className="text-[#41c8ff]">ENGINE</span>
            </div>
            <div className="mono text-[8.5px] tracking-[0.14em] text-[#4a586e]">
              MOMENTUM PRESSURE · CONTINUATION vs EXHAUSTION
            </div>
          </div>

          {/* ─── Upstox login (top-left) ─── */}
          <button
            onClick={() => setLoginOpen(true)}
            aria-label="Upstox session"
            title={session?.message ?? "Sign in with your Upstox access token"}
            className="chip mono ml-1 gap-1.5 py-[5px] text-[9.5px] font-bold transition hover:brightness-125"
            style={{
              borderColor: `${sessionTone(session).color}66`,
              color: sessionTone(session).color,
              background: `${sessionTone(session).color}14`,
            }}
          >
            {session?.authenticated ? <ShieldCheck className="h-3 w-3" /> : <LogIn className="h-3 w-3" />}
            {sessionTone(session).label}
            {session?.authenticated && expiryText(session) && (
              <span className="hidden text-[8.5px] font-normal opacity-70 md:inline">· {expiryText(session)}</span>
            )}
          </button>

          <span className="chip mono hidden text-[9px] text-[#7d8ca3] lg:inline-flex">{payload?.engineVersion ?? "—"}</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="chip mono hidden text-[9.5px] text-[#7d8ca3] md:inline-flex">
            <Radio className="h-3 w-3 text-[#2fd47b]" />
            UPSTOX · GENUINE FEED
          </span>
          <MarketPhaseChip phase={payload?.marketState} />
          <span className="mono hidden text-[11px] text-[#8ea3c4] sm:block">{clock}</span>
        </div>
      </header>

      <LoginModal
        open={loginOpen}
        status={session}
        onClose={() => setLoginOpen(false)}
        onChanged={(s) => {
          setSession(s);
          // auth changes the available component set — pull a fresh series
          setAuthEpoch((n) => n + 1);
        }}
      />

      {/* ─── mobile universe drawer ─── */}
      <div
        className={`fixed inset-0 z-40 transition lg:hidden ${drawerOpen ? "" : "pointer-events-none"}`}
        aria-hidden={!drawerOpen}
        style={drawerOpen ? undefined : { visibility: "hidden" }}
      >
        <div
          className={`absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity ${drawerOpen ? "opacity-100" : "opacity-0"}`}
          onClick={() => setDrawerOpen(false)}
        />
        <div
          className={`absolute inset-y-0 left-0 w-[272px] max-w-[82vw] transition-transform duration-300 ${drawerOpen ? "translate-x-0" : "-translate-x-full"}`}
          style={{ paddingTop: "max(8px, env(safe-area-inset-top))", paddingBottom: "max(8px, env(safe-area-inset-bottom))", paddingLeft: 8 }}
        >
          <div className="relative h-full">
            {/* No absolute close button here: it overlapped the FULL
                button in the tab bar and blocked taps on mobile. The
                backdrop tap below closes the drawer. */}
            {/* The drawer holds the normal rail. Passing `expanded` here
                made the fixed-position overlay escape the hidden drawer and
                cover the screen at all times, so the shared full-screen
                panel below is opened explicitly instead. */}
            <Sidebar
              instruments={instruments}
              scanRows={scanRows}
              scanStatus={scanStatus}
              scanProgress={scanProgress}
              movers={movers}
              trades={trades}
              selected={symbol}
              onSelect={setSymbol}
              onNavigate={() => setDrawerOpen(false)}
              onExpand={() => {
                setDrawerOpen(false);
                setPanelExpanded(true);
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* desktop static sidebar */}
        <div className="hidden min-h-0 w-[252px] shrink-0 lg:block">
          <Sidebar
            instruments={instruments}
            scanRows={scanRows}
            scanStatus={scanStatus}
            scanProgress={scanProgress}
            movers={movers}
            trades={trades}
            selected={symbol}
            onSelect={setSymbol}
            onExpand={() => setPanelExpanded(true)}
          />
        </div>

        {/* full-screen panel — TRADES / TOP 10 / ALL get the whole viewport */}
        {panelExpanded && (
          <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm">
            <div className="absolute inset-0 p-2 lg:p-4">
              <Sidebar
                instruments={instruments}
                scanRows={scanRows}
                scanStatus={scanStatus}
                scanProgress={scanProgress}
                movers={movers}
                trades={trades}
                selected={symbol}
                onSelect={setSymbol}
                expanded
                onCollapse={() => setPanelExpanded(false)}
              />
            </div>
          </div>
        )}

        {/* ─── centre column ─── */}
        <main className="flex min-w-0 flex-1 flex-col gap-2 lg:min-h-0">
          {toolbar}

          {payload?.combinedState === "conflicting_signals" && (
            <div className="rise-in flex shrink-0 items-start gap-2 rounded-lg border border-[rgba(192,132,252,0.35)] bg-[rgba(192,132,252,0.07)] px-3 py-1.5">
              <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#c084fc]" />
              <span className="text-[10.5px] text-[#d8b4fe]">
                CONFLICTING SIGNALS — 5M and 10M pressure readings disagree. Both are displayed independently; treat continuation reads with reduced confidence.
              </span>
            </div>
          )}

          {error && (
            <div className="shrink-0 rounded-lg border border-[rgba(240,80,110,0.4)] bg-[rgba(240,80,110,0.08)] px-3 py-2 text-[11px] text-[#f9a8bd]">
              {error} — the engine never substitutes fabricated values; retrying automatically.
            </div>
          )}

          {chartBlock}
          {scannerStrip}

          {/* mobile/tablet: intel panel flows under the chart */}
          <div className="h-[72svh] min-h-[440px] shrink-0 lg:hidden">
            {payload ? (
              <IntelPanel payload={payload} onReplay={onReplay} />
            ) : (
              <div className="panel flex h-full items-center justify-center">
                <div className="shimmer h-64 w-4/5 rounded-xl" />
              </div>
            )}
          </div>
        </main>

        {/* desktop right rail */}
        <div className="hidden min-h-0 w-[296px] shrink-0 lg:block">
          {payload ? (
            <IntelPanel payload={payload} onReplay={onReplay} />
          ) : (
            <div className="panel flex h-full items-center justify-center">
              <div className="shimmer h-64 w-4/5 rounded-xl" />
            </div>
          )}
        </div>
      </div>

      {/* ─── status bar (desktop) ─── */}
      <footer className="panel mono hidden h-7 shrink-0 items-center justify-between px-3 text-[9.5px] text-[#54637a] lg:flex">
        <span>evidence engine — no auto-trades · extremes are continuation information, not reversal commands</span>
        <span className="flex items-center gap-3">
          {l && <span style={{ color: qualityMeta(l.quality).color }}>● {qualityMeta(l.quality).label}</span>}
          <span>{payload ? `${payload.candles.length} genuine candles · ${payload.timeframe.toUpperCase()} native grid` : ""}</span>
          <span
            title={payload?.options.note}
            style={{ color: payload?.options.used ? "#2fd47b" : "#7d8ca3" }}
          >
            {payload?.options.used
              ? `OPTIONS OI ✓${payload.options.expiry ? ` exp ${payload.options.expiry.slice(5)}` : ""}${payload.options.contracts ? ` · ${payload.options.contracts} contracts` : ""}`
              : "OPTIONS MISSING (labelled)"}
          </span>
        </span>
      </footer>

      {/* ─── status strip (mobile) ─── */}
      <footer className="panel mono flex h-7 shrink-0 items-center justify-between px-3 text-[9px] text-[#54637a] lg:hidden">
        <span>evidence engine · no auto-trades</span>
        {l && <span style={{ color: qualityMeta(l.quality).color }}>● {qualityMeta(l.quality).label}</span>}
      </footer>
    </div>
  );
}

function MarketPhaseChip({ phase }: { phase?: FmpiSeriesPayload["marketState"] }) {
  const map = {
    open: { txt: "OPEN", color: "#2fd47b" },
    pre_open: { txt: "PRE-OPEN", color: "#f5b53f" },
    post_close: { txt: "POST-CLOSE", color: "#7c93b8" },
    closed: { txt: "CLOSED", color: "#6b7280" },
  } as const;
  const m = map[phase ?? "closed"];
  return (
    <span className="chip mono text-[9.5px]" style={{ color: m.color, borderColor: `${m.color}55` }}>
      <span className={`h-1.5 w-1.5 rounded-full ${phase === "open" ? "pulse-dot" : ""}`} style={{ background: m.color }} />
      {m.txt}
    </span>
  );
}

/* ─── hover tooltip (spec §10) — clamped inside its container ─── */
function Tooltip({ payload, hover, width }: { payload: FmpiSeriesPayload; hover: HoverState; width: number }) {
  const p = payload.points[hover.i];
  const c = payload.candles[hover.i];
  if (!p || !c) return null;
  const prev = hover.i > 0 ? payload.candles[hover.i - 1] : null;
  const pxDelta = prev ? (c.close / prev.close - 1) * 100 : null;
  const volE = p.components.volume_participation.evidence[0];
  const futE = p.components.futures_positioning.evidence;
  const optE = p.components.options_positioning.evidence[0];
  const structE = p.components.price_structure.evidence[0];
  const qm = qualityMeta(p.quality);

  const rows: [string, ReactNode][] = [
    ["timestamp", <span key="t">{fmtIstTime(p.ts)} IST{p.provisional ? " · live (provisional)" : ""}</span>],
    ["FMPI", <b key="v" style={{ color: stateColor(p.state) }}>{fmtNum(p.value)} ({fmtSigned(p.change)})</b>],
    ["zone", p.zone ? ZONE_META[p.zone].label.toUpperCase() : "warming up"],
    ["slope / accel", `${fmtSigned(p.slope, 2)} / ${fmtSigned(p.acceleration, 2)}`],
    ["price Δ", pxDelta == null ? "—" : <span key="px" style={{ color: pxDelta >= 0 ? "#2fd47b" : "#f0506e" }}>{fmtSigned(pxDelta, 2)}%</span>],
    ["volume", <span key="vol" className="block max-w-[200px] whitespace-normal">{volE}</span>],
    ["futures", <span key="fu" className="block max-w-[200px] whitespace-normal">{futE.filter(Boolean).slice(0, 1)[0] ?? "—"}</span>],
    ["options", <span key="op" className="block max-w-[200px] whitespace-normal">{optE}</span>],
    ["structure", <span key="st" className="block max-w-[200px] whitespace-normal">{structE}</span>],
    ["state", <span key="st2" style={{ color: stateColor(p.state) }}>{STATE_LABEL[p.state]}</span>],
    ["quality", <span key="q" style={{ color: qm.color }}>{qm.label}</span>],
  ];

  const W = Math.min(252, Math.max(190, width - 20));
  const flip = hover.x > width - W - 24;
  return (
    <div
      className="mono pointer-events-none absolute z-20 rounded-lg border border-[rgba(125,165,220,0.25)] bg-[rgba(5,9,15,0.94)] p-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.6)] backdrop-blur"
      style={{
        width: W,
        left: flip ? Math.max(6, hover.x - W - 14) : Math.min(hover.x + 14, width - W - 6),
        top: Math.max(6, Math.min(hover.y - 40, 380)),
      }}
    >
      <div className="grid grid-cols-[70px_1fr] gap-x-2 gap-y-[3px] text-[9.5px] leading-snug">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <span className="text-[#4a586e]">{k}</span>
            <span className="text-[#c8d6ea]">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
