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
  // compare full local DATES, not weekday names — a dry-time 7 days out shares the weekday
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Vancouver' });
  const day = dayFmt.format(d) === dayFmt.format(new Date()) ? 'today' : parts.weekday;
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
  // recompute "now" per cell: cached/disk-fallback data carries a stale nowIndex
  const nowMs = Date.now();
  const freshNow = new Map();
  for (const [key, w] of weather) {
    if (!w?.time?.length || !w.precipitation?.length) {
      throw new Error(`weather feed returned no hourly data for cell ${key}`);
    }
    let bi = 0, best = Infinity;
    for (let i = 0; i < w.time.length; i++) {
      const d = Math.abs(parseVancouver(w.time[i]).getTime() - nowMs);
      if (d < best) { best = d; bi = i; }
    }
    freshNow.set(key, bi);
  }
  const out = [];
  for (const area of areas) {
    const w = { ...weather.get(area.cell), nowIndex: freshNow.get(area.cell) };
    // Conservative past: if EITHER model says it rained on hours already behind us,
    // assume the rock got wet (GEM alone missed a real storm on 2026-07-10).
    // Forecast hours stay GEM; disagreement there is the confidence badge's job.
    const blended = w.precipitation.map((v, i) =>
      i <= w.nowIndex ? Math.max(v ?? 0, w.precipitation_ecmwf?.[i] ?? 0) : (v ?? 0));
    if (w.currentPrecip != null && w.currentPrecip > (blended[w.nowIndex] ?? 0)) {
      blended[w.nowIndex] = w.currentPrecip; // live reading beats both models
    }
    const hours = { ...w, precipitation: blended };
    const { series, dryAt, currentMm } = computeWetness(area, hours);
    const seep = seepageState(area, hours);
    const conf = confidence(
      w.precipitation.slice(w.nowIndex), w.precipitation_ecmwf.slice(w.nowIndex));
    let verdict;
    if (currentMm <= MODEL.dryThresholdMm) verdict = { status: 'dry', label: 'DRY NOW', dryAt: null };
    else if (dryAt) verdict = { status: 'drying', label: verdictLabel(dryAt), dryAt };
    else verdict = { status: 'wet', label: 'WET', dryAt: null };
    out.push({
      name: area.name, chapter: area.chapter, problems: area.problems, sun: area.sun,
      lat: area.lat, lon: area.lon, grade_bands: area.grade_bands,
      dries_fast: area.dries_fast, climbable_in_rain: area.climbable_in_rain,
      approach: area.approach, hike_min: area.hike_min, hike_min_max: area.hike_min_max,
      drying_notes: area.drying_notes,
      verdict, seepage: seep, confidence: conf,
      currentIn: mmToIn(currentMm),
      // "raining now" defers to the live gauge (15-min accumulation) when present:
      // a model forecasting rain in the now-hour must not claim rain over a dry gauge
      rainingNow: w.currentPrecip != null
        ? w.currentPrecip > 0.1
        : (blended[w.nowIndex] ?? 0) > 0.2,
      series, seriesInches: series.map(mmToIn),
      precipHourly: blended.map(v => Math.round(v * 100) / 100),
      times: w.time, nowIndex: w.nowIndex,
      dailyRainIn: dailyRain(w.time, blended),
    });
  }
  const chapters = CHAPTER_ORDER
    .map(name => ({ name, areas: out.filter(a => a.chapter === name) }))
    .filter(c => c.areas.length);
  // best bets: most dry first — status tier, then soonest dry time, then least
  // water on the rock; problem count is only the final tiebreak
  const tier = a => ({ dry: 0, drying: 1, wet: 2 }[a.verdict.status]) + (a.seepage.active ? 0.5 : 0);
  const dryEta = a => a.verdict.status === 'dry' ? 0
    : a.verdict.dryAt ? parseVancouver(a.verdict.dryAt).getTime() : Infinity;
  const ranked = [...out].sort((x, y) =>
    (tier(x) - tier(y)) || (dryEta(x) - dryEta(y)) ||
    (x.currentIn - y.currentIn) || (y.problems - x.problems));
  const meta = weather.meta ?? { fetchedAt: Date.now(), source: 'live' };
  return {
    generatedAt: new Date().toISOString(),
    dataAt: new Date(meta.fetchedAt).toISOString(),
    dataStale: meta.source === 'stale' || meta.source === 'disk',
    timezone: 'America/Vancouver',
    tldr: buildTldr(out),
    chapters,
    bestBets: { today: ranked.slice(0, 5).map(a => ({ name: a.name, label: a.verdict.label })) },
  };
}

function buildTldr(areas) {
  const lc = label => label.charAt(0).toLowerCase() + label.slice(1);
  const byDryAt = (a, b) => new Date(a.verdict.dryAt) - new Date(b.verdict.dryAt);
  const wetish = areas.filter(a => a.verdict.status !== 'dry');
  const dry = areas.filter(a => a.verdict.status === 'dry' && !a.rainingNow);
  const raining = areas.some(a => a.rainingNow);
  const rainproof = areas.filter(a => a.climbable_in_rain).map(a => a.name);
  const fastDryer = areas
    .filter(a => a.verdict.status === 'drying' && a.dries_fast && a.verdict.dryAt)
    .sort(byDryAt)[0];

  const soonest = areas
    .filter(a => a.verdict.status === 'drying' && a.verdict.dryAt)
    .sort(byDryAt)[0];

  if (raining) {
    const move = rainproof.length
      ? `your move is ${rainproof.join(' or ')} (climbable in light rain)`
      : 'nothing climbs well in the wet';
    const later = (fastDryer ?? soonest)
      ? `, then fast-drying spots like ${(fastDryer ?? soonest).name} come online ${lc((fastDryer ?? soonest).verdict.label)}`
      : '';
    return `Rain is falling right now: ${move}${later}.`;
  }
  if (!wetish.length) {
    return `No meaningful rain on the rock: all ${areas.length} areas read dry, so pick by sun and approach.`;
  }
  const topDry = dry.sort((a, b) => b.problems - a.problems).slice(0, 2).map(a => a.name);
  if (!topDry.length) {
    return soonest
      ? `Recent rain has everything wet or drying; earliest back online is ${soonest.name}, ${lc(soonest.verdict.label)}.`
      : `Recent rain has everything wet, and nothing is forecast to dry within the week.`;
  }
  const wait = fastDryer ? `, or give exposed fast-dryers like ${fastDryer.name} until ${lc(fastDryer.verdict.label).replace(/^dry /, '')}` : '';
  return `Recent rain left ${wetish.length} of ${areas.length} areas wet: best bets now are ${topDry.join(' and ')}${wait}.`;
}

module.exports = { buildConditions, verdictLabel };
