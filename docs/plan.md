# DRYSPELL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-area granite dryness forecasts for all 73 Squamish bouldering areas — wetness-bucket model over hyper-local Open-Meteo data, verdicts like "Dry Sat ~1 PM".

**Architecture:** Stateless Node server (no framework) fetches past-7d + next-7d hourly weather for ~12 deduped grid cells in one batched Open-Meteo call, replays a per-area wetness bucket (guidebook sun/canopy/dries-fast coefficients), serves JSON to a static dark phone-first dashboard. No database; 15-min memory cache + last-good disk fallback.

**Tech Stack:** Node 25 (built-in `fetch`, `node:test`), vanilla JS frontend, no npm dependencies.

## Global Constraints

- Bind `127.0.0.1:4328` locally; `0.0.0.0:$PORT` when `process.env.PORT` is set (Render).
- No npm dependencies anywhere. Node built-ins only.
- Precipitation displayed in inches primary, mm secondary. Internal math in mm.
- Body text ≥17px. No emojis in headers/titles.
- All model coefficients live in one exported `MODEL` object in `lib/model.js`.
- Never kill servers by pattern — only `lsof -tiTCP:4328 -sTCP:LISTEN | xargs kill`.
- Dataset `data/squamish_areas.json` already exists (73 areas) — do not regenerate; `tools/parse_areas.py` documents provenance.
- Timezone for all model math and labels: `America/Vancouver`.

---

### Task 1: Scaffold + area loading

**Files:**
- Create: `~/Desktop/dryspell/lib/areas.js`
- Create: `~/Desktop/dryspell/tests/areas.test.js`
- Create: `~/Desktop/dryspell/package.json`
- Create: `~/Desktop/dryspell/.gitignore`

**Interfaces:**
- Produces: `loadAreas()` → `Area[]` where `Area = { name, chapter, problems, lat, lon, approach, hike_min, hike_min_max?, sun, dries_fast, climbable_in_rain, drying_notes?, seepage_prone, cell }`. `sun` is one of `morning_sun | afternoon_sun | tree_filtered_sun_am | tree_filtered_sun_pm | sunny_most_of_day | shady_most_of_day | variable`. `cell` is `"lat,lon"` rounded to 0.02°. Also `uniqueCells(areas)` → `[{ key, lat, lon }]`.

- [ ] **Step 1: Write the failing test**

```js
// tests/areas.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { loadAreas, uniqueCells } = require('../lib/areas');

test('loads 73 areas with required fields', () => {
  const areas = loadAreas();
  assert.strictEqual(areas.length, 73);
  for (const a of areas) {
    assert.ok(a.name && a.chapter && a.lat && a.lon, a.name);
    assert.ok(a.sun, `${a.name} missing sun`); // nulls normalized to 'variable'
    assert.ok(typeof a.seepage_prone === 'boolean');
    assert.match(a.cell, /^49\.\d+,-123\.\d+$/);
  }
  const gibbs = areas.find(a => a.name.startsWith("Gibbs"));
  assert.strictEqual(gibbs.seepage_prone, true); // prose mentions seepage
});

test('dedupes to far fewer grid cells than areas', () => {
  const cells = uniqueCells(loadAreas());
  assert.ok(cells.length >= 5 && cells.length <= 25, `got ${cells.length}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Desktop/dryspell && node --test tests/areas.test.js`
Expected: FAIL — cannot find module '../lib/areas'

- [ ] **Step 3: Write implementation**

```js
// lib/areas.js
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data', 'squamish_areas.json');
const CELL_DEG = 0.02; // ~2.2 km lat, ~1.4 km lon at 49.7N — matches HRDPS 2.5 km grid

function snap(v) { return (Math.round(v / CELL_DEG) * CELL_DEG).toFixed(2); }

function loadAreas() {
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  return raw.map(a => ({
    name: a.name,
    chapter: a.chapter,
    problems: a.problems,
    lat: a.lat,
    lon: a.lon,
    approach: a.approach ?? null,
    hike_min: a.hike_min ?? null,
    hike_min_max: a.hike_min_max ?? null,
    sun: a.sun ?? 'variable',
    dries_fast: !!a.dries_fast,
    climbable_in_rain: !!a.climbable_in_rain,
    drying_notes: a.drying_notes ?? [],
    seepage_prone: (a.drying_notes ?? []).some(n => /seep/i.test(n)),
    cell: `${snap(a.lat)},${snap(a.lon)}`,
  }));
}

function uniqueCells(areas) {
  const seen = new Map();
  for (const a of areas) {
    if (!seen.has(a.cell)) {
      const [lat, lon] = a.cell.split(',').map(Number);
      seen.set(a.cell, { key: a.cell, lat, lon });
    }
  }
  return [...seen.values()];
}

