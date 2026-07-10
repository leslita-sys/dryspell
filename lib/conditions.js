const { loadAreas, uniqueCells } = require('./areas');
const { getWeather } = require('./weather');
const { parseVancouver } = require('./time');
const { MODEL, computeWetness, seepageState, confidence, mmToIn } = require('./model');

const CHAPTER_ORDER = ['Murrin Park', 'Shannon Falls', 'The Grand Wall', 'Apron Boulders',
  'The North Walls', 'Crumpit Woods', 'Smoke Bluffs', 'Garibaldi', 'Powerline Boulders',
  'Cat Lake', 'Paradise Valley', 'Other Areas'];

function verdictLabel(dryAtIso) {
  const d = parseVancouver(dryAtIso);
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
      lat: area.lat, lon: area.lon,
      dries_fast: area.dries_fast, climbable_in_rain: area.climbable_in_rain,
      approach: area.approach, hike_min: area.hike_min, hike_min_max: area.hike_min_max,
      drying_notes: area.drying_notes,
      verdict, seepage: seep, confidence: conf,
      currentIn: mmToIn(currentMm),
      series, seriesInches: series.map(mmToIn),
      precipHourly: w.precipitation.map(v => Math.round((v ?? 0) * 100) / 100),
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
  const meta = weather.meta ?? { fetchedAt: Date.now(), source: 'live' };
  return {
    generatedAt: new Date().toISOString(),
    dataAt: new Date(meta.fetchedAt).toISOString(),
    dataStale: meta.source === 'stale' || meta.source === 'disk',
    timezone: 'America/Vancouver',
    chapters,
    bestBets: { today: ranked.slice(0, 5).map(a => a.name) },
  };
}

module.exports = { buildConditions, verdictLabel };
