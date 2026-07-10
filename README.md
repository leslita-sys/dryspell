# DRYSPELL

Per-area granite dryness forecasts for all 73 Squamish bouldering areas. Answers one question: is the rock dry, and if not, when will it be?

## Run

```bash
node server.js
# → http://127.0.0.1:4328
```

No dependencies, no API keys. Node 22+.

Restart by port only (house rule — several apps share the `node server.js` command line):

```bash
lsof -tiTCP:4328 -sTCP:LISTEN | xargs kill
```

## How it works

- **Weather:** one batched [Open-Meteo](https://open-meteo.com/) call per 15 minutes covering 18 forecast grid cells, hourly, past 7 days + next 8 forecast days. Model is `gem_seamless`, Canada's GEM blend: HRDPS 2.5 km resolution for roughly the first 48h, regional/global GEM beyond. ECMWF precipitation and a live current-precipitation reading (15-minute gauge) ride along in the same call.
- **Conservative past blend:** for hours already behind us, the wetness model takes the WETTER of GEM and ECMWF, plus the live gauge as a floor at the now-hour. If either model says the rock got rained on, we assume it did. (GEM alone missed a real storm on 2026-07-10; this is the fix.) Forecast hours stay GEM-only — disagreement there feeds the confidence badge instead. Note: the daily rain table shows this blended number, deliberately biased wet.
- **"Raining now"** defers to the live gauge when present — a model forecasting rain in the current hour can't claim rain over a dry gauge.
- **Wetness bucket:** each area replays a per-hour wetness state (mm): blended rain fills it (scaled by canopy), drying energy drains it (solar radiation gated by when sun actually hits that aspect, wind, vapor pressure deficit). Bucket empty = dry; first empty hour = the "Dry Sat ~1 PM" verdict.
- **Guidebook data** (personal/crew use only, never republish — applies to ALL three derived datasets):
  - `data/squamish_areas.json` — 73 areas: sun aspect, dries-fast/rainproof flags, hike times, GPS, drying prose (24 areas have it). From `tools/parse_areas.py`.
  - `data/problems.json` — 3,569 problem names mapped to areas, powering search. From `tools/parse_problems.py`.
  - `data/area_grades.json` — per-area V-grade band counts (V0-2 / V3-6 / V7-9 / V10+) for the timeline grade filter, scanned from body text (~10% prose noise; good enough for "does this area have my grade"). From `tools/parse_grades.py`.
- **Coefficients** live in one `MODEL` block in `lib/model.js`, documented and tunable. Physics-informed first guesses; v2 calibrates against real "was it dry?" feedback.
- **Seepage:** areas whose guidebook notes mention seepage (Gibbs' Cave, The Lost World — derived at runtime in `lib/areas.js`) get a lingering warning after >1 inch of 3-day rain.

Server is stateless — no database, nothing persisted except a last-good weather cache (`data/cache/`, gitignored; tests use an isolated temp dir via `DRYSPELL_CACHE_DIR`).

## UI

Today's Beta one-liner, dryness-ranked best bets, corridor map (zones colored green/yellow/red = dry / will be dry / wet), dry-timeline scatter (every area by hours-until-dry vs water-on-rock, filterable by V-grade band, dots open the area), search across areas + all problem names, collapsible chapters with sticky quick-nav, and a week/today view toggle (today = now → +24h hourly). Inches primary, mm secondary. All timestamps Vancouver-local regardless of host timezone (`lib/time.js` — Render deploys UTC).

## Tests

```bash
npm test   # node --test, 16 tests: model physics, blend, fetcher cache, API shape, labels
```

Also passes under `TZ=UTC` (the Render case).

## Deploy (Render)

Same pattern as COLORWAY: push to GitHub, create a Render web service, start command `node server.js`. The server binds `0.0.0.0:$PORT` automatically when `PORT` is set. No secrets needed.

## v2 ideas

- "Was it dry?" feedback buttons feeding coefficient calibration (with rolling backups per house rules)
- Squamish Airport observed-rain cross-check; extend the rain lookback past 7 days
- Self-host the three fonts (offline at the crag); webcam links; Telegram morning report