module.exports = { loadAreas, uniqueCells };
```

```json
// package.json
{
  "name": "dryspell",
  "private": true,
  "version": "0.1.0",
  "scripts": { "start": "node server.js", "test": "node --test tests/" }
}
```

```
# .gitignore
data/cache/
.DS_Store
node_modules/
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Desktop/dryspell && node --test tests/areas.test.js`
Expected: PASS (2 tests). Note the printed cell count for the design doc's "~12" claim.

- [ ] **Step 5: Init repo and commit**

```bash
cd ~/Desktop/dryspell && git init && git add -A && git commit -m "feat: area dataset loader with grid-cell dedupe"
```

---

### Task 2: Wetness-bucket model (pure functions)

**Files:**
- Create: `~/Desktop/dryspell/lib/model.js`
- Create: `~/Desktop/dryspell/tests/model.test.js`

**Interfaces:**
- Consumes: `Area` from Task 1.
- Produces:
  - `MODEL` — all coefficients (documented, tunable).
  - `vpdKpa(tempC, rhPct)` → number.
  - `computeWetness(area, hours)` → `{ series: number[], dryAt: string|null, currentMm: number }` where `hours = { time: string[], precipitation: number[], temperature_2m: number[], relative_humidity_2m: number[], wind_speed_10m: number[], shortwave_radiation: number[], nowIndex: number }`; `series[i]` is wetness mm at `time[i]`; `dryAt` is the first ISO time at/after `nowIndex` where wetness ≤ threshold (null if never within window).
  - `seepageState(area, hours)` → `{ active: boolean, until: string|null }`.
  - `confidence(precipA, precipB)` → `'HIGH'|'MEDIUM'|'LOW'` given two 7-day hourly precip arrays.
  - `mmToIn(mm)` → number rounded to 2 decimals.

- [ ] **Step 1: Write the failing tests**

```js
// tests/model.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { MODEL, vpdKpa, computeWetness, seepageState, confidence, mmToIn } = require('../lib/model');

// Build a synthetic 96h scenario: 24h dry, 12h rain (2mm/h), then sunny/dry.
// Hour-of-day aligned: index 0 = midnight local.
function scenario() {
  const n = 96;
  const time = [], precipitation = [], temperature_2m = [], relative_humidity_2m = [],
        wind_speed_10m = [], shortwave_radiation = [];
  for (let i = 0; i < n; i++) {
    const h = i % 24;
    time.push(`2026-07-0${1 + Math.floor(i / 24)}T${String(h).padStart(2, '0')}:00`);
    const raining = i >= 24 && i < 36;
    precipitation.push(raining ? 2 : 0);
    temperature_2m.push(raining ? 12 : 20);
    relative_humidity_2m.push(raining ? 96 : 55);
    wind_speed_10m.push(10);
    shortwave_radiation.push(h >= 7 && h <= 19 && !raining ? 600 : 0);
  }
  return { time, precipitation, temperature_2m, relative_humidity_2m, wind_speed_10m, shortwave_radiation, nowIndex: 40 };
}

const openFast = { name: 'A', sun: 'sunny_most_of_day', dries_fast: true, drying_notes: [] };
const shadedSlow = { name: 'B', sun: 'shady_most_of_day', dries_fast: false, drying_notes: [] };

test('vpd is higher for hot dry air', () => {
  assert.ok(vpdKpa(30, 30) > vpdKpa(12, 96));
});

test('rain fills the bucket, cap respected', () => {
  const r = computeWetness(shadedSlow, scenario());
  const peak = Math.max(...r.series);
  assert.ok(peak > 5, `peak ${peak}`);
  assert.ok(peak <= MODEL.bucketCapMm + 1e-9);
});

test('sunny dries-fast area dries before shaded forest area', () => {
  const s = scenario();
  const a = computeWetness(openFast, s);
  const b = computeWetness(shadedSlow, s);
  assert.ok(a.dryAt, 'open area should dry within window');
  assert.ok(!b.dryAt || new Date(a.dryAt) < new Date(b.dryAt),
    `open ${a.dryAt} vs shaded ${b.dryAt}`);
});

test('no drying while raining', () => {
  const s = scenario();
  const r = computeWetness(shadedSlow, s);
  for (let i = 25; i < 36; i++) assert.ok(r.series[i] >= r.series[i - 1] - 1e-9);
});

