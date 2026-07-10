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
