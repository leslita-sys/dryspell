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