test('seepage triggers on >1in 3-day rain for seepage-prone areas only', () => {
  const s = scenario(); // 24mm total < 25.4 → no trigger
  const heavy = scenario();
  for (let i = 24; i < 36; i++) heavy.precipitation[i] = 3; // 36mm → trigger
  const prone = { ...shadedSlow, drying_notes: ['seepage can be a problem'], seepage_prone: true };
  assert.strictEqual(seepageState(prone, s).active, false);
  assert.strictEqual(seepageState(prone, heavy).active, true);
  assert.strictEqual(seepageState({ ...shadedSlow, seepage_prone: false }, heavy).active, false);
});

test('confidence compares model precip agreement', () => {
  const a = Array(168).fill(0); a[10] = 5;
  const same = [...a];
  const diff = Array(168).fill(0); diff[100] = 5; // wet on a different day
  assert.strictEqual(confidence(a, same), 'HIGH');
  assert.strictEqual(confidence(a, diff), 'LOW');
});

test('mm to inches', () => {
  assert.strictEqual(mmToIn(25.4), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Desktop/dryspell && node --test tests/model.test.js`
Expected: FAIL — cannot find module '../lib/model'

- [ ] **Step 3: Write implementation**

```js
// lib/model.js
// All coefficients are initial physics-informed estimates — tune in v2 with feedback data.
const MODEL = {
  bucketCapMm: 15,          // surface holds ~15mm; beyond that runs off
  dryThresholdMm: 0.05,
  canopyCatch: {            // fraction of rain reaching the boulder
    sunny_most_of_day: 1.0, variable: 1.0,
    morning_sun: 0.9, afternoon_sun: 0.9,
    tree_filtered_sun_am: 0.85, tree_filtered_sun_pm: 0.85,
    shady_most_of_day: 0.85,
  },
  weights: { radiation: 0.6, wind: 0.25, vpd: 0.15 },
  radiationNormWm2: 700,
  windNormKmh: 20,
  vpdNormKpa: 1.2,
  maxDryMmPerHour: 1.2,     // drain rate at full drying energy, before multipliers
  driesFastMult: 1.4,
  humidityCutoffPct: 92,    // above this, evaporation ~stops
  // sun_gate: multiplier on drying energy by local hour
  sunGate: {
    morning_sun:          h => (h >= 8 && h < 13) ? 1.0 : 0.3,
    afternoon_sun:        h => (h >= 12 && h < 19) ? 1.0 : 0.3,
    tree_filtered_sun_am: h => (h >= 8 && h < 13) ? 0.5 : 0.25,
    tree_filtered_sun_pm: h => (h >= 12 && h < 19) ? 0.5 : 0.25,
    sunny_most_of_day:    () => 1.0,
    shady_most_of_day:    () => 0.35,
    variable:             () => 0.7,
  },
  seepage: { trigger3dayMm: 25.4, baseDays: 2, daysPerInch: 1, capDays: 14 },
};

function vpdKpa(tempC, rhPct) {
  const es = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  return es * (1 - rhPct / 100);
}

const clamp01 = v => Math.max(0, Math.min(1, v));
const localHour = iso => Number(iso.slice(11, 13)); // API returns local time (timezone param)

function computeWetness(area, hours) {
  const { time, precipitation, temperature_2m, relative_humidity_2m,
          wind_speed_10m, shortwave_radiation, nowIndex } = hours;
  const catchF = MODEL.canopyCatch[area.sun] ?? 1.0;
  const gate = MODEL.sunGate[area.sun] ?? MODEL.sunGate.variable;
  const k = area.dries_fast ? MODEL.driesFastMult : 1.0;
  const series = [];
  let w = 0;
  for (let i = 0; i < time.length; i++) {
    const rain = precipitation[i] ?? 0;
    w = Math.min(MODEL.bucketCapMm, w + rain * catchF);
    const raining = rain > 0.1;
    const humid = (relative_humidity_2m[i] ?? 100) > MODEL.humidityCutoffPct;
    if (!raining && !humid && w > 0) {
      const energy =
        MODEL.weights.radiation * clamp01((shortwave_radiation[i] ?? 0) / MODEL.radiationNormWm2) +
        MODEL.weights.wind * clamp01((wind_speed_10m[i] ?? 0) / MODEL.windNormKmh) +
        MODEL.weights.vpd * clamp01(vpdKpa(temperature_2m[i] ?? 10, relative_humidity_2m[i] ?? 80) / MODEL.vpdNormKpa);
      w = Math.max(0, w - MODEL.maxDryMmPerHour * k * gate(localHour(time[i])) * energy);
    }
    series.push(Number(w.toFixed(3)));
  }
  let dryAt = null;
  for (let i = nowIndex; i < series.length; i++) {
    if (series[i] <= MODEL.dryThresholdMm) { dryAt = time[i]; break; }
  }
  return { series, dryAt, currentMm: series[nowIndex] ?? 0 };
}

function seepageState(area, hours) {
  if (!area.seepage_prone) return { active: false, until: null };
  const { time, precipitation, nowIndex } = hours;
  const S = MODEL.seepage;
  let active = false, until = null;
  // find any 72h window ending at/before now with rain > trigger
  for (let end = nowIndex; end >= 0; end--) {
    let sum = 0;
    for (let i = Math.max(0, end - 71); i <= end; i++) sum += precipitation[i] ?? 0;
    if (sum > S.trigger3dayMm) {
      const days = Math.min(S.capDays, S.baseDays + S.daysPerInch * (sum / 25.4));
      const untilMs = new Date(time[end]).getTime() + days * 86400e3;
      if (untilMs > new Date(time[nowIndex]).getTime()) {
        active = true;
        until = new Date(untilMs).toISOString();
      }
      break;
    }
  }
  return { active, until };
}

function confidence(precipA, precipB) {
  const day = arr => {
    const d = [];
    for (let i = 0; i < arr.length; i += 24)
      d.push(arr.slice(i, i + 24).reduce((s, v) => s + (v ?? 0), 0));
    return d;
  };
  const a = day(precipA), b = day(precipB);
  const WET = 1; // mm/day
  let wetDisagree = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if ((a[i] > WET) !== (b[i] > WET)) wetDisagree++;
  }
  const ta = a.reduce((s, v) => s + v, 0), tb = b.reduce((s, v) => s + v, 0);
  const totalAgree = Math.abs(ta - tb) <= Math.max(2, 0.2 * Math.max(ta, tb));
  if (wetDisagree === 0 && totalAgree) return 'HIGH';
  if (wetDisagree >= 2) return 'LOW';
  return 'MEDIUM';
}

const mmToIn = mm => Math.round((mm / 25.4) * 100) / 100;

module.exports = { MODEL, vpdKpa, computeWetness, seepageState, confidence, mmToIn };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Desktop/dryspell && node --test tests/model.test.js`
Expected: PASS (7 tests). If "sunny dries before shaded" fails, the coefficients are wrong — fix the model, not the test.

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/dryspell && git add lib/model.js tests/model.test.js && git commit -m "feat: wetness-bucket drying model with seepage and confidence"
```

---

### Task 3: Weather fetcher with cache + disk fallback

**Files:**
- Create: `~/Desktop/dryspell/lib/weather.js`
- Create: `~/Desktop/dryspell/tests/weather.test.js`

**Interfaces:**
- Consumes: `uniqueCells(areas)` from Task 1.
- Produces: `getWeather(cells, { fetchImpl })` → `Promise<Map<cellKey, CellWeather>>` where `CellWeather = { time: string[], precipitation: number[], temperature_2m: number[], relative_humidity_2m: number[], wind_speed_10m: number[], shortwave_radiation: number[], precipitation_ecmwf: number[], nowIndex: number }`. Batches ALL cells in ONE Open-Meteo request (comma-separated lat/lon). 15-min memory cache; writes `data/cache/last-good.json` on success and falls back to it on fetch failure. `fetchImpl` defaults to global `fetch` (injectable for tests).

- [ ] **Step 1: Write the failing test**

```js
// tests/weather.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { getWeather, _reset } = require('../lib/weather');

function fakeResponse(nCells) {
  const hourly = () => {
    const n = 14 * 24;
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 86400e3);
    start.setMinutes(0, 0, 0);
    const time = Array.from({ length: n }, (_, i) =>
      new Date(start.getTime() + i * 3600e3).toISOString().slice(0, 16));
    const zeros = Array(n).fill(0);
    return {
      time,
      precipitation_gem_seamless: zeros.map((_, i) => (i % 50 === 0 ? 1 : 0)),
      temperature_2m_gem_seamless: Array(n).fill(15),
      relative_humidity_2m_gem_seamless: Array(n).fill(60),
      wind_speed_10m_gem_seamless: Array(n).fill(8),
      shortwave_radiation_gem_seamless: Array(n).fill(300),
      precipitation_ecmwf_ifs025: zeros,
    };
  };
  return Array.from({ length: nCells }, () => ({ hourly: hourly() }));
}

test('batches cells into one call and maps results', async () => {
  _reset();
  let calls = 0;
  const cells = [{ key: 'a', lat: 49.68, lon: -123.16 }, { key: 'b', lat: 49.70, lon: -123.14 }];
  const fetchImpl = async (url) => {
    calls++;
    assert.match(url, /latitude=49\.68,49\.7/);
    return { ok: true, json: async () => fakeResponse(2) };
  };
  const map = await getWeather(cells, { fetchImpl });
  assert.strictEqual(calls, 1);
  assert.ok(map.get('a').time.length >= 300);
  assert.ok(typeof map.get('a').nowIndex === 'number');
  assert.ok(map.get('a').precipitation.some(v => v > 0));
});

test('memory cache prevents refetch, disk fallback survives failure', async () => {
  _reset();
  let calls = 0;
  const cells = [{ key: 'a', lat: 49.68, lon: -123.16 }];
  const ok = async () => { calls++; return { ok: true, json: async () => fakeResponse(1) }; };
  await getWeather(cells, { fetchImpl: ok });
  await getWeather(cells, { fetchImpl: ok });
  assert.strictEqual(calls, 1); // cached
  _reset({ keepDisk: true });   // clear memory, keep last-good.json
  const boom = async () => { throw new Error('api down'); };
  const map = await getWeather(cells, { fetchImpl: boom });
  assert.ok(map.get('a').time.length >= 300, 'served from disk fallback');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Desktop/dryspell && node --test tests/weather.test.js`
Expected: FAIL — cannot find module '../lib/weather'

- [ ] **Step 3: Write implementation**

```js
// lib/weather.js
const fs = require('node:fs');
const path = require('node:path');

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const LAST_GOOD = path.join(CACHE_DIR, 'last-good.json');
const VARS = ['precipitation', 'temperature_2m', 'relative_humidity_2m',
              'wind_speed_10m', 'shortwave_radiation'];

let memory = null; // { ts, map: plain object cellKey -> CellWeather }

function buildUrl(cells) {
  const lat = cells.map(c => c.lat).join(',');
  const lon = cells.map(c => c.lon).join(',');
  return 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=${VARS.join(',')}` +
    '&models=gem_seamless,ecmwf_ifs025' +
    '&past_days=7&forecast_days=7&timezone=America%2FVancouver';
}

function normalize(loc) {
  const h = loc.hourly;
  const pick = (v) => h[`${v}_gem_seamless`] ?? h[v];
  const out = { time: h.time };
  for (const v of VARS) out[v] = pick(v) ?? [];
  out.precipitation_ecmwf = h.precipitation_ecmwf_ifs025 ?? h.precipitation_ecmwf ?? [];
  const now = Date.now();
  let nowIndex = 0, best = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const d = Math.abs(new Date(h.time[i]).getTime() - now);
    if (d < best) { best = d; nowIndex = i; }
  }
  out.nowIndex = nowIndex;
  return out;
}

