"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
  Activity, AlertTriangle, BookOpen, CheckCircle2, Gauge, Layers, ListTree,
  Loader2, ShieldCheck, Split, XCircle,
} from "lucide-react";
import type { ComponentKey, FmpiSeriesPayload } from "@/lib/fmpi/types";
import {
  fmtNum, fmtSigned, qualityMeta, STATE_LABEL, stateColor, ZONE_META,
} from "@/lib/client/format";
import { fmtIstLabel } from "@/lib/market/session";

const COMPONENT_META: Record<ComponentKey, { label: string; weight: number }> = {
  price_pressure: { label: "Price pressure", weight: 0.3 },
  volume_participation: { label: "Volume participation", weight: 0.2 },
  futures_positioning: { label: "Futures positioning", weight: 0.2 },
  options_positioning: { label: "Options positioning", weight: 0.15 },
  price_structure: { label: "Support / resistance", weight: 0.1 },
  acceleration_persistence: { label: "Accel & persistence", weight: 0.05 },
};

interface ReplayReport {
  ok: boolean;
  candlesTotal: number;
  sessions: number;
  cutoff: number;
  noRepaint: { checkedPoints: number; maxValueDiff: number; maxZoneDiff: number; stateMismatch: number; verdict: string };
  candleGrid: { offGridCandles: number; verdict: string };
  engineVersion: string;
  note: string;
}

