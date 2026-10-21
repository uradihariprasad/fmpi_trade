/**
 * NSE/BSE trading-session mathematics (Asia/Kolkata).
 * Candle boundaries are aligned to the exchange session clock, exactly as
 * the exchange emits them: 09:15 open, 15:30 close. The 10-minute grid
 * legitimately ends with a truncated 15:25→15:30 candle (375 % 10 ≠ 0).
 */

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const SESSION_OPEN_MIN = 9 * 60 + 15; // 555
export const SESSION_CLOSE_MIN = 15 * 60 + 30; // 930

export function istMs(utcMs: number): number {
  return utcMs + IST_OFFSET_MS;
}

/** 'YYYY-MM-DD' of an instant in IST. */
export function istDateStr(msUtc: number): string {
  const d = new Date(istMs(msUtc));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Minutes-since-midnight in IST for an instant. */
export function istMinutes(msUtc: number): number {
  const d = new Date(istMs(msUtc));
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** UTC ms of the session-minute grid point for an IST date. */
export function gridpointMs(dateStr: string, minuteOfDay: number): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 0, minuteOfDay) - IST_OFFSET_MS;
}

/** IST weekday of an instant (0=Sun … 6=Sat). */
export function istWeekday(msUtc: number): number {
  return new Date(istMs(msUtc)).getUTCDay();
}

/**
 * NSE trading-holiday list (2026, per exchange circular) — used only as a
 * UX hint. The authoritative session detector is always actual returned
 * candle data; gaps in data are treated as non-sessions.
 */
export const NSE_HOLIDAYS_2026 = new Set<string>([
  "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
  "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-07-14",
  "2026-08-15", "2026-08-28", "2026-10-02", "2026-10-20", "2026-11-08",
  "2026-11-24", "2026-12-25",
]);

export function isPotentialTradingDay(istDate: string, utcMs: number): boolean {
  const wd = istWeekday(utcMs);
  if (wd === 0 || wd === 6) return false;
  return !NSE_HOLIDAYS_2026.has(istDate);
}

export type MarketPhase = "open" | "closed" | "pre_open" | "post_close";

export function marketPhase(nowUtc: number): MarketPhase {
  const ds = istDateStr(nowUtc);
  if (!isPotentialTradingDay(ds, nowUtc)) return "closed";
  const mins = istMinutes(nowUtc) + new Date(nowUtc).getUTCSeconds() / 60;
  if (mins < 9 * 60) return "closed";
  if (mins < SESSION_OPEN_MIN) return "pre_open";
  if (mins <= SESSION_CLOSE_MIN) return "open";
  return "post_close";
}

/**
 * Candle open-grid for a timeframe across one session.
 * Returns minute-of-day opens; the final candle may be truncated by the
 * 15:30 close (e.g. 15:25 on the 10-minute grid).
 */
export function sessionGrid(tfMinutes: number): number[] {
  const opens: number[] = [];
  for (let m = SESSION_OPEN_MIN; m < SESSION_CLOSE_MIN; m += tfMinutes) opens.push(m);
  return opens;
}

/**
 * All candles strictly completed at `nowUtc` — per-candle duration is
 * (next grid open − this open), which makes the final 10-minute candles
 * genuine 15:20→15:25 / 15:25→15:30 segments as the provider emits them.
 */
export function lastCompletedOpen(nowUtc: number, tfMinutes: number): number | null {
  const mins = istMinutes(nowUtc) + new Date(nowUtc).getUTCSeconds() / 60;
  const grid = sessionGrid(tfMinutes);
  let last: number | null = null;
  for (let gi = 0; gi < grid.length; gi++) {
    const m = grid[gi];
    const next = gi + 1 < grid.length ? grid[gi + 1] : SESSION_CLOSE_MIN;
    const dur = Math.min(next, SESSION_CLOSE_MIN) - m;
    if (mins >= m + dur) last = m; else break;
  }
  return last;
}

/** Time-of-day label fmt for axis/tooltips. */
export function fmtIstTime(msUtc: number): string {
  const d = new Date(istMs(msUtc));
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function fmtIstLabel(msUtc: number): string {
  const d = new Date(istMs(msUtc));
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${String(d.getUTCDate()).padStart(2, "0")} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${fmtIstTime(msUtc)} IST`;
}

/** The N most recent candidate session date-strings descending (weekday+holiday filtered). */
export function recentSessionCandidates(n: number, fromUtc: number): string[] {
  const out: string[] = [];
  let t = fromUtc;
  while (out.length < n + 10) {
    const ds = istDateStr(t);
    if (isPotentialTradingDay(ds, t) && !out.includes(ds)) out.push(ds);
    t -= 86_400_000;
    if (out.length === 0 && t < fromUtc - 20 * 86_400_000) break;
  }
  return out.slice(0, n + 10);
}