async function getWeather(cells, { fetchImpl = fetch } = {}) {
  if (memory && Date.now() - memory.ts < CACHE_TTL_MS) {
    return new Map(Object.entries(memory.map));
  }
  try {
    const res = await fetchImpl(buildUrl(cells));
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const body = await res.json();
    const locs = Array.isArray(body) ? body : [body];
    const map = {};
    cells.forEach((c, i) => { map[c.key] = normalize(locs[i]); });
    memory = { ts: Date.now(), map };
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(LAST_GOOD, JSON.stringify({ ts: Date.now(), map }));
    return new Map(Object.entries(map));
  } catch (err) {
    if (memory) return new Map(Object.entries(memory.map)); // stale memory beats nothing
    if (fs.existsSync(LAST_GOOD)) {
      const disk = JSON.parse(fs.readFileSync(LAST_GOOD, 'utf8'));
      return new Map(Object.entries(disk.map));
    }
    throw err;
  }
}

function _reset({ keepDisk = false } = {}) {
  memory = null;
  if (!keepDisk && fs.existsSync(LAST_GOOD)) fs.rmSync(LAST_GOOD);
}

module.exports = { getWeather, _reset, buildUrl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Desktop/dryspell && node --test tests/weather.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/dryspell && git add lib/weather.js tests/weather.test.js .gitignore && git commit -m "feat: batched Open-Meteo fetcher with cache and disk fallback"
```

---

### Task 4: Conditions endpoint + server

**Files:**
- Create: `~/Desktop/dryspell/lib/conditions.js`
- Create: `~/Desktop/dryspell/server.js`
- Create: `~/Desktop/dryspell/tests/conditions.test.js`

**Interfaces:**
- Consumes: Tasks 1–3 (`loadAreas`, `uniqueCells`, `getWeather`, `computeWetness`, `seepageState`, `confidence`, `mmToIn`).
- Produces: `buildConditions({ fetchImpl })` → `Promise<Payload>`:

```
Payload = {
  generatedAt: string, timezone: 'America/Vancouver',
  chapters: [{ name, areas: [AreaConditions] }],   // guidebook south-to-north order
  bestBets: { today: string[], weekend: string[] } // top 5 area names each
}
AreaConditions = {
  name, chapter, problems, sun, dries_fast, climbable_in_rain,
  approach, hike_min, hike_min_max, drying_notes,
  verdict: { status: 'dry'|'drying'|'wet', label: string, dryAt: string|null },
  seepage: { active, until }, confidence: 'HIGH'|'MEDIUM'|'LOW',
  currentIn: number, series: number[], seriesInches: number[], times: string[], nowIndex: number,
  dailyRainIn: [{ date: string, inches: number, mm: number }]  // 14 entries
}
```

- Verdict labels: dry now → `"DRY NOW"`; dries within window → `"Dry <Weekday> ~<h AM/PM>"` (e.g. `"Dry Sat ~1 PM"`, today → `"Dry today ~4 PM"`); never dries in window → `"WET"`. Weekday/hour formatted in America/Vancouver.
- `server.js`: `GET /` + static files from `public/`, `GET /api/conditions` → JSON of `buildConditions()`. Port: `process.env.PORT || 4328`; host `process.env.PORT ? '0.0.0.0' : '127.0.0.1'`.

- [ ] **Step 1: Write the failing test**

```js
// tests/conditions.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildConditions, verdictLabel } = require('../lib/conditions');
const { _reset } = require('../lib/weather');

function fakeFetch(rainy) {
  return async () => ({
    ok: true,
    json: async () => {
      const n = 14 * 24;
      const start = new Date(Date.now() - 7 * 86400e3);
      start.setMinutes(0, 0, 0);
      const time = Array.from({ length: n }, (_, i) =>
        new Date(start.getTime() + i * 3600e3).toISOString().slice(0, 16));
      const hourly = {
        time,
        precipitation_gem_seamless: time.map((_, i) => (rainy && i < 160 ? 1.5 : 0)),
        temperature_2m_gem_seamless: Array(n).fill(18),
        relative_humidity_2m_gem_seamless: Array(n).fill(55),
        wind_speed_10m_gem_seamless: Array(n).fill(10),
        shortwave_radiation_gem_seamless: time.map(t => {
          const h = Number(t.slice(11, 13));
          return h >= 7 && h <= 19 ? 500 : 0;
        }),
        precipitation_ecmwf_ifs025: time.map((_, i) => (rainy && i < 160 ? 1.4 : 0)),
      };
      // one hourly block per unique cell — return plenty
      return Array.from({ length: 30 }, () => ({ hourly: JSON.parse(JSON.stringify(hourly)) }));
    },
  });
}

test('dry week yields DRY NOW everywhere, chapters ordered, bestBets filled', async () => {
  _reset();
  const p = await buildConditions({ fetchImpl: fakeFetch(false) });
  assert.strictEqual(p.chapters[0].name, 'Murrin Park'); // southernmost
  const all = p.chapters.flatMap(c => c.areas);
  assert.strictEqual(all.length, 73);
  assert.ok(all.every(a => a.verdict.status === 'dry'));
  assert.strictEqual(p.bestBets.today.length, 5);
  assert.ok(all[0].dailyRainIn.length >= 13);
});

test('recent rain yields wet/drying with dry-time labels', async () => {
  _reset();
  const p = await buildConditions({ fetchImpl: fakeFetch(true) });
  const all = p.chapters.flatMap(c => c.areas);
  assert.ok(all.some(a => a.verdict.status !== 'dry'));
  const drying = all.find(a => a.verdict.status === 'drying');
  if (drying) assert.match(drying.verdict.label, /^Dry (today|[A-Z][a-z]{2}) ~\d{1,2} (AM|PM)$/);
});

test('verdictLabel formats Vancouver-local weekday and hour', () => {
  assert.match(verdictLabel('2026-07-18T13:00'), /^Dry (today|Sat) ~1 PM$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Desktop/dryspell && node --test tests/conditions.test.js`
Expected: FAIL — cannot find module '../lib/conditions'

- [ ] **Step 3: Write implementation**

```js
// lib/conditions.js
const { loadAreas, uniqueCells } = require('./areas');
const { getWeather } = require('./weather');
const { MODEL, computeWetness, seepageState, confidence, mmToIn } = require('./model');

const CHAPTER_ORDER = ['Murrin Park', 'Shannon Falls', 'The Grand Wall', 'Apron Boulders',
  'The North Walls', 'Crumpit Woods', 'Smoke Bluffs', 'Garibaldi', 'Powerline Boulders',
  'Cat Lake', 'Paradise Valley', 'Other Areas'];

function verdictLabel(dryAtIso) {
  const d = new Date(dryAtIso + (dryAtIso.length === 16 ? ':00' : ''));
  const fmt = new Intl.DateTimeFormat('en-US',
    { weekday: 'short', hour: 'numeric', timeZone: 'America/Vancouver' });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  const today = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Vancouver' })
    .format(new Date());
  const day = parts.weekday === today ? 'today' : parts.weekday;
  return `Dry ${day} ~${parts.hour} ${parts.dayPeriod}`;
}

function dailyRain(times, precip) {
  const days = new Map();
  times.forEach((t, i) => {
    const date = t.slice(0, 10);
    days.set(date, (days.get(date) ?? 0) + (precip[i] ?? 0));
  });
  return [...days.entries()].map(([date, mm]) =>
    ({ date, mm: Math.round(mm * 10) / 10, inches: mmToIn(mm) }));
}

async function buildConditions({ fetchImpl } = {}) {
  const areas = loadAreas();
  const weather = await getWeather(uniqueCells(areas), { fetchImpl });
  const out = [];
  for (const area of areas) {
    const w = weather.get(area.cell);
    const { series, dryAt, currentMm } = computeWetness(area, w);
    const seep = seepageState(area, w);
    const conf = confidence(
      w.precipitation.slice(w.nowIndex), w.precipitation_ecmwf.slice(w.nowIndex));
    let verdict;
    if (currentMm <= MODEL.dryThresholdMm) verdict = { status: 'dry', label: 'DRY NOW', dryAt: null };
    else if (dryAt) verdict = { status: 'drying', label: verdictLabel(dryAt), dryAt };
    else verdict = { status: 'wet', label: 'WET', dryAt: null };
    out.push({
      name: area.name, chapter: area.chapter, problems: area.problems, sun: area.sun,
      dries_fast: area.dries_fast, climbable_in_rain: area.climbable_in_rain,
      approach: area.approach, hike_min: area.hike_min, hike_min_max: area.hike_min_max,
      drying_notes: area.drying_notes,
      verdict, seepage: seep, confidence: conf,
      currentIn: mmToIn(currentMm),
      series, seriesInches: series.map(mmToIn),
      times: w.time, nowIndex: w.nowIndex,
      dailyRainIn: dailyRain(w.time, w.precipitation),
    });
  }
  const chapters = CHAPTER_ORDER
    .map(name => ({ name, areas: out.filter(a => a.chapter === name) }))
    .filter(c => c.areas.length);
  // best bets: dry (or driest) + most problems, penalize seepage
  const score = a => (a.verdict.status === 'dry' ? 1000 : a.verdict.status === 'drying' ? 500 : 0)
    - a.currentIn * 100 - (a.seepage.active ? 200 : 0) + Math.min(a.problems, 200) / 10;
  const ranked = [...out].sort((x, y) => score(y) - score(x));
  return {
    generatedAt: new Date().toISOString(),
    timezone: 'America/Vancouver',
    chapters,
    bestBets: { today: ranked.slice(0, 5).map(a => a.name),
                weekend: ranked.slice(0, 5).map(a => a.name) },
  };
}

module.exports = { buildConditions, verdictLabel };
```

Note: v1 `bestBets.weekend` mirrors today's ranking; a true weekend projection (bucket state at Sat 9 AM) is a small follow-up inside this task if time allows — otherwise ship as-is and label the strip "Best bets".

```js
// server.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildConditions } = require('./lib/conditions');

const PORT = process.env.PORT || 4328;
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/conditions') {
      const payload = await buildConditions({});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }
    let file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
  }
});

