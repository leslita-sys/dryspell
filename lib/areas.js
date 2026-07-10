const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data', 'squamish_areas.json');
const GRADES = path.join(__dirname, '..', 'data', 'area_grades.json');
const CELL_DEG = 0.02; // ~2.2 km lat, ~1.4 km lon at 49.7N — matches HRDPS 2.5 km grid

function snap(v) { return (Math.round(v / CELL_DEG) * CELL_DEG).toFixed(2); }

function loadAreas() {
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const grades = fs.existsSync(GRADES) ? JSON.parse(fs.readFileSync(GRADES, 'utf8')) : {};
  return raw.map(a => ({
    grade_bands: grades[a.name] ?? {},
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
