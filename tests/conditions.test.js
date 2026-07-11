const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
// Isolate the disk cache — tests must never touch data/cache/last-good.json
process.env.DRYSPELL_CACHE_DIR = path.join(os.tmpdir(), `dryspell-test-cond-${process.pid}`);
process.env.DRYSPELL_RETRY_BASE_MS = '1'; // keep retry backoff instant in tests
const { buildConditions, verdictLabel } = require('../lib/conditions');
const { _reset } = require('../lib/weather');

function fakeFetch(rainy, { ecmwfOnlyRain = false } = {}) {
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
        precipitation_gem_seamless: time.map((_, i) => (rainy && !ecmwfOnlyRain && i < 160 ? 1.5 : 0)),
        temperature_2m_gem_seamless: Array(n).fill(18),
        relative_humidity_2m_gem_seamless: Array(n).fill(55),
        wind_speed_10m_gem_seamless: Array(n).fill(10),
        shortwave_radiation_gem_seamless: time.map(t => {
          const h = Number(t.slice(11, 13));
          return h >= 7 && h <= 19 ? 500 : 0;
        }),
        precipitation_ecmwf_ifs025: time.map((_, i) => (rainy && i < 160 ? 1.4 : 0)),
        precipitation_icon_seamless: time.map((_, i) => (rainy && !ecmwfOnlyRain && i < 160 ? 1.3 : 0)),
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

test('todayForecast covers today with temp, humidity, wind, sun and rain', async () => {
  _reset();
  const p = await buildConditions({ fetchImpl: fakeFetch(false) });
  const f = p.todayForecast;
  assert.ok(f && Array.isArray(f.hours) && f.hours.length >= 1 && f.hours.length <= 24);
  assert.ok(f.hours.every(h => h.time.startsWith(f.date)));
  assert.ok(f.nowIndex >= 0 && f.nowIndex < f.hours.length);
  const h = f.hours[f.nowIndex];
  assert.strictEqual(h.tempC, 18);
  assert.strictEqual(h.humidity, 55);
  assert.strictEqual(h.windKmh, 10);
  assert.strictEqual(h.precipMm, 0);
});

test('todayForecast rain takes the wettest cell, blended like the areas', async () => {
  _reset();
  // only ECMWF saw rain in the past -> blended halves it to 0.7 mm/h
  const p = await buildConditions({ fetchImpl: fakeFetch(true, { ecmwfOnlyRain: true }) });
  const rainy = p.todayForecast.hours.filter(h => h.precipMm > 0);
  if (rainy.length) rainy.forEach(h => assert.ok(Math.abs(h.precipMm - 0.7) < 0.01,
    `expected halved lone-model rain, got ${h.precipMm}`));
});

test('verdictLabel formats Vancouver-local weekday and hour', () => {
  assert.match(verdictLabel('2026-07-18T13:00'), /^Dry (today|Sat) ~1 PM$/);
});

test('verdictLabel never calls a same-weekday date next week "today"', () => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver' });
  const nextWeek = fmt.format(new Date(Date.now() + 7 * 86400e3)); // YYYY-MM-DD
  const label = verdictLabel(`${nextWeek}T10:00`);
  assert.ok(!label.includes('today'), `same weekday next week labeled: ${label}`);
});

test('single-model past rain still wets the bucket, at half strength', async () => {
  _reset();
  const p = await buildConditions({ fetchImpl: fakeFetch(true, { ecmwfOnlyRain: true }) });
  const all = p.chapters.flatMap(c => c.areas);
  assert.ok(all.some(a => a.verdict.status !== 'dry'),
    'only ECMWF saw rain; a lone-model storm must never vanish entirely');
  // avg of two wettest of (0, 1.4, 0) = 0.7/h — half of ECMWF's claim
  const a = all[0];
  const rainyHour = a.precipHourly.findIndex(v => v > 0);
  assert.ok(rainyHour >= 0 && Math.abs(a.precipHourly[rainyHour] - 0.7) < 0.01,
    `phantom hour should be halved, got ${a.precipHourly[rainyHour]}`);
  assert.ok(typeof p.tldr === 'string' && p.tldr.length > 20, 'tldr present');
});