server.listen(PORT, HOST, () => console.log(`DRYSPELL on http://${HOST}:${PORT}`));
```

- [ ] **Step 4: Run all tests**

Run: `cd ~/Desktop/dryspell && node --test tests/`
Expected: PASS (12 tests across 4 files)

- [ ] **Step 5: Live-fire smoke test against the real API**

```bash
cd ~/Desktop/dryspell && node server.js & sleep 2 && curl -s http://127.0.0.1:4328/api/conditions | python3 -c "
import json,sys; p=json.load(sys.stdin)
areas=[a for c in p['chapters'] for a in c['areas']]
print(len(areas),'areas |', areas[0]['name'], areas[0]['verdict'], '| conf', areas[0]['confidence'])
print('daily rain (in):', [d['inches'] for d in areas[0]['dailyRainIn']])
" && lsof -tiTCP:4328 -sTCP:LISTEN | xargs kill
```

Expected: 73 areas, plausible verdicts for real current Squamish weather (July = likely lots of DRY NOW). Sanity-check the past-week rain inches against https://weather.gc.ca/past_conditions/index_e.html?station=wsk before calling this done.

- [ ] **Step 6: Commit**

```bash
cd ~/Desktop/dryspell && git add lib/conditions.js server.js tests/conditions.test.js && git commit -m "feat: conditions API with verdicts, best bets, and server"
```

---

### Task 5: Frontend

**Files:**
- Create: `~/Desktop/dryspell/public/index.html`
- Create: `~/Desktop/dryspell/public/style.css`
- Create: `~/Desktop/dryspell/public/app.js`

**Interfaces:**
- Consumes: `GET /api/conditions` payload from Task 4.
- Produces: the dashboard. Design work happens live in the browser — REQUIRED SUB-SKILLS at execution: `frontend-design` + `dataviz` (charts), verified per `leslie-app-standards` (real pointer events in real Chrome via claude-in-chrome, core flow re-verified after each feature).

Structure (baseline to build from, then design-iterate):

```html
<!-- public/index.html -->
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DRYSPELL — Squamish Dryness</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="masthead">
    <h1>DRYSPELL</h1>
    <p class="tagline">Squamish granite, hour by hour</p>
    <div class="meta" id="meta"></div>
  </header>
  <section class="best-bets" id="bestBets"></section>
  <main id="chapters"></main>
  <dialog id="detail"></dialog>
  <script src="/app.js"></script>
