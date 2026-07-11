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
    // Conservative past: hours behind us take the average of the two WETTEST of
    // three models (GEM, ECMWF, ICON). A storm only one model caught never
    // disappears (GEM alone missed real rain on 2026-07-10), but a single
    // model's phantom storm gets halved instead of believed wholesale.
    // Forecast hours stay GEM; disagreement there is the confidence badge's job.
    const hasIcon = (w.precipitation_icon?.length ?? 0) > 0;
    const blended = w.precipitation.map((v, i) => {
      const g = v ?? 0;
      if (i > w.nowIndex) return g;
      const cands = [g, w.precipitation_ecmwf?.[i] ?? 0];
      if (hasIcon) cands.push(w.precipitation_icon[i] ?? 0);
      cands.sort((x, y) => y - x);
      return cands.length >= 3 ? (cands[0] + cands[1]) / 2 : cands[0];
    });
    if (w.currentPrecip != null && w.currentPrecip > (blended[w.nowIndex] ?? 0)) {
      blended[w.nowIndex] = w.currentPrecip; // live reading beats both models
    }
    const hours = { ...w, precipitation: blended };
    const { series, dryAt, currentMm } = computeWetness(area, hours);
    const seep = seepageState(area, hours);
    // pairwise agreement across all available models, averaged
    const futures = [w.precipitation, w.precipitation_ecmwf, hasIcon ? w.precipitation_icon : null]
      .filter(Boolean).map(p => p.slice(w.nowIndex));
    const score = { HIGH: 2, MEDIUM: 1, LOW: 0 };
    const pairScores = [];
    for (let x = 0; x < futures.length; x++) {
      for (let y = x + 1; y < futures.length; y++) {
        pairScores.push(score[confidence(futures[x], futures[y])]);
      }
    }
    const avg = pairScores.reduce((s, v) => s + v, 0) / pairScores.length;
    const conf = avg >= 1.67 ? 'HIGH' : avg <= 0.67 ? 'LOW' : 'MEDIUM';
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
    tldr: buildTldr(out, ranked),
    chapters,
    bestBets: { today: ranked.slice(0, 5).map(a => ({ name: a.name, chapter: a.chapter, label: a.verdict.label })) },
  };
}

function buildTldr(areas, ranked) {
  const lc = label => label.charAt(0).toLowerCase() + label.slice(1);
  const wetish = areas.filter(a => a.verdict.status !== 'dry');
  const dry = areas.filter(a => a.verdict.status === 'dry' && !a.rainingNow);
  const raining = areas.some(a => a.rainingNow);
  const rainproof = areas.filter(a => a.climbable_in_rain).map(a => a.name);
  // derive from the SAME ranking as best bets so the beta never names a
  // different area than the #1 bet when they tie on dry time
  const fastDryer = ranked.find(a =>
    a.verdict.status === 'drying' && a.dries_fast && a.verdict.dryAt);
  const soonest = ranked.find(a =>
    a.verdict.status === 'drying' && a.verdict.dryAt);

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
  if (!dry.length) {
    return soonest
      ? `Recent rain has everything wet or drying; earliest back online is ${soonest.name}, ${lc(soonest.verdict.label)}.`
      : `Recent rain has everything wet, and nothing is forecast to dry within the week.`;
  }
  // lead with WHAT is climbable: fully dry zones first, then standout dry areas
  const listJoin = arr => arr.length <= 1 ? arr.join('')
    : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
  const byChapter = new Map();
  for (const a of areas) {
    if (!byChapter.has(a.chapter)) byChapter.set(a.chapter, []);
    byChapter.get(a.chapter).push(a);
  }
  const fullDry = [...byChapter.entries()]
    .filter(([, as]) => as.every(a => a.verdict.status === 'dry'))
    .map(([c]) => c);
  const partialDry = dry.filter(a => !fullDry.includes(a.chapter))
    .sort((x, y) => y.problems - x.problems);
  const parts = [];
  if (fullDry.length) {
    parts.push(`everything at ${listJoin(fullDry.slice(0, 3))}` +
      (fullDry.length > 3 ? ` (+${fullDry.length - 3} more zones)` : ''));
  }
  if (partialDry.length) {
    parts.push(listJoin(partialDry.slice(0, fullDry.length ? 2 : 3).map(a => a.name)));
  }
  const stillDrying = [soonest, fastDryer]
    .filter((a, i, arr) => a && arr.findIndex(x => x && x.name === a.name) === i)
    .slice(0, 2)
    .map(a => `${a.name} (${lc(a.verdict.label)})`);
  const tail = stillDrying.length ? ` Still drying: ${listJoin(stillDrying)}.` : '';
  return `Dry right now: ${parts.join(', plus ')}.${tail}`;
}

module.exports = { buildConditions, verdictLabel };
