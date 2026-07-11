const fs = require('node:fs');
const path = require('node:path');
const { parseVancouver } = require('./time');

const CACHE_TTL_MS = 15 * 60 * 1000;
// Injectable so tests never touch the real cache (house rule: never overwrite live data)
const cacheDir = () => process.env.DRYSPELL_CACHE_DIR || path.join(__dirname, '..', 'data', 'cache');
const lastGoodPath = () => path.join(cacheDir(), 'last-good.json');
const VARS = ['precipitation', 'temperature_2m', 'relative_humidity_2m',
              'wind_speed_10m', 'shortwave_radiation', 'cloud_cover'];

let memory = null; // { ts, map: plain object cellKey -> CellWeather }

function buildUrl(cells) {
  const lat = cells.map(c => c.lat).join(',');
  const lon = cells.map(c => c.lon).join(',');
  return 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=${VARS.join(',')}` +
    '&models=gem_seamless,ecmwf_ifs025,icon_seamless' +
    '&current=precipitation,rain' +
    '&past_days=7&forecast_days=8&timezone=America%2FVancouver';
}

function normalize(loc) {
  const h = loc.hourly;
  const pick = (v) => h[`${v}_gem_seamless`] ?? h[v];
  const out = { time: h.time };
  for (const v of VARS) out[v] = pick(v) ?? [];
  out.precipitation_ecmwf = h.precipitation_ecmwf_ifs025 ?? h.precipitation_ecmwf ?? [];
  out.precipitation_icon = h.precipitation_icon_seamless ?? h.precipitation_icon ?? [];
  // current.precipitation is a 15-MINUTE accumulation (current.interval = 900),
  // used as a live is-it-raining gauge and a conservative floor at the now-hour
  const cur = loc.current ?? {};
  out.currentPrecip = cur.precipitation ?? cur.rain ?? null;
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

// Render's shared egress IPs get 429s from Open-Meteo's per-IP limits;
// retry with backoff so one good pull lands, then the 15-min cache carries it.
const RETRY_BASE_MS = Number(process.env.DRYSPELL_RETRY_BASE_MS ?? 1500);

async function fetchWithRetry(url, fetchImpl, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return res;
      lastErr = new Error(`open-meteo ${res.status}`);
      if (res.status !== 429 && res.status < 500) break; // real 4xx: don't hammer
    } catch (e) { lastErr = e; }
    if (i < tries - 1) await new Promise(r => setTimeout(r, RETRY_BASE_MS * (i + 1) ** 2));
  }
  throw lastErr;
}

let lastFailTs = 0;
const FAIL_COOLDOWN_MS = 55e3; // after a failed pull, serve fallback instantly;
                               // only the 60s warm loop re-runs the retry ladder

function fromFallback(err) {
  if (memory) return toResult(memory.map, memory.ts, 'stale');
  if (fs.existsSync(lastGoodPath())) {
    const disk = JSON.parse(fs.readFileSync(lastGoodPath(), 'utf8'));
    return toResult(disk.map, disk.ts ?? 0, 'disk');
  }
  // committed seed snapshot: stale beats an error page, and the UI banners
  // old data honestly while the boot warm-loop keeps retrying the API
  const seed = path.join(__dirname, '..', 'data', 'seed-weather.json');
  if (fs.existsSync(seed)) {
    const disk = JSON.parse(fs.readFileSync(seed, 'utf8'));
    return toResult(disk.map, disk.ts ?? 0, 'disk');
  }
  throw err;
}

async function getWeather(cells, { fetchImpl = fetch } = {}) {
  if (memory && Date.now() - memory.ts < CACHE_TTL_MS) {
    return toResult(memory.map, memory.ts, 'memory');
  }
  if (Date.now() - lastFailTs < FAIL_COOLDOWN_MS) {
    return fromFallback(new Error('weather feed unavailable (cooldown)'));
  }
  try {
    const res = await fetchWithRetry(buildUrl(cells), fetchImpl);
    const body = await res.json();
    const locs = Array.isArray(body) ? body : [body];
    const map = {};
    cells.forEach((c, i) => { map[c.key] = normalize(locs[i]); });
    const ts = Date.now();
    memory = { ts, map };
    lastFailTs = 0;
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(lastGoodPath(), JSON.stringify({ ts, map }));
    return toResult(map, ts, 'live');
  } catch (err) {
    lastFailTs = Date.now();
    return fromFallback(err);
  }
}

// accept a cache pushed from a machine whose IP isn't rate-limited (Leslie's Mac)
function acceptPushedCache(data) {
  if (!data || typeof data.ts !== 'number' || !data.map || typeof data.map !== 'object') return false;
  if (data.ts <= (memory?.ts ?? 0)) return false;                 // older than what we have
  if (data.ts > Date.now() + 5 * 60e3) return false;              // from the future
  const cells = Object.values(data.map);
  if (cells.length < 5) return false;
  const ok = cells.every(c => Array.isArray(c?.time) && c.time.length >= 200 &&
    Array.isArray(c?.precipitation) && c.precipitation.length === c.time.length);
  if (!ok) return false;
  memory = { ts: data.ts, map: data.map };
  lastFailTs = 0;
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(lastGoodPath(), JSON.stringify({ ts: data.ts, map: data.map }));
  return true;
}

function _reset({ keepDisk = false } = {}) {
  memory = null;
  lastFailTs = 0;
  if (!keepDisk && fs.existsSync(lastGoodPath())) fs.rmSync(lastGoodPath());
}

module.exports = { getWeather, _reset, buildUrl, acceptPushedCache };