</body>
</html>
```

Card and detail requirements (content, not final visuals):
- Verdict pill: `dry` green / `drying` amber with the "Dry Sat ~1 PM" label / `wet` slate. Seepage-active adds a "SEEPAGE" warning chip; `climbable_in_rain` adds "RAINPROOF" chip; `dries_fast` adds "DRIES FAST".
- Sparkline: 14-day wetness series (SVG path; past = 40% opacity left of `nowIndex`, forecast = solid; rain bars under the line from `dailyRainIn`). Inches labels.
- Guidebook facts on card: sun aspect (icon or short text like "pm sun, filtered"), hike time ("12 min uphill"), problem count.
- Detail dialog on card tap: bigger chart, hourly next-48h strip, daily rain table (inches primary, mm small), drying notes verbatim, confidence badge with one-line explanation.
- `app.js` fetches `/api/conditions` once on load, renders all, no framework. Show `generatedAt` freshness in header. Handle fetch failure with a visible retry, not a blank page.
- Base font-size 17–18px; dark theme; phone-first (single column < 700px, card grid above).

- [ ] **Step 1: Build baseline** — write the three files rendering real API data end-to-end (cards, pills, sparklines, dialog)
- [ ] **Step 2: Verify basics with real pointer events** — claude-in-chrome against `http://127.0.0.1:4328`: page loads, cards render, tap card opens detail, close returns. Screenshot.
- [ ] **Step 3: Design pass** — frontend-design + dataviz + impeccable iteration until it clears the TWEAK bar (composition, spacing, distinctive dark-outdoors identity — not token tweaks). Screenshot desktop + 390px mobile.
- [ ] **Step 4: Re-verify core flow after design pass** — real clicks again (design passes break hit targets; house rule).
- [ ] **Step 5: Commit**

