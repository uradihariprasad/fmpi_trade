# FMPI Engine — Financial Market Pressure Index

A dynamically calibrated momentum-pressure engine for the **NSE F&O universe, NIFTY and SENSEX**, built on genuine Upstox market data. FMPI is a bounded 0–100 pressure score with adaptive zones, turning-point detection, and continuation-vs-exhaustion classification — computed **only** on 5-minute and 10-minute candles.

> FMPI measures pressure, not probability. A high reading can persist through a strong uptrend and a low reading through a downtrend. Nothing here is a trade recommendation.

---

## Deploy to Render (one click, no migration step)

1. Push this repository to GitHub/GitLab.
2. In Render: **New → Blueprint → select the repo → Apply**.

`render.yaml` provisions everything:

| Resource | What it does |
|---|---|
| `fmpi-db` | Managed PostgreSQL (free plan, Singapore region) |
| `fmpi-engine` | Next.js web service, `npm ci && npm run build` → `npm run start` |
| `DATABASE_URL` | Injected automatically from the database |
| `/api/health` | Health check — also bootstraps the schema on first hit |

**No `drizzle-kit push` is needed.** The app creates its own tables idempotently (`src/db/bootstrap.ts`, all `CREATE TABLE IF NOT EXISTS`) the first time it touches the database, so a fresh deploy is self-healing. SSL is selected by host and can be overridden with `DATABASE_SSL`.

### Render database troubleshooting

If the UI reports a query failure after a deploy:

1. Open `https://YOUR-SERVICE.onrender.com/api/health`.
2. Inspect `database.status`, `database.host`, `database.ssl`, and the sanitized `database.error`.
3. In Render → web service → **Environment**, `DATABASE_URL` should be a database reference (`fromDatabase.connectionString`), not a manually copied old URL.
4. The web service and database must use the **same region**. The Blueprint sets both to Singapore.
5. Internal Render hosts look like `dpg-…-a` and must use `DATABASE_SSL=false`; external hosts ending `-postgres.render.com` require `DATABASE_SSL=true`.
6. Redeploy after correcting environment values.

PostgreSQL is a cache/audit/session store, **not the market-data source**. If it is unavailable, the app now opens a 30-second DB circuit breaker and continues loading genuine Upstox instruments and candles directly. `/api/health` remains HTTP 200 with `degraded: true` so Render does not restart-loop a usable market-data service. Daily login persistence and candle caching resume automatically when PostgreSQL recovers.

### Generic “This page couldn’t load” after a click

On Render this usually means the Node process was killed for exceeding the instance memory limit — not that the clicked React control is broken. The application now guards against that failure:

- Candle arrays use an LRU capped by `MARKET_CACHE_MAX` (64 in `render.yaml`).
- Option frames are capped by `OPTIONS_FRAME_CACHE_MAX` (2 on Render).
- Instrument masters are compacted immediately; unrelated cash/debt/currency rows and unused fields are discarded.
- Scanner, market caches, response caches and suggestion state live on `globalThis`, so separate Next.js route bundles cannot launch duplicate full-universe scans.
- Deep trade analysis waits until the universe scan is finished rather than running concurrently.
- `NODE_OPTIONS=--max-old-space-size=320` keeps V8 below the Render container ceiling.
- Route and root error boundaries provide a working RETRY action for genuine client-render errors.

`GET /api/health` includes safe runtime diagnostics:

```json
{
  "runtime": {
    "memoryMb": { "rss": 177, "heapUsed": 37, "heapTotal": 73 },
    "cache": { "candleEntries": 64, "candleMax": 64, "masterEntries": 2 }
  }
}
```

The Render-sized stress test completes all 223 instruments at ~172–177 MB RSS, then loads five deep spot/futures/options analyses sequentially while remaining below 300 MB.

### Optional environment variables

| Key | Effect if absent |
|---|---|
| `UPSTOX_ACCESS_TOKEN` | Nothing in the analysis is lost — candles, futures OI **and options OI** all come from public endpoints. A token only unlocks account-scoped APIs (profile, live quotes, orders) |
| `FMPI_ADMIN_PASSCODE` | Sign-in/sign-out endpoints are unprotected. **Set this if the service is public** |
| `PGPOOL_MAX` | Defaults to 8 connections (blueprint sets 5 for the free tier) |

Candle, instrument-master and futures-OI data come from Upstox endpoints that need **no authentication**, so the deployment works out of the box.

---

## Trade suggestions

The **TRADES** tab ranks the top 5 ideas across F&O stocks plus NIFTY and SENSEX. Ranking is by **conviction**, never by raw FMPI distance from 50 — a stretched reading on its own is explicitly not a trade.

An instrument only becomes an idea when it clears every gate:

| Gate | Rule |
|---|---|
| State | Trend-following only (acceleration / continuation / momentum) |
| Higher timeframe | Opposing 10M pressure **disqualifies** the idea outright |
| Confirmation quality | A same-direction 10M in *exhaustion* counts as a caution (−12), not a confirm |
| Unconfirmed | Conviction capped at 70, so grade A is unreachable |
| Data | Warming-up / unavailable readings can never produce an idea |
| Threshold | Conviction ≥ 55 |

