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
  console.log(`unique cells: ${cells.length}`);
  assert.ok(cells.length >= 5 && cells.length <= 25, `got ${cells.length}`);
});