```bash
cd ~/Desktop/dryspell && git add public/ && git commit -m "feat: dryness dashboard frontend"
```

---

### Task 6: Registry + ship-check

**Files:**
- Modify: `~/.claude/skills/leslie-app-standards/SKILL.md` (port table)
- Create: `~/Desktop/dryspell/README.md`

- [ ] **Step 1: Add port registry row** — `| 4328 | DRYSPELL | ~/Desktop/dryspell/ | node server.js |` in the table, same session as creation (house rule).
- [ ] **Step 2: README** — what it is, how to run (`node server.js` → `http://127.0.0.1:4328`), model overview + pointer to `MODEL` coefficients, data provenance (guidebook-derived dataset, personal use), Render deploy notes (repo → Render web service, PORT env only).
- [ ] **Step 3: Full ship-check per leslie-app-standards** — server restarted by port; core flow re-verified with real pointer events; no live data files (v1 persists nothing); body ≥17px; no emoji headers; report what was actually observed.
- [ ] **Step 4: Commit**

```bash
cd ~/Desktop/dryspell && git add README.md && git commit -m "docs: readme with run and deploy notes"
```

Render deploy (Task 7, on Leslie's go-ahead after local use): create GitHub repo `leslita-sys/dryspell`, push, new Render web service (start command `node server.js`), verify the Render URL renders identically. Not started until she says the local app checks out.

---

## Self-Review

- Spec coverage: data sources (T3), bucket model + seepage + confidence (T2), stateless replay (T2+T3), API + verdicts + best bets (T4), frontend + visuals bar (T5), local→Render path (T6/7), verification plan (T4 step 5, T5 steps 2/4, T6 step 3). Gap: "weekend" best-bets projection simplified in v1 — noted inline in T4.
- Placeholders: none — all code complete.
- Type consistency: `CellWeather` field names match between weather.js (produces) and model.js/conditions.js (consume); `verdict.status` enum consistent across T4/T5.
