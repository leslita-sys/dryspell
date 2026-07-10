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

- **Weather:** one batched [Open-Meteo](https://open-meteo.com/) call per 15 minutes covering 18 forecast grid cells (HRDPS 2.5 km, Canada's high-res model) — past 7 days + next 7 days, hourly. ECMWF precip rides along in the same call for the confidence badge.
- **Wetness bucket:** each area replays a per-hour wetness state (mm): rain fills it (scaled by canopy), drying energy drains it (solar radiation gated by when sun actually hits that aspect, wind, vapor pressure deficit). Bucket empty = dry; first empty hour in the forecast = the "Dry Sat ~1 PM" verdict.
- **Guidebook data** (`data/squamish_areas.json`): sun-aspect icons, dries-fast / climbable-in-rain flags, hike times, GPS, and drying prose for all 73 areas, extracted from the Squamish Bouldering guide V4 by `tools/parse_areas.py`. Derived from a licensed book — personal/crew use only; don't republish the dataset.
- **Coefficients** live in one `MODEL` block in `lib/model.js`, documented and tunable. They're physics-informed first guesses; v2 calibrates them against real "was it dry?" feedback.
- **Seepage:** areas whose guidebook notes mention seepage get a lingering warning after >1 inch of 3-day rain, independent of surface drying.

Server is stateless — no database, nothing persisted except a last-good weather cache (`data/cache/`, gitignored).

## Tests

```bash
npm test   # node --test, 14 tests: model physics, fetcher cache, API shape
```

## Deploy (Render)

Same pattern as COLORWAY: push to GitHub, create a Render web service, start command `node server.js`. The server binds `0.0.0.0:$PORT` automatically when `PORT` is set. No secrets needed.

## v2 ideas

- "Was it dry?" feedback buttons feeding coefficient calibration (with rolling backups per house rules)
- Squamish Airport observed-rain cross-check
- Weekend-specific best-bets projection, webcam links, Telegram morning report
