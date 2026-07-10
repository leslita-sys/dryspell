const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
// Isolate the disk cache — tests must never touch data/cache/last-good.json
process.env.DRYSPELL_CACHE_DIR = path.join(os.tmpdir(), `dryspell-test-${process.pid}`);
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
