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
