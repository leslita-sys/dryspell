# DRYSPELL — Squamish Bouldering Dryness Forecast
Working name: **DRYSPELL** (rename freely). Local app at `127.0.0.1:4328`, then Render once verified.
## Goal
Answer one question per bouldering area: **is the granite dry, and if not, when will it be?** Hyper-local (per-area forecast grid cells), guidebook-aware (sun aspect, canopy, drying flags), precipitation in inches.
## Data sources
| Source | What we take | Cost |
| --- | --- | --- |
| Open-Meteo GEM API (HRDPS 2.5 km) | Hourly: precip, temp, humidity, wind, shortwave radiation, ET0 — **past 7 days + next 7 days in one call** | Free, no key |
| Open-Meteo ECMWF model (same call, `models=` param) | 7-day precip for the confidence badge | Free |
| Guidebook dataset (`data/squamish_areas.json`, extracted from Squamish Bouldering V4) | 73 areas: GPS, sun aspect icon, dries-fast / climbable-in-rain flags, approach time, drying prose notes, problem counts, chapter grouping | Done |

The 73 areas dedupe to ~12 unique forecast grid cells (areas within ~1.5 km share a cell). One cached fetch per cell, refreshed every 15 minutes.

Note: the dataset is derived from a licensed guidebook — fine for personal/crew use, but we don't publish the raw dataset or problem content anywhere public. The app shows area names, icons, and our own computed conditions only.
## The wetness-bucket model
Each area has a wetness level in mm, replayed **statelessly** on every request: start dry 7 days ago, run hourly through observed-past + forecast — no database, no cron.

**Filling (rain):** `wetness += rain_mm × canopy_catch`, capped at 15 mm (runoff beyond that).

- Open / sunny-most-of-day: catch 1.0
  
- Morning or afternoon sun: 0.9
  
- Tree-filtered (am/pm): 0.85 — canopy intercepts some rain but drips longer (handled by slower drying below)
  

**Draining (drying energy), per hour when not raining:**`drying_mm = k_area × sun_gate(hour) × (0.6·radiation + 0.25·wind + 0.15·vpd)`

- `radiation` = shortwave / 700 W/m², clamped 0–1
  
- `wind` = wind speed / 20 km/h, clamped 0–1
  
- `vpd` = vapor pressure deficit from temp+humidity, normalized (dry air pulls moisture)
  
- `sun_gate(hour)` — when the sun actually hits the rock: morning-sun areas get full radiation credit 8am–1pm (30% otherwise), afternoon-sun areas 12–7pm, sunny-all-day 1.0 always, tree-filtered 0.5 inside their am/pm window, shady 0.35 flat
  
- `k_area` = 1.4 if guidebook flags "dries fast", else 1.0
  
- Drying suppressed to near zero while raining or humidity > 92%
  

**Seepage overlay:** areas whose guidebook prose mentions seepage get a lingering-wet flag when 3-day rain exceeds 1 inch: flag lasts `2 + inches` days after rain ends (capped 14). Shown as a warning, not a hard "wet" — surface can be dry while cracks weep.

**Verdicts:** bucket ≤ 0.05 mm → **DRY**. Otherwise scan forward for the first dry hour → **"Dry Sat ~1 PM"**. Rain incoming within the window → show the dry window ("Dry Sat 1 PM – Sun night"). All coefficients live in one `MODEL` config block, documented as tunable — v2 calibrates them against real feedback.

**Confidence badge:** compare HRDPS vs ECMWF 7-day precip per cell — agree within 20% and on which days are wet → HIGH; disagree on wet-vs-dry days → LOW; else MEDIUM.
## Server
Single `server.js` (Node, no framework — matches TWEAK/COLORWAY pattern), binds `127.0.0.1:4328` locally, `0.0.0.0:$PORT` on Render.

- `GET /` — static frontend
  
- `GET /api/conditions` — all 73 areas with: current wetness, verdict + dry-time, seepage flag, confidence, hourly wetness series (past 7d + next 7d) for sparklines, per-day rain totals in inches
  
- In-memory cache of Open-Meteo responses (15 min TTL) + last-good-response fallback on disk so the app still renders if the API hiccups
  

No user data is persisted in v1 — nothing to back up, nothing private. (Feedback logging arrives in v2 and will follow the rolling-backup rule from day one.)
## Frontend
One dark, outdoorsy, phone-first page. Design bar: TWEAK standard — composition-led, 17–18px body, no emoji headers, no AI slop.

- **Best Bets strip** at top: ranked areas for today + the weekend ("Sat: Lower Bluffs, Cat Lake, The Talus")
  
- **11 chapter groups** (Grand Wall, North Walls, Murrin…) in guidebook south→north order, each a grid of area cards
  
- **Area card:** name, verdict pill (DRY NOW green / DRY SAT 1PM amber / WET slate), 14-day wetness sparkline (past fading out, forecast solid, rain bars beneath), sun-aspect + hike-time from the guidebook, dries-fast / climbable-in-rain / seepage badges
  
- **Tap a card** → hourly detail: wetness curve, rain (inches), the drying-energy factors, and the guidebook's drying note verbatim when it has one
  
- Units: inches primary, mm subtitle
  
- Charts follow the dataviz skill system (consistent palette, accessible in dark)
  
## Local → Render path
1. Build + verify at `127.0.0.1:4328` (real pointer events in your Chrome, core flow re-verified after every feature)
  
2. Add row to the port registry table in leslie-app-standards
  
3. Ship-check, you use it locally
  
4. When happy: GitHub repo (leslita-sys) → Render web service, same pattern as COLORWAY. Only env change is `PORT`/bind host. No secrets needed — the weather API is keyless.
  
## Deferred to v2
- "Was it dry?" feedback buttons + coefficient calibration
  
- Squamish Airport observed-rain cross-check
  
- Webcam links, Telegram morning report via Daria
  
## Verification plan
- Model sanity: replay a known wet week (rain Thu, sun Fri–Sat) and confirm exposed dry-fast areas go DRY a day-plus before shaded forest areas; Gibbs' Cave shows seepage warning after a 1-inch storm
  
- Cross-check one cell's rain totals against Environment Canada's Squamish Airport past-24h page
  
- UI verified per house rules: real clicks in real Chrome, load → tap card → detail → back, re-run after each feature
