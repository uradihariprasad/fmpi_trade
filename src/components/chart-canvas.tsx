"use client";

/**
 * Candlestick + FMPI dual-panel canvas renderer.
 * Layout mirrors the reference: price panel on top with an integrated
 * volume histogram, synchronized FMPI oscillator panel underneath with
 * translucent adaptive zone bands (trailing per-bar boundaries), dashed
 * boundary lines, right-side zone labels, confirmed/candidate swing
 * markers and a highlighted current reading.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Candle, FmpiPoint, FmpiSeriesPayload, ZoneBoundaries } from "@/lib/fmpi/types";
import { ZONE_META, fmtNum, fmtPrice, stateColor } from "@/lib/client/format";
import { fmtIstTime, istDateStr } from "@/lib/market/session";

interface Props {
  payload: FmpiSeriesPayload;
  hovered: number | null;
  onHover: (i: number | null, clientX: number, clientY: number) => void;
}

interface View {
  end: number; // right-most visible bar index (float, = n-1 + margin right)
  pxPerBar: number;
}

const BG = "#04070c";
const GRID = "rgba(125,165,220,0.07)";
const GRID_STRONG = "rgba(125,165,220,0.14)";
const TXT = "#7d8ca3";
const UP = "#2fd47b";
const DOWN = "#f0506e";
const PROV = "#41c8ff";

export function ChartCanvas({ payload, hovered, onHover }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 620 });
  const [view, setView] = useState<View>({ end: -1, pxPerBar: 7 });
  const dragRef = useRef<{ x: number; end: number; moved: boolean } | null>(null);

  const points = payload.points;
  const candles = payload.candles;
  const n = points.length;

  // follow the live edge whenever a fresh dataset loads
  useEffect(() => {
    setView((v) =>
      v.end === -1
        ? { end: n - 1 + 6, pxPerBar: size.w < 620 ? 4.5 : 7 }
        : Math.abs(v.end - (n - 1 + 6)) > 400
          ? { ...v, end: n - 1 + 6 }
          : v,
    );
  }, [n, size.w]);

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(320, r.width), h: Math.max(280, r.height) });
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const clampView = useCallback(
    (v: View): View => {
      const pxPerBar = Math.min(42, Math.max(1.6, v.pxPerBar));
      const maxEnd = n - 1 + 10;
      const minEnd = Math.min(30, maxEnd);
      return { pxPerBar, end: Math.min(maxEnd, Math.max(minEnd, v.end)) };
    },
    [n],
  );

  /* ------------------------------------------------ interactions -- */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => {
        const rect = cv.getBoundingClientRect();
        const padL = 8;
        const frac = (e.clientX - rect.left - padL) / Math.max(1, rect.width - padL - 150);
        const start = v.end - (rect.width - padL - 150) / v.pxPerBar;
        const anchor = start + frac * ((rect.width - padL - 150) / v.pxPerBar);
        const next = clampView({ ...v, pxPerBar: v.pxPerBar * (e.deltaY > 0 ? 0.9 : 1.12) });
        const visW = (rect.width - padL - 150) / next.pxPerBar;
        return clampView({ pxPerBar: next.pxPerBar, end: anchor + (1 - frac) * visW });
      });
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [clampView]);

  const barFromX = useCallback(
    (clientX: number): number | null => {
      const cv = canvasRef.current;
      if (!cv || n === 0) return null;
      const rect = cv.getBoundingClientRect();
      const padL = 8;
      const plotW = rect.width - padL - 150;
      const x = clientX - rect.left - padL;
      const start = view.end - plotW / view.pxPerBar;
      const i = Math.round(start + x / view.pxPerBar);
      return i >= 0 && i < n ? i : null;
    },
    [view, n],
  );

  /* ---------------------------------------------------- rendering -- */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || n === 0) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    cv.width = Math.round(size.w * dpr);
    cv.height = Math.round(size.h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size.w, size.h);

    const narrow = size.w < 620;
    const tiny = size.w < 430;
    const padL = 8;
    const gutterR = narrow ? 92 : 150; // right gutter: zone labels / price scale
    const plotW = size.w - padL - gutterR;
    const axisH = 20;
    const priceTop = 26;
    const priceH = (size.h - axisH - 14) * 0.56;
    const volH = priceH * 0.22;
    const candleH = priceH - volH;
    const fmpiTop = priceTop + priceH + 14;
    const fmpiH = size.h - axisH - 6 - fmpiTop;

    const start = view.end - plotW / view.pxPerBar;
    const x = (i: number) => padL + (i - start + 0.5) * view.pxPerBar;
    const visFirst = Math.max(0, Math.floor(start));
    const visLast = Math.min(n - 1, Math.ceil(view.end));
    const lc = candles[n - 1];

    /* ------- price panel ------- */
    let pMin = Infinity, pMax = -Infinity, vMax = 0;
    for (let i = visFirst; i <= visLast; i++) {
      const c = candles[i];
      if (!c) continue;
      pMin = Math.min(pMin, c.low);
      pMax = Math.max(pMax, c.high);
      vMax = Math.max(vMax, c.volume);
    }
    if (!Number.isFinite(pMin)) { pMin = 0; pMax = 1; }
    const pPad = (pMax - pMin) * 0.08 || pMax * 0.001 || 1;
    pMin -= pPad; pMax += pPad;
    const py = (p: number) => priceTop + ((pMax - p) / (pMax - pMin)) * candleH;
    const vy = (v: number) => priceTop + candleH + volH - (vMax ? (v / vMax) * (volH - 4) : 0);

    // horizontal grid + price scale
    ctx.font = `${narrow ? 8.5 : 9.5}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = "left";
    for (let g = 0; g <= 4; g++) {
      const p = pMin + ((pMax - pMin) * g) / 4;
      const yy = py(p);
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillStyle = TXT;
      ctx.fillText(fmtPrice(p), padL + plotW + 6, yy + 3);
    }
    // volume baseline
    ctx.strokeStyle = GRID_STRONG;
    ctx.beginPath(); ctx.moveTo(padL, priceTop + candleH + volH); ctx.lineTo(padL + plotW, priceTop + candleH + volH); ctx.stroke();

    // session separators + time grid (shared across panels)
    const tickEvery = Math.max(1, Math.round((narrow ? 54 : 72) / view.pxPerBar));
    for (let i = visFirst; i <= visLast; i++) {
      const c = candles[i];
      if (!c) continue;
      const isDayStart = i === 0 || istDateStr(c.ts) !== istDateStr(candles[i - 1].ts);
      if (isDayStart && i !== 0) {
        ctx.strokeStyle = "rgba(125,165,220,0.18)";
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(x(i), priceTop); ctx.lineTo(x(i), fmpiTop + fmpiH); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (i % tickEvery === 0 || isDayStart) {
        const label = isDayStart
          ? `${istDateStr(c.ts).slice(5).split("-").reverse().join("/")} ${fmtIstTime(c.ts)}`
          : fmtIstTime(c.ts);
        ctx.fillStyle = isDayStart ? "#9db4d4" : "#54637a";
        ctx.fillText(label, x(i) - 14, size.h - 6);
        ctx.strokeStyle = GRID;
        ctx.beginPath(); ctx.moveTo(x(i), fmpiTop); ctx.lineTo(x(i), fmpiTop + fmpiH); ctx.stroke();
      }
    }

    // volume histogram + candles
    const bw = Math.max(1, view.pxPerBar * 0.62);
    for (let i = visFirst; i <= visLast; i++) {
      const c = candles[i];
      if (!c) continue;
      const up = c.close >= c.open;
      const col = c.open === c.close ? "#5b6b84" : up ? UP : DOWN;
      const cx = x(i);
      if (vMax > 0) {
        ctx.fillStyle = up ? "rgba(47,212,123,0.34)" : "rgba(240,80,110,0.34)";
        ctx.fillRect(cx - bw / 2, vy(c.volume), bw, priceTop + candleH + volH - vy(c.volume));
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, Math.min(1.4, view.pxPerBar * 0.12));
      ctx.beginPath(); ctx.moveTo(cx, py(c.high)); ctx.lineTo(cx, py(c.low)); ctx.stroke();
      ctx.fillStyle = col;
      const o = py(c.open), cl = py(c.close);
      const top = Math.min(o, cl), hgt = Math.max(1, Math.abs(o - cl));
      if (view.pxPerBar > 2.4) ctx.fillRect(cx - bw / 2, top, bw, hgt);
      else { ctx.beginPath(); ctx.moveTo(cx, top); ctx.lineTo(cx, top + hgt); ctx.stroke(); }
    }
    // futures basis overlay — a thin amber line for the linked futures
    // contract next to the SPOT candles, making spot vs futures explicit
    const futs = payload.futuresSeries;
    if (futs && futs.length > 1) {
      const futByTs = new Map(futs.map((f) => [f.ts, f.close]));
      ctx.strokeStyle = "rgba(245,181,63,0.85)";
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      let run = false;
      for (let i = visFirst; i <= visLast; i++) {
        const c = candles[i];
        const f = c ? futByTs.get(c.ts) : undefined;
        if (f == null) { run = false; continue; }
        const yy = py(f);
        if (!run) { ctx.moveTo(x(i), yy); run = true; } else ctx.lineTo(x(i), yy);
      }
      ctx.stroke();
      // SPOT / FUT legend (top-right of the price panel)
      const f = payload.futures;
      const basisTxt = f?.basisPct != null ? ` basis ${f.basisPct >= 0 ? "+" : ""}${f.basisPct.toFixed(2)}%` : "";
      ctx.font = `bold ${narrow ? 8 : 9}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "right";
      const lx = padL + plotW - 8;
      ctx.fillStyle = "#f5b53f";
      ctx.fillText(`— FUT${f?.lastClose != null && !tiny ? ` ${fmtPrice(f.lastClose)}` : ""}${narrow ? "" : basisTxt}`, lx, priceTop + 11);
      ctx.fillStyle = "#41c8ff";
      ctx.fillText(`— SPOT ${lc && !tiny ? fmtPrice(lc.close) : ""}`, lx, priceTop + (narrow ? 21 : 23));
      ctx.textAlign = "left";
    }
    // provisional live candle frame
    const lastPoint = points[n - 1];
    if (lastPoint?.provisional) {
      const cx = x(n - 1);
      ctx.strokeStyle = PROV;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(cx - bw, priceTop, bw * 2, priceH);
      ctx.setLineDash([]);
      ctx.fillStyle = PROV;
      ctx.font = "bold 8.5px ui-monospace, Menlo, monospace";
      ctx.fillText("LIVE", cx - 9, priceTop + 10);
    }
    // last price marker
    if (lc) {
      const yy = py(lc.close);
      ctx.strokeStyle = lc.close >= lc.open ? UP : DOWN;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lc.close >= lc.open ? UP : DOWN;
      const t = fmtPrice(lc.close);
      ctx.fillRect(padL + plotW + 2, yy - 8, gutterR - 8, 15);
      ctx.fillStyle = "#04101c";
      ctx.font = "bold 10px ui-monospace, Menlo, monospace";
      ctx.fillText(t, padL + plotW + 7, yy + 3.5);
    }

    /* ------- FMPI panel ------- */
    const fy = (v: number) => fmpiTop + (1 - Math.min(100, Math.max(0, v)) / 100) * fmpiH;
    // 0..100 left scale
    ctx.font = `${narrow ? 8.5 : 9.5}px ui-monospace, Menlo, monospace`;
    for (const lv of [0, 20, 40, 60, 80, 100]) {
      const yy = fy(lv);
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + plotW, yy); ctx.stroke();
      ctx.fillStyle = TXT;
      ctx.fillText(String(lv), padL - 2 < 0 ? 0 : 0, yy + 3);
    }
    ctx.fillStyle = "#4a586e";
    ctx.font = "8.5px ui-monospace, Menlo, monospace";
    ctx.fillText("FMPI (5M/10M · 0–100)", padL, fmpiTop - 4 > 0 ? fmpiTop - 4 : 8);

    // adaptive zone bands from per-bar trailing boundaries (causal, non-repainting)
    const zoneSpan = (
      lower: keyof ZoneBoundaries | "ZERO" | "HUNDRED",
      upper: keyof ZoneBoundaries | "ZERO" | "HUNDRED",
      fill: string,
    ) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      let started = false;
      for (let i = visFirst; i <= visLast; i++) {
        const zb = points[i]?.zoneBoundaries;
        if (!zb) continue;
        const vv = upper === "HUNDRED" ? 100 : upper === "ZERO" ? 0 : zb[upper];
        const yy = fy(vv as number);
        if (!started) { ctx.moveTo(x(i), yy); started = true; } else ctx.lineTo(x(i), yy);
      }
      if (!started) return;
      for (let i = visLast; i >= visFirst; i--) {
        const zb = points[i]?.zoneBoundaries;
        if (!zb) continue;
        const vv = lower === "ZERO" ? 0 : lower === "HUNDRED" ? 100 : zb[lower];
        ctx.lineTo(x(i), fy(vv as number));
      }
      ctx.closePath();
      ctx.fill();
    };
    zoneSpan("overboughtLower", "HUNDRED", ZONE_META.overbought.fill);
    zoneSpan("equilibriumUpper", "overboughtLower", ZONE_META.bullish.fill);
    zoneSpan("equilibriumLower", "equilibriumUpper", ZONE_META.equilibrium.fill);
    zoneSpan("oversoldUpper", "equilibriumLower", ZONE_META.bearish.fill);
    zoneSpan("ZERO", "oversoldUpper", ZONE_META.oversold.fill);

    // dashed boundary trails
    const trail = (key: keyof ZoneBoundaries, color: string, dash: number[], alpha = 0.85, width = 1) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let i = visFirst; i <= visLast; i++) {
        const zb = points[i]?.zoneBoundaries;
        if (!zb) continue;
        const yy = fy(zb[key] as number);
        if (!started) { ctx.moveTo(x(i), yy); started = true; } else ctx.lineTo(x(i), yy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    };
    trail("overboughtLower", ZONE_META.overbought.color, [5, 4]);
    trail("equilibriumUpper", ZONE_META.bullish.color, [4, 4], 0.55);
    trail("equilibriumLower", ZONE_META.bearish.color, [4, 4], 0.55);
    trail("oversoldUpper", ZONE_META.oversold.color, [5, 4]);
    trail("overboughtUpper", "#f5b53f", [1.5, 4], 0.4);
    trail("oversoldLower", "#f5b53f", [1.5, 4], 0.4);

    // warm-up hatch
    let warmEnd = -1;
    for (let i = 0; i < n; i++) if (points[i].quality === "warming_up") warmEnd = i;
    if (warmEnd >= visFirst && warmEnd <= visLast) {
      ctx.fillStyle = "rgba(107,114,128,0.08)";
      ctx.fillRect(x(visFirst), fmpiTop, Math.max(0, x(warmEnd) - x(visFirst)), fmpiH);
      ctx.fillStyle = "#54637a";
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.fillText("warm-up — zones need more history", x(visFirst) + 6, fmpiTop + 14);
    }

    // FMPI polyline, segmented by state
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (let i = Math.max(visFirst, 1); i <= visLast; i++) {
      const a = points[i - 1], b = points[i];
      if (!a || !b) continue;
      const warm = b.quality === "warming_up";
      const col = warm ? "#5b6b84" : b.state === "insufficient_data" ? "#5b6b84" : stateColor(b.state);
      ctx.strokeStyle = col;
      ctx.globalAlpha = warm ? 0.55 : 1;
      if (b.provisional) ctx.setLineDash([4, 3]);
      ctx.shadowColor = col;
      ctx.shadowBlur = warm || b.provisional ? 0 : 5;
      ctx.beginPath();
      ctx.moveTo(x(i - 1), fy(a.value));
      ctx.lineTo(x(i), fy(b.value));
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // swing markers — all confirmed pivots get triangles; value labels are
    // greedily spaced so dense sequences stay readable (data untouched)
    if (view.pxPerBar > 2.2) {
      ctx.font = "bold 9px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      let lastLabelX = -1e9;
      for (const tp of payload.turningPoints) {
        if (tp.index < visFirst - 2 || tp.index > visLast + 2) continue;
        const cx = x(tp.index);
        const yy = fy(tp.value);
        const isPeak = tp.kind === "peak";
        const mark = isPeak ? "#f5b53f" : "#38bdf8";
        ctx.fillStyle = mark;
        ctx.strokeStyle = mark;
        if (tp.confirmed) {
          ctx.beginPath();
          if (isPeak) { ctx.moveTo(cx, yy - 5); ctx.lineTo(cx - 4.5, yy - 13); ctx.lineTo(cx + 4.5, yy - 13); }
          else { ctx.moveTo(cx, yy + 5); ctx.lineTo(cx - 4.5, yy + 13); ctx.lineTo(cx + 4.5, yy + 13); }
          ctx.closePath(); ctx.fill();
          if (cx - lastLabelX >= 34) {
            const labelY = isPeak ? Math.max(fmpiTop + 8, yy - 17) : Math.min(fmpiTop + fmpiH - 4, yy + 23);
            ctx.fillText(tp.value.toFixed(1), cx, labelY);
            lastLabelX = cx;
          }
        } else {
          ctx.beginPath();
          if (isPeak) { ctx.moveTo(cx, yy - 4); ctx.lineTo(cx - 4, yy - 11); ctx.lineTo(cx + 4, yy - 11); }
          else { ctx.moveTo(cx, yy + 4); ctx.lineTo(cx - 4, yy + 11); ctx.lineTo(cx + 4, yy + 11); }
          ctx.closePath(); ctx.stroke();
        }
      }
      ctx.textAlign = "left";
    }

    // current reading marker + pill on FMPI panel
    if (lastPoint) {
      const yy = fy(lastPoint.value);
      const col = lastPoint.quality === "warming_up" ? "#6b7280" : stateColor(lastPoint.state);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(x(n - 1), yy, 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.stroke();
      const txt = `${lastPoint.value.toFixed(1)} ${lastPoint.change != null ? (lastPoint.change >= 0 ? "+" : "") + lastPoint.change.toFixed(1) : ""}`;
      ctx.font = "bold 10.5px ui-monospace, Menlo, monospace";
      const wpx = ctx.measureText(txt).width + 14;
      ctx.fillStyle = col;
      roundRect(ctx, padL + plotW + 4, yy - 9, Math.max(wpx, gutterR - 10), 18, 5);
      ctx.fill();
      ctx.fillStyle = "#04101c";
      ctx.fillText(txt, padL + plotW + 4 + 7, yy + 3.5);
    }

    // right-gutter zone labels with the live numeric ranges
    const zb = lastPoint?.zoneBoundaries;
    if (zb) {
      const short: Record<string, string> = narrow
        ? { overbought: "OB", bullish: "BULL", equilibrium: "EQUIL", bearish: "BEAR", oversold: "OS" }
        : {};
      const rows: [string, number, number, string][] = [
        [ZONE_META.overbought.label, zb.overboughtLower, 100, ZONE_META.overbought.color],
        [ZONE_META.bullish.label, zb.equilibriumUpper, zb.overboughtLower, ZONE_META.bullish.color],
        [ZONE_META.equilibrium.label, zb.equilibriumLower, zb.equilibriumUpper, ZONE_META.equilibrium.color],
        [ZONE_META.bearish.label, zb.oversoldUpper, zb.equilibriumLower, ZONE_META.bearish.color],
        [ZONE_META.oversold.label, 0, zb.oversoldUpper, ZONE_META.oversold.color],
      ];
      ctx.font = `${narrow ? 7.5 : 8.5}px ui-monospace, Menlo, monospace`;
      for (const [label, lo, hi, col] of rows) {
        const midY = fy((lo + hi) / 2);
        const labelY = Math.min(fmpiTop + fmpiH - 6, Math.max(fmpiTop + 14, midY));
        ctx.fillStyle = col;
        ctx.globalAlpha = 0.92;
        const shown = narrow
          ? short[label === ZONE_META.overbought.label ? "overbought" : label === ZONE_META.bullish.label ? "bullish" : label === ZONE_META.equilibrium.label ? "equilibrium" : label === ZONE_META.bearish.label ? "bearish" : "oversold"]
          : label.toUpperCase();
        ctx.fillText(shown, padL + plotW + 6, labelY - 3);
        ctx.fillStyle = "#8ea3c4";
        ctx.fillText(`${fmtNum(lo)}–${fmtNum(hi)}`, padL + plotW + 6, labelY + (narrow ? 6 : 8));
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.fillStyle = "#54637a";
      ctx.font = "9px ui-monospace, Menlo, monospace";
      ctx.fillText("zones: warming up", padL + plotW + 6, fmpiTop + 16);
    }

    // crosshair
    if (hovered != null && hovered >= 0 && hovered < n) {
      const cx = x(hovered);
      ctx.strokeStyle = "rgba(180,205,240,0.55)";
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(cx, priceTop); ctx.lineTo(cx, fmpiTop + fmpiH); ctx.stroke();
      ctx.setLineDash([]);
      const c = candles[hovered], p = points[hovered];
      if (c) {
        const legend =
          `${fmtIstTime(c.ts)}  O ${fmtPrice(c.open)}  H ${fmtPrice(c.high)}  L ${fmtPrice(c.low)}  C ${fmtPrice(c.close)}` +
          (c.volume ? `  V ${(c.volume / 1000).toFixed(0)}k` : "");
        ctx.fillStyle = "#c8d6ea";
        ctx.font = "10px ui-monospace, Menlo, monospace";
        ctx.fillText(legend, padL + 4, priceTop - 8);
        // hover dot on price
        ctx.strokeStyle = "#c8d6ea";
        ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.arc(cx, py(c.close), 3, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (p) {
        const yy = fy(p.value);
        ctx.strokeStyle = stateColor(p.state);
        ctx.beginPath(); ctx.arc(cx, yy, 3.6, 0, Math.PI * 2); ctx.stroke();
        const lbl = p.value.toFixed(1);
        ctx.fillStyle = stateColor(p.state);
        ctx.fillRect(padL + plotW + 4, yy - 8, 34, 15);
        ctx.fillStyle = "#04101c";
        ctx.font = "bold 10px ui-monospace, Menlo, monospace";
        ctx.fillText(lbl, padL + plotW + 9, yy + 3);
      }
    } else if (lc) {
      ctx.fillStyle = "#c8d6ea";
      ctx.font = "10px ui-monospace, Menlo, monospace";
      const legend = `O ${fmtPrice(lc.open)}  H ${fmtPrice(lc.high)}  L ${fmtPrice(lc.low)}  C ${fmtPrice(lc.close)}`;
      ctx.fillText(legend, padL + 4, priceTop - 8);
    }

    // panel divider
    ctx.strokeStyle = GRID_STRONG;
    ctx.beginPath(); ctx.moveTo(padL, priceTop + priceH + 7); ctx.lineTo(padL + plotW + gutterR - 8, priceTop + priceH + 7); ctx.stroke();
  }, [payload, hovered, view, size, n, points, candles]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        className="chart"
        onPointerMove={(e) => {
          if (dragRef.current) {
            const dx = e.clientX - dragRef.current.x;
            if (Math.abs(dx) > 2) dragRef.current.moved = true;
            setView((v) => clampView({ ...v, end: dragRef.current!.end + dx / v.pxPerBar }));
            return;
          }
          const i = barFromX(e.clientX);
          onHover(i, e.clientX, e.clientY);
        }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { x: e.clientX, end: view.end, moved: false };
        }}
        onPointerUp={() => {
          const wasDrag = dragRef.current?.moved;
          dragRef.current = null;
          if (!wasDrag) onHover(null, 0, 0);
        }}
        onPointerLeave={() => {
          dragRef.current = null;
          onHover(null, 0, 0);
        }}
        onDoubleClick={() => setView((v) => clampView({ end: n - 1 + 6, pxPerBar: v.pxPerBar }))}
      />
    </div>
  );
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
