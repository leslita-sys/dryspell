# DRYSPELL

Granite dryness forecasts for Squamish bouldering. One question, answered per area: is the rock dry, and if not, when.

## Quick start

```bash
node server.js
# http://127.0.0.1:4328
```

Node 22+. Zero dependencies. No API keys.

Restart by port only — several local apps share the `node server.js` command line:

```bash
lsof -tiTCP:4328 -sTCP:LISTEN | xargs kill
```

## System

| Layer | What it does |
| --- | --- |
| Weather | One batched Open-Meteo call per 15 min. 18 grid cells, hourly, past 7 days + next 8. Model `gem_seamless` (HRDPS 2.5 km near-term, regional GEM beyond ~48h). ECMWF precip and a live 15-minute rain gauge ride along in the same call. |
| Blend | Past hours take the wetter of GEM and ECMWF; the live gauge floors the now-hour. Forecast hours stay GEM. Model disagreement on the forecast drives the confidence badge, not the bucket. |
| Wetness bucket | Per-area hourly replay: blended rain fills (scaled by canopy), drying energy drains (solar radiation gated by the area's sun-aspect window, wind, vapor pressure deficit). First empty hour = the verdict. |
| Verdicts | `DRY NOW` / `Dry today ~4 PM` / `WET`, plus a seepage watch for areas whose guidebook notes flag it. All timestamps Vancouver-local regardless of host timezone (`lib/time.js`). |
| Coefficients | One `MODEL` block in `lib/model.js`. First-guess physics, declared tunable. |

The server is stateless. Nothing persists except a last-good weather cache (`data/cache/`, gitignored; tests isolate via `DRYSPELL_CACHE_DIR`).

## Interface

Today's Beta one-liner. Countdown to the first dry area. Best bets ranked by dryness. Corridor map, zones colored dry / will-be-dry / wet. Today's forecast strip: hourly temp, rain bars, and a humidity band (drier air = better friction), corridor-wide. Dry-timeline chart, tabbed: by area, by boulders (grade-filterable), by climb grade. Search across areas and every problem name. Collapsible chapters with live dry-range headlines. Per-area detail with a 14-day / next-24h chart toggle. Inches first, mm second.

## Data

Derived from the Squamish Bouldering guide V4. Personal and crew use only — never republish these files. Repo stays private.

| File | Contents | Generator |
| --- | --- | --- |
| `data/squamish_areas.json` | 73 areas: sun aspect, dries-fast / rainproof flags, hike time, GPS, drying prose | `tools/parse_areas.py` |
| `data/problems.json` | 3,569 problem names mapped to areas | `tools/parse_problems.py` |
| `data/area_grades.json` | Per-area problem counts by band (V0-2 / V3-6 / V7-9 / V10+), ~10% prose noise | `tools/parse_grades.py` |

## Tests

```bash
npm test
```

16 tests: model physics, blend behavior, cache isolation, API shape, label correctness. The suite also passes under `TZ=UTC` — the Render case.

## Deploy

Push to GitHub, point a Render web service at it, start command `node server.js`. The server binds `0.0.0.0:$PORT` when `PORT` is set. No secrets.

## Backlog

- Condition logging ("was it dry?") feeding coefficient calibration, with rolling backups
- Squamish Airport observed-rain cross-check; longer rain lookback
- Self-hosted fonts; webcam links; Telegram morning report
