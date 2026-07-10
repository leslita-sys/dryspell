const fs = require('node:fs');
const path = require('node:path');
const { parseVancouver } = require('./time');

const CACHE_TTL_MS = 15 * 60 * 1000;
// Injectable so tests never touch the real cache (house rule: never overwrite live data)
const cacheDir = () => process.env.DRYSPELL_CACHE_DIR || path.join(__dirname, '..', 'data', 'cache');
const lastGoodPath = () => path.join(cacheDir(), 'last-good.json');
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
    '&past_days=7&forecast_days=8&timezone=America%2FVancouver';
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
    const d = Math.abs(parseVancouver(h.time[i]).getTime() - now);
    if (d < best) { best = d; nowIndex = i; }
  }
  out.nowIndex = nowIndex;
  return out;
}

function toResult(map, fetchedAt, source) {
  const result = new Map(Object.entries(map));
  result.meta = { fetchedAt, source }; // source: 'live' | 'memory' | 'stale' | 'disk'
  return result;
}

async function getWeather(cells, { fetchImpl = fetch } = {}) {
  if (memory && Date.now() - memory.ts < CACHE_TTL_MS) {
    return toResult(memory.map, memory.ts, 'memory');
  }
  try {
    const res = await fetchImpl(buildUrl(cells));
    if (!res.ok) throw new Error(`open-meteo ${res.status}`);
    const body = await res.json();
    const locs = Array.isArray(body) ? body : [body];
    const map = {};
    cells.forEach((c, i) => { map[c.key] = normalize(locs[i]); });
    const ts = Date.now();
    memory = { ts, map };
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(lastGoodPath(), JSON.stringify({ ts, map }));
    return toResult(map, ts, 'live');
  } catch (err) {
    if (memory) return toResult(memory.map, memory.ts, 'stale');
    if (fs.existsSync(lastGoodPath())) {
      const disk = JSON.parse(fs.readFileSync(lastGoodPath(), 'utf8'));
      return toResult(disk.map, disk.ts ?? 0, 'disk');
    }
    throw err;
  }
}

function _reset({ keepDisk = false } = {}) {
  memory = null;
  if (!keepDisk && fs.existsSync(lastGoodPath())) fs.rmSync(lastGoodPath());
}

module.exports = { getWeather, _reset, buildUrl };