export function IntelPanel({ payload, onReplay }: { payload: FmpiSeriesPayload; onReplay: () => Promise<ReplayReport | null> }) {
  const [tab, setTab] = useState<"state" | "zones" | "evidence" | "method">("state");
  const [replay, setReplay] = useState<ReplayReport | null>(null);
  const [replaying, setReplaying] = useState(false);
  const l = payload.latest;
  const qm = qualityMeta(l?.quality ?? "unavailable");

  const tabs = [
    { id: "state" as const, label: "STATE", icon: Gauge },
    { id: "zones" as const, label: "ZONES", icon: Layers },
    { id: "evidence" as const, label: "EVIDENCE", icon: ListTree },
    { id: "method" as const, label: "METHOD", icon: BookOpen },
  ];

  return (
    <aside className="panel flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden lg:w-[296px]">
      <div className="flex border-b border-[rgba(125,165,220,0.1)]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 py-2.5 text-[9.5px] font-bold tracking-[0.14em] transition-colors ${
              tab === t.id ? "bg-[rgba(65,200,255,0.08)] text-[#41c8ff] shadow-[inset_0_-2px_0_#41c8ff]" : "text-[#4a586e] hover:text-[#8ea3c4]"
            }`}
          >
            <t.icon className="h-3 w-3" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "state" && l && (
          <div className="rise-in space-y-3">
            <div
              className="rounded-lg border p-3 text-center"
              style={{ borderColor: `${stateColor(l.state)}55`, background: `${stateColor(l.state)}12` }}
            >
              <div className="mono text-[15px] font-extrabold tracking-[0.08em]" style={{ color: stateColor(l.state) }}>
                {STATE_LABEL[l.state]}
              </div>
              <div className="mono mt-1 text-[10px] text-[#7d8ca3]">
                {payload.instrument.symbol} · {payload.timeframe.toUpperCase()} · engine {payload.engineVersion}
              </div>
            </div>

            {payload.combinedState === "conflicting_signals" && payload.peer && (
              <div className="flex items-start gap-2 rounded-lg border border-[rgba(192,132,252,0.4)] bg-[rgba(192,132,252,0.08)] p-2.5">
                <Split className="mt-0.5 h-4 w-4 shrink-0 text-[#c084fc]" />
                <p className="text-[10.5px] leading-snug text-[#d8b4fe]">
                  Timeframes conflict — {payload.timeframe.toUpperCase()} reads {fmtNum(l.value)} vs {payload.peer.timeframe.toUpperCase()} {fmtNum(payload.peer.value)} ({STATE_LABEL[payload.peer.state]}). Neither is overwritten; confidence reduced.
                </p>
              </div>
            )}

            {l.regime && (
              <div className="flex items-center justify-between rounded-lg border border-[rgba(125,165,220,0.14)] px-2.5 py-2">
                <span className="panel-title">TREND CONTEXT</span>
                <span className="mono text-[10.5px] font-bold" style={{
                  color: l.regime.direction > 0 ? "#2fd47b" : l.regime.direction < 0 ? "#f0506e" : "#7c93b8",
                }}>
                  {l.regime.label}
                  <span className="ml-1 opacity-70">{(l.regime.strength * 100).toFixed(0)}%</span>
                  {l.regime.pullback && <span className="ml-1 text-[#f5b53f]">· PULLBACK</span>}
                </span>
              </div>
            )}
            <ScoreBar label="Continuation evidence" value={l.continuationScore} color="#2fd47b" />
            <ScoreBar label="Exhaustion evidence" value={l.exhaustionScore} color="#f5b53f" />

            <div className="grid grid-cols-3 gap-1.5">
              <Stat label="SLOPE" v={fmtSigned(l.slope, 2)} />
              <Stat label="ACCEL" v={fmtSigned(l.acceleration, 2)} />
              <Stat label="Δ FMPI" v={fmtSigned(l.change, 1)} />
              <Stat label="COVERAGE" v={`${((l.coverage ?? 0) * 100).toFixed(0)}%`} />
              <Stat label="DIVERGENCE" v={l.divergence && l.divergence !== "none" ? l.divergence.replace(/_/g, " ").toUpperCase().slice(0, 14) : "NONE"} accent={l.divergence !== "none" && l.divergence != null} />
              <Stat label="ZONE" v={(l.zone ?? "—").toUpperCase()} />
            </div>

            {payload.peer && (
              <div className="rounded-lg border border-[rgba(125,165,220,0.12)] p-2.5">
                <div className="panel-title mb-1.5">PEER TIMEFRAME {payload.peer.timeframe.toUpperCase()}</div>
                <div className="flex items-center justify-between">
                  <span className="mono text-[13px] font-bold" style={{ color: stateColor(payload.peer.state) }}>
                    {fmtNum(payload.peer.value)} · {STATE_LABEL[payload.peer.state]}
                  </span>
                  <span className="mono text-[10px] text-[#7d8ca3]">{(payload.peer.zone ?? "—").toUpperCase()}</span>
                </div>
              </div>
            )}

            <div>
              <div className="panel-title mb-1.5 flex items-center gap-1.5">
                <Activity className="h-3 w-3" /> READING (evidence-derived)
              </div>
              <ul className="space-y-1.5">
                {l.explanation.slice(0, 6).map((line, i) => (
                  <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-[#aabbce]">
                    <span className="mono mt-px text-[#41c8ff]">▸</span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
            <p className="rounded-md border border-[rgba(245,181,63,0.25)] bg-[rgba(245,181,63,0.06)] p-2 text-[9.5px] leading-snug text-[#c9a45c]">
              FMPI reads pressure, not probability. Extreme values can persist in trends; exhaustion is evidence, not a reversal guarantee.
            </p>
          </div>
        )}

        {tab === "zones" && (
          <div className="rise-in space-y-2">
            <div className="panel-title">DYNAMIC BOUNDARIES · TRAILING {l?.zoneBoundaries?.samples ?? 0} OBS</div>
            {l?.zoneBoundaries ? (
              <ZoneRows zb={l.zoneBoundaries} value={l.value} />
            ) : (
              <div className="rounded-lg border border-[rgba(125,165,220,0.15)] p-3 text-[11px] leading-relaxed text-[#7d8ca3]">
                Zones are warming up — they appear only after enough genuine observations exist (min. 60, window 240). No historical distribution is manufactured.
              </div>
            )}
            <p className="text-[9.5px] leading-snug text-[#54637a]">
              Boundaries are EMA-smoothed rolling quantiles (q05/q15/q40/q60/q85/q95) of this instrument&apos;s own FMPI history on this timeframe, computed causally and persisted per candle. Fixed RSI-style levels are never used; ranges above are the live numbers behind the chart bands.
            </p>
          </div>
        )}

        {tab === "evidence" && l && (
          <div className="rise-in space-y-2.5">
            <div className="flex items-center justify-between rounded-lg border border-[rgba(125,165,220,0.12)] p-2.5">
              <span className="panel-title">DATA QUALITY</span>
              <span className="mono text-[11px] font-bold" style={{ color: qm.color }}>{qm.label}</span>
            </div>
            {(Object.keys(COMPONENT_META) as ComponentKey[]).map((key) => {
              const r = l.components[key];
              const meta = COMPONENT_META[key];
              const missing = !r.available;
              const contribution = r.available && r.score != null ? r.score * meta.weight : 0;
              return (
                <div key={key} className={`rounded-lg border p-2.5 ${missing ? "border-[rgba(125,165,220,0.08)] opacity-70" : "border-[rgba(125,165,220,0.14)]"}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold text-[#c8d6ea]">{meta.label}</span>
                    <span className="mono text-[10px] text-[#7d8ca3]">w {(meta.weight * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="bar-track flex-1">
                      {!missing && (
                        <div
                          className="bar-fill"
                          style={{
                            width: `${Math.min(100, Math.abs(contribution) * 260)}%`,
                            background: contribution >= 0 ? "#2fd47b" : "#f0506e",
                          }}
                        />
                      )}
                    </div>
                    <span className="mono w-10 text-right text-[10.5px]" style={{ color: missing ? "#6b7280" : (r.score ?? 0) >= 0 ? "#2fd47b" : "#f0506e" }}>
                      {missing ? "MISS" : fmtSigned(r.score, 2)}
                    </span>
                  </div>
                  <p className="mt-1 text-[9.5px] leading-snug text-[#54637a]">{r.evidence[0]}</p>
                </div>
              );
            })}
            <div className="rounded-lg border border-[rgba(65,200,255,0.18)] bg-[rgba(65,200,255,0.05)] p-2.5">
              <div className="panel-title mb-1">CO-AVERAGING INTEGRITY</div>
              <p className="text-[10px] leading-snug text-[#9db4d4]">
                Effective coverage {(l.coverage * 100).toFixed(0)}% — missing: {l.missingComponents.length ? l.missingComponents.map((c) => COMPONENT_META[c].label).join(", ") : "none"}. The composite is renormed over available weights and shrunk toward neutral by the coverage factor; zeros are never substituted.
              </p>
            </div>
          </div>
        )}

        {tab === "method" && (
          <div className="rise-in space-y-3 text-[10.5px] leading-snug text-[#aabbce]">
            <Section title="Trend regime (v2)">
              A 20/50-bar EMA body plus slope establishes the dominant trend from a far longer window than any
              single component. Part of the composite is anchored to it and opposing pressure is damped, so a
              two-or-three-candle retest bounce inside a downtrend is labelled <b>DOWNTREND · PULLBACK</b> rather
              than bullish continuation. A genuine flip still comes through once counter-trend pressure sustains
              for {`${5}`} consecutive bars.
            </Section>
            <Section title="Composite formula">
              FMPI = 100·logistic(k·C) blended 75/25 with the rolling percentile of C (window 240). C = Σwᵢsᵢ / Σwᵢ(available) × (0.55 + 0.45·coverage). Causal EMA smoothing: α(5M)=0.42, α(10M)=0.38. Everything stays bounded in [0,100].
            </Section>
            <Section title="Weights (initial research config)">
              <b>Options 50%</b> · Price 16% · Futures 14% · Volume 8% · S/R structure 8% · Acceleration 4%.
              Open interest is the only input that shows where committed money sits, so it anchors sentiment while
              the rest confirm. Stored in engine config, never hardcoded per instrument.
            </Section>
            <Section title="Zones">
              Per-instrument, per-timeframe rolling quantiles q05/q15/q40/q60/q85/q95 over 240 FMPI observations (min 60), EMA-stabilized (β=0.2) with monotonic clamps. Persisted per candle — past charts never repaint.
            </Section>
            <Section title="Turning points">
              Local extrema over ±3 bars, confirmed by the size of the reversal that follows (measured over the
              next 20 bars against a gate that scales with the instrument&apos;s own FMPI dispersion). Candidates
              render hollow; confirmation timestamps are never backdated.
            </Section>
            <Section title="Options positioning">
              Reconstructed from the real CE/PE contracts around the money (ATM±3 strikes, nearest expiry). Each
              candle is scored with the open interest and volume printed by that candle — standing OI balance,
              ΔOI since the previous bar, and volume skew. Put-side pressure reads as support, call-side as
              resistance. Fully causal and public: no login required.
            </Section>
            <Section title="Data honesty">
              Genuine Upstox v3 candles; 5M and 10M computed natively on their own grids; live-forming candle flagged LIVE/provisional. Indices carry no exchange volume, and illiquid strikes can leave a candle without option data — both surface as MISSING components with the weight renormed.
            </Section>
            <div className="rounded-lg border border-[rgba(47,212,123,0.22)] bg-[rgba(47,212,123,0.05)] p-2.5">
              <div className="panel-title mb-2 flex items-center gap-1.5">
                <ShieldCheck className="h-3 w-3 text-[#2fd47b]" /> HISTORICAL REPLAY VALIDATOR
              </div>
              <p className="mb-2 text-[9.5px] text-[#7d8ca3]">
                Recomputes this series on a prefix of its genuine candles and asserts every value, zone boundary and state matches — proving no future-data leakage.
              </p>
              <button
                onClick={async () => {
                  setReplaying(true);
                  setReplay(await onReplay());
                  setReplaying(false);
                }}
                disabled={replaying}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-[rgba(47,212,123,0.4)] bg-[rgba(47,212,123,0.1)] py-1.5 text-[10.5px] font-bold tracking-widest text-[#2fd47b] transition hover:bg-[rgba(47,212,123,0.18)] disabled:opacity-50"
              >
                {replaying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                {replaying ? "REPLAYING…" : "RUN REPLAY CHECK"}
              </button>
              {replay && (
                <div className="mono mt-2 space-y-1 rounded-md bg-[rgba(4,7,12,0.55)] p-2 text-[9.5px]">
                  <div className={`flex items-center gap-1.5 font-bold ${replay.ok ? "text-[#2fd47b]" : "text-[#f0506e]"}`}>
                    {replay.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                    {replay.ok ? "PASS — NO REPAINT DETECTED" : "FAIL — REVIEW REQUIRED"}
                  </div>
                  <div className="text-[#7d8ca3]">
                    {replay.noRepaint.checkedPoints} pts checked · maxΔ {replay.noRepaint.maxValueDiff} · {replay.candlesTotal} candles / {replay.sessions} sessions · grid {replay.candleGrid.offGridCandles === 0 ? "aligned" : `${replay.candleGrid.offGridCandles} off-grid`}
                  </div>
                </div>
              )}
            </div>
            <div className="flex items-start gap-1.5 text-[9.5px] text-[#54637a]">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-[#f5b53f]" />
              Evidence engine only — FMPI issues no buy/sell orders and never forces a trade from an extreme reading.
            </div>
          </div>
        )}
      </div>

      <div className="mono border-t border-[rgba(125,165,220,0.1)] px-3 py-2 text-[9px] leading-relaxed text-[#54637a]">
        {l ? `last candle ${fmtIstLabel(l.ts)}` : "no data"}
        <br />
        {payload.dataSource}
      </div>
    </aside>
  );
}

function ScoreBar({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="panel-title">{label}</span>
        <span className="mono text-[11px] font-bold" style={{ color }}>{value == null ? "—" : fmtNum(value, 0)}</span>
      </div>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${value ?? 0}%`, background: color }} />
      </div>
    </div>
  );
}

function Stat({ label, v, accent }: { label: string; v: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-[rgba(125,165,220,0.1)] px-2 py-1.5">
      <div className="text-[8px] tracking-[0.14em] text-[#4a586e]">{label}</div>
      <div className={`mono mt-0.5 text-[10.5px] font-semibold ${accent ? "text-[#fb923c]" : "text-[#c8d6ea]"}`}>{v}</div>
    </div>
  );
}

function ZoneRows({ zb, value }: { zb: NonNullable<FmpiSeriesPayload["zones"]>; value: number }) {
  const rows: [keyof typeof ZONE_META, number, number][] = [
    ["overbought", zb.overboughtLower, 100],
    ["bullish", zb.equilibriumUpper, zb.overboughtLower],
    ["equilibrium", zb.equilibriumLower, zb.equilibriumUpper],
    ["bearish", zb.oversoldUpper, zb.equilibriumLower],
    ["oversold", 0, zb.oversoldUpper],
  ];
  return (
    <div className="space-y-1.5">
      {rows.map(([zone, lo, hi]) => {
        const active = value >= lo && value <= hi;
        const m = ZONE_META[zone];
        return (
          <div
            key={zone}
            className="flex items-center justify-between rounded-lg border p-2.5"
            style={{ borderColor: active ? `${m.color}66` : "rgba(125,165,220,0.1)", background: active ? m.fill : "transparent" }}
          >
            <span className="flex items-center gap-2 text-[11px] font-semibold" style={{ color: m.color }}>
              <span className="h-2 w-2 rounded-[3px]" style={{ background: m.color }} />
              {m.label}
            </span>
            <span className="mono text-[11px] text-[#c8d6ea]">
              {fmtNum(lo)} – {fmtNum(hi)}
              {active && <span className="ml-1.5 text-[8.5px] tracking-widest text-[#41c8ff]">◉ NOW</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-[rgba(125,165,220,0.1)] p-2.5">
      <div className="panel-title mb-1">{title}</div>
      <p>{children}</p>
    </div>
  );
}