Conviction is a bounded weighted blend — continuation strength (45), higher-timeframe confirmation (20), agreement among available components (20), data coverage (15) — minus penalties for exhaustion evidence, adverse divergence, and degraded data quality.

Every card shows an entry reference, a structure-anchored stop (recent swing extreme with an ATR buffer, capped at 2.5 ATR), 1R/2R targets, risk %, the supporting evidence, and the contradicting risks. Exhaustion and reversal-watch instruments appear in a separate **watch-outs** list and are never presented as entries.

**The engine returns fewer than 5 ideas — including none — when the evidence is not there.** It never pads the list. This is research output, not investment advice.

### Strike-level analysis (ATM ±3)

Every published idea is enriched with the genuine per-candle open interest of the CE/PE contracts three strikes either side of the money:

| Output | Meaning |
|---|---|
| **Support** | heaviest PE OI at/below spot — put writers defend it |
| **Resistance** | heaviest CE OI at/above spot — call writers cap it |
| **Wall state** | `building` (defenders adding) / `unwinding` (defenders covering) / `steady` |
| **Verdict** | `continuation_up/down`, `reversal_from_resistance/support`, `breakout`, `breakdown`, `range_bound` |

The strongest continuation evidence the chain offers is a wall *unwinding* in the direction of travel — call writers covering into a rally, or put writers abandoning a floor into a fall. Fresh writing at a level price is pressed against is read as reversal risk instead. Levels move conviction (+6 supporting, −18 opposing) and can push an idea back below the gate, so the enrichment can remove an idea rather than merely decorate it.

### Order flow

Signed volume per candle (`buy ≈ vol×(close−low)/range`, `sell ≈ vol×(high−close)/range`) gives cumulative delta, pressure, **absorption** (heavy volume, no progress) and **delta divergence**. Indices publish no exchange volume, so the linked futures series is used and the source is reported. This is labelled everywhere as a candle-derived estimate — Upstox does not publish tick-level bid/ask aggression on these endpoints.

### Managed trades — exit, avoid, extend

A published idea is tracked and re-evaluated on every refresh:

| Advisory | Trigger |
|---|---|
| **HOLD** | thesis intact |
| **EXTEND TGT** | price beyond T1, momentum intact, flow aligned, levels not opposing → target pushed to the **next option wall**, or +1R if no wall remains in the band |
| **EXIT** | ≥2 adverse signals (regime flip, momentum turn, levels opposing, OI shifting against, flow reversing) on a position that has already moved |
| **AVOID** | the same degradation while price is still at the suggested entry — the trade can simply be skipped |
| **TARGET HIT / STOPPED** | the level was reached on real candles |

Extension targets come from the actual option walls, so a running trade is managed against where positioning says the move should stall — not an arbitrary multiple.

## Options positioning without a login

Upstox's `/option/chain` and `/option/contract` endpoints return **HTTP 401** without a token, which is why options positioning previously reported MISSING for every instrument.

The engine no longer depends on them. Each option contract is an ordinary instrument whose **candles are public and carry per-interval open interest and volume** — the same mechanism already used for futures OI. The chain is therefore reconstructed from the contracts themselves:

1. Nearest expiry and its CE/PE strikes are resolved from the daily instrument master (NSE and BSE, so SENSEX works too).
2. Strikes covering the traded range are fetched (capped at 26 contracts per load, ~13 strikes).
3. Past sessions come from the historical endpoint; the **running session comes from the intraday endpoint**, which is the only place today's OI exists.
4. Every candle is scored with the OI/volume printed *at that candle*: standing CE/PE OI balance (35%), ΔOI since the previous bar (45%), and volume skew (20%).

This is strictly better than a chain snapshot: it is historical, point-in-time and **causal**, so `POST /api/v1/replay` now validates no-repaint across the full component set including options.

Put-side pressure reads as support, call-side as resistance. Wording distinguishes *building* from *unwinding* — when both sides shed OI the evidence says "call side unwinding faster", never "put side building".

## Daily Upstox sign-in

Upstox access tokens are day-scoped — every token dies at **03:30 IST** the next morning. The **LOGIN** button at the top-left of the header handles the daily refresh:

1. Click the button (it shows `SIGN IN`, your name, `EXPIRING`, or `EXPIRED`).
2. Paste the day's access token → **VERIFY & SAVE**.

What happens:

- The token is checked against the live Upstox **profile endpoint** before anything is stored — an invalid token is rejected and never saved.
- A valid token is persisted in Postgres, so it survives restarts and redeploys.
- The raw token is **never** returned to the browser; status responses carry only a masked form (`eyJ0••••.sig`).
- The header chip shows remaining validity and flips to `EXPIRED` after 03:30 IST, so you know when to re-authenticate.
- Signing in immediately reloads the series and activates **Options Positioning**; signing out removes the stored token.

Set `FMPI_ADMIN_PASSCODE` on any publicly reachable deployment — the dialog then requires it for both sign-in and sign-out.

### Other hosts

A multi-stage `Dockerfile` is included for Fly.io / Railway / Cloud Run / plain Docker. Only `DATABASE_URL` is required.

---

## Local development

```bash
npm install
cp .env.example .env     # point DATABASE_URL at your Postgres
npm run dev              # http://localhost:3000
```

Useful commands:

```bash
npm run build            # production build
npx vitest run           # 32 engine/unit tests
npx drizzle-kit push     # optional explicit schema push (not required)
```

---

## API (v1)

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/fmpi?instrument=NIFTY&tf=5m&sessions=14` | Full series: candles, FMPI points, dynamic zones, turning points, per-component evidence |
| `GET /api/v1/universe?q=reli` | Live F&O universe from the Upstox instrument master |
| `POST /api/v1/universe` | Force a universe re-sync |
| `GET /api/v1/scan?tf=5m` | Background momentum scanner (progressive coverage) |
| `GET/POST/DELETE /api/v1/auth/upstox` | Masked session status · verify & store a daily token · sign out |
| `GET /api/v1/top-movers?tf=5m&limit=10` | Top buying / selling pressure stocks ranked by FMPI |
| `GET /api/v1/trade-suggestions?limit=5` | Conviction-ranked trade ideas across F&O stocks + NIFTY/SENSEX |
| `POST /api/v1/replay` | No-repaint validator: prefix recomputation vs full series |
| `GET /api/health` | Liveness + schema bootstrap |

---

## How FMPI is computed

**Composite** — six direction-aware components, each normalised to `[-1, +1]`:

| Component | Weight | Unavailable when |
|---|---:|---|
| **Options positioning** | **50%** | underlying has no listed options / strike untraded at that candle |
| Price pressure & candle structure | 16% | never (core input) |
| Futures positioning (price/OI/basis) | 14% | no aligned futures snapshot |
| Volume participation | 8% | exchange reports no volume (indices) |
| Support/resistance & price structure | 8% | warm-up |
| Acceleration & persistence | 4% | warm-up |

Open interest is the only input that reveals where committed money is actually positioned, so it anchors sentiment while price, futures and volume act as confirmation.

`C = Σwᵢsᵢ / Σwᵢ(available) × (0.55 + 0.45·coverage)` → `100·logistic(k·C)` blended 75/25 with the rolling percentile of `C` → causal EMA (α 0.30 for 5M, 0.26 for 10M). Missing components are renormalised and surfaced in the UI — **never replaced with zeros**.

**Dynamic zones** — rolling quantiles (q05/q15/q40/q60/q85/q95) over the instrument's own 240 most recent FMPI observations on that timeframe, EMA-stabilised and monotonically clamped. No fixed RSI-style 30/70 levels; live numeric ranges are displayed beside the chart.

**Turning points** — local extrema over ±3 bars, confirmed by the size of the reversal that follows (measured over the next 20 bars against a gate that scales with the instrument's own FMPI dispersion). Fixed point thresholds were replaced because they do not transfer between a placid index and a volatile midcap. Candidates render hollow; confirmation timestamps are never backdated.

**Trend regime (v2)** — a 20/50-bar EMA body plus slope establishes the dominant trend over a far longer window than any single component uses. Part of the composite is anchored to it, and pressure opposing it is damped. This fixes the central failure of v1: a two-or-three candle retest bounce inside a downtrend turned every short-window component positive at once and was reported as bullish continuation. Such a bounce is now labelled **DOWNTREND · PULLBACK**, and a genuine regime flip still comes through once counter-trend pressure sustains for 5 consecutive bars.

**States** — 16 states spanning acceleration, continuation, momentum, exhaustion, reversal watch, counter-trend pullback, neutral/choppy, transition, conflicting timeframes and insufficient data. Reversal watch requires corroborating divergence: an extreme reading alone never produces one.

---

## Data integrity guarantees

- 5M and 10M series are fetched natively on their own exchange grids (09:15 IST anchored) — never derived from one another.
- The still-forming candle is flagged `provisional` / **LIVE** and visually dashed.
- Price panel shows **spot** candles; the linked futures contract is drawn as a separate amber overlay with its basis, so the two are never confused.
- `POST /api/v1/replay` proves no repainting: recomputing on a prefix reproduces every historical value, zone boundary and state exactly (`maxValueDiff = 0`).
- Instruments with insufficient history show *warming up* rather than a fabricated number.

---

## Tests

```bash
npx vitest run
```

32 tests cover the math primitives, exchange session grid, component classification (long buildup / short buildup / short covering / long unwinding, missing-OI handling), composite bounds, prefix-invariance (no repaint), dynamic zone ordering, confirmation delay, and the rule that extreme FMPI never flips to the opposite-side state.
