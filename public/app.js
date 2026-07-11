/* DRYSPELL frontend — renders /api/conditions */

const SUN_LABEL = {
  morning_sun: 'AM sun',
  afternoon_sun: 'PM sun',
  tree_filtered_sun_am: 'AM sun, filtered',
  tree_filtered_sun_pm: 'PM sun, filtered',
  sunny_most_of_day: 'Sunny all day',
  shady_most_of_day: 'Shady all day',
  variable: 'Mixed sun',
};

const CONF_NOTE = {
  HIGH: 'GEM, ECMWF and ICON forecast models agree on the week ahead.',
  MEDIUM: 'The three forecast models mostly agree; timing of rain may shift.',
  LOW: 'The forecast models disagree on incoming rain — trust the next 24h, doubt the rest.',
};

let DATA = null;
let TLTAB = 'area';     // timeline tab: 'area' | 'boulder' | 'climb'
let GRADE = 'all';      // boulder-tab filter: 'all' | 'V0-2' | 'V3-6' | 'V7-9' | 'V10+'
let PROBLEMS = null;    // lazy-loaded index of all problem names

async function load() {
  const fail = document.getElementById('fail');
  fail.hidden = true;
  document.getElementById('tldr').textContent = 'Reading the sky…';
  try {
    const res = await fetch('/api/conditions');
    if (!res.ok) throw new Error(`api ${res.status}`);
    DATA = await res.json();
    render();
  } catch (err) {
    console.error(err);
    document.getElementById('meta').textContent = '';
    fail.hidden = false;
  }
}

function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Vancouver',
  });
}

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const shortChapter = c => c.replace(/^The /, '').replace(' Boulders', '');

function hikeLabel(a) {
  if (!a.hike_min) return null;
  const range = a.hike_min_max ? `${a.hike_min}–${a.hike_min_max}` : `${a.hike_min}`;
  const walk = a.approach ? a.approach.replace(/_/g, ' ') : '';
  return `${range} min ${walk}`.trim();
}

/* ---------- sparkline (single wetness series + rain bars) ---------- */

function viewWindow(a, mode) {
  if (mode === 'today') {
    return [a.nowIndex, Math.min(a.series.length, a.nowIndex + 25)];
  }
  return [0, a.series.length];
}

function sparkSvg(a, { w = 600, h = 120, big = false, mode = 'week' } = {}) {
  const [s0, s1] = viewWindow(a, mode);
  const s = a.series.slice(s0, s1);
  const n = s.length;
  if (!n) return '';
  const nowI = a.nowIndex - s0;
  const maxW = Math.max(2, ...s);           // mm scale, floor keeps flat lines low
  const rain = rainBars(a, w, h, s0, s1, mode);
  const denom = Math.max(1, n - 1);
  const x = i => (i / denom) * w;
  const y = v => h - 4 - (v / maxW) * (h - 18);
  const nowX = x(nowI);

  let past = '', future = '';
  for (let i = 0; i < n; i++) {
    const pt = `${x(i).toFixed(1)},${y(s[i]).toFixed(1)}`;
    if (i <= nowI) past += (past ? ' L' : 'M') + pt;
    if (i >= nowI) future += (future ? ' L' : 'M') + pt;
  }
  const base = y(0).toFixed(1);
  const futureArea = `${future} L${w},${base} L${nowX.toFixed(1)},${base} Z`;

  return `
  <svg class="${big ? 'big-chart' : 'spark'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
       aria-label="Wetness, past week and forecast">
    ${rain}
    <line x1="0" y1="${base}" x2="${w}" y2="${base}" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>
    <line x1="${nowX.toFixed(1)}" y1="6" x2="${nowX.toFixed(1)}" y2="${base}" stroke="rgba(0,0,0,0.45)" stroke-width="1" stroke-dasharray="2 3"/>
    <path d="${futureArea}" fill="var(--rain)" opacity="0.10"/>
    <path d="${past}" fill="none" stroke="var(--rain)" stroke-width="2" opacity="0.35"/>
    <path d="${future}" fill="none" stroke="var(--rain)" stroke-width="2"/>
  </svg>`;
}

function rainBars(a, w, h, s0, s1, mode) {
  const p = [];
  const n = s1 - s0;
  const maxRainMm = 5; // full-height bar at 5mm/h — heavy rain
  const bw = mode === 'today' ? 6 : 2;
  for (let i = 0; i < n; i++) {
    const mm = a.precipHourly ? (a.precipHourly[i + s0] ?? 0) : 0;
    if (mm <= 0.05) continue;
    const bh = Math.min(1, mm / maxRainMm) * (h * 0.42);
    const x = (i / Math.max(1, n - 1)) * w;
    p.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${(h - 4 - bh).toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" fill="var(--rain)" opacity="0.55"/>`);
  }
  return p.join('');
}

function sparkCaps(a, mode = 'week') {
  const wetIn = a.seriesInches[a.nowIndex];
  const mid = wetIn > 0 ? `${wetIn}&Prime; on the rock` : '';
  return mode === 'today'
    ? `<span>now</span><span>${mid}</span><span>+24 h</span>`
    : `<span>7 days back</span><span>${mid}</span><span>7 days out</span>`;
}

/* ---------- cards ---------- */

function chipHtml(a) {
  const chips = [];
  if (a.seepage.active) chips.push('<span class="chip seep">Seepage</span>');
  if (a.climbable_in_rain) chips.push('<span class="chip rainproof">Rainproof</span>');
  if (a.dries_fast) chips.push('<span class="chip">Dries fast</span>');
  return chips.join('');
}

function cardHtml(a) {
  const facts = [SUN_LABEL[a.sun], hikeLabel(a), `${a.problems} problems`]
    .filter(Boolean).map(f => `<span>${f}</span>`).join('');
  return `
  <button class="card" id="area-${slug(a.name)}" data-area="${encodeURIComponent(a.name)}" type="button">
    <div class="card-text">
      <h3>${a.name}</h3>
      <div class="facts">${facts}</div>
      <div class="chips">${chipHtml(a)}</div>
    </div>
    <div class="card-viz">
      <span class="pill ${a.verdict.status}">${a.verdict.label}</span>
      ${sparkSvg(a)}
      <div class="spark-cap">${sparkCaps(a)}</div>
    </div>
  </button>`;
}

/* ---------- status helpers ---------- */

const STATUS_COLOR = { dry: 'var(--dry)', drying: 'var(--drying)', wet: 'var(--wet)' };

function chapterStatus(c) {
  if (c.areas.every(a => a.verdict.status === 'dry')) return 'dry';
  if (c.areas.some(a => a.verdict.status !== 'wet')) return 'drying';
  return 'wet';
}

function dryHours(a) {
  if (a.verdict.status === 'dry') return 0;
  if (!a.verdict.dryAt) return Infinity;
  const idx = a.times.indexOf(a.verdict.dryAt);
  return idx >= 0 ? Math.max(0, idx - a.nowIndex) : Infinity;
}

// day-aware short label for an offset in hours: "~4 PM" today, "Sat 9 AM" beyond
function shortWhen(a, offsetHours) {
  if (offsetHours <= 0) return 'now';
  const idx = Math.min(a.times.length - 1, a.nowIndex + Math.round(offsetHours));
  const t = a.times[idx];
  const d = new Date(t.slice(0, 10) + 'T' + t.slice(11) + ':00');
  const hour = d.toLocaleTimeString('en-US', { hour: 'numeric' });
  return t.slice(0, 10) === a.times[a.nowIndex].slice(0, 10)
    ? `~${hour}`
    : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hour}`;
}

// header line: honest earliest-to-latest range, never a fake average
function chapterHeadline(c) {
  const status = chapterStatus(c);
  if (status === 'dry') return 'Dry now';
  if (status === 'wet') return 'Wet';
  const hrs = c.areas.map(dryHours);
  const finite = hrs.filter(Number.isFinite);
  if (!finite.length) return 'Partly dry';
  const lo = Math.min(...finite), hi = Math.max(...finite);
  const someNever = hrs.some(h => !Number.isFinite(h));
  const a = c.areas[0];
  if (lo === hi && !someNever) return `Dry ${shortWhen(a, lo)}`;
  return `Dry ${shortWhen(a, lo)}–${someNever ? 'later' : shortWhen(a, hi)}`;
}

/* ---------- countdown to the first dry area ---------- */

let countdownTimer = null;

function tomorrowLine(all) {
  const ref = all[0];
  const today = ref.times[ref.nowIndex].slice(0, 10);
  const tomorrow = ref.times.map(t => t.slice(0, 10)).find(d => d > today);
  if (!tomorrow) return '';
  let dryAtNoon = 0;
  for (const a of all) {
    const i = a.times.findIndex(t => t.startsWith(tomorrow) && t.slice(11, 13) === '12');
    if (i >= 0 && a.series[i] <= 0.05) dryAtNoon++;
  }
  const rainMax = Math.max(...all.map(a =>
    a.dailyRainIn.find(d => d.date === tomorrow)?.inches ?? 0));
  const day = new Date(tomorrow + 'T12:00').toLocaleDateString('en-US', { weekday: 'long' });
  const rainBit = rainMax > 0.01 ? `up to ${rainMax}″ rain` : 'no rain forecast';
  return `Tomorrow (${day}): ${dryAtNoon} of ${all.length} areas dry by noon · ${rainBit}`;
}

function renderCountdown() {
  const el = document.getElementById('countdown');
  clearInterval(countdownTimer);
  const all = DATA.chapters.flatMap(c => c.areas);
  const digits = el.querySelector('.cd-digits');
  digits.classList.remove('cd-word', 'good', 'warn', 'bad');
  document.getElementById('tomorrowLine').textContent = tomorrowLine(all);

  const dryCount = all.filter(a => a.verdict.status === 'dry').length;
  const raining = all.some(a => a.rainingNow);
  if (dryCount > 0 || raining || !all.some(a => Number.isFinite(dryHours(a)) && dryHours(a) > 0)) {
    // nothing to count down to (or no point) — show the at-a-glance verdict instead
    const n = all.length;
    let word, cls;
    if (raining) { word = 'Raining'; cls = 'bad'; }
    else if (dryCount === n) { word = 'Dry'; cls = 'good'; }
    else if (dryCount >= (n * 2) / 3) { word = 'Mostly dry'; cls = 'good'; }
    else if (dryCount >= n / 3) { word = 'Mixed'; cls = 'warn'; }
    else if (dryCount > 0) { word = 'Mostly wet'; cls = 'warn'; }
    else { word = 'Wet'; cls = 'bad'; }
    el.querySelector('.cd-label').textContent = 'Conditions';
    digits.textContent = word;
    digits.classList.add('cd-word', cls);
    el.querySelector('.cd-who').textContent = `${dryCount} of ${n} areas dry`;
    el.hidden = false;
    return;
  }
  // same ranking as best bets, so the countdown names the same area as bet #1
  const byName = new Map(all.map(a => [a.name, a]));
  const drying = DATA.bestBets.today.map(b => byName.get(b.name))
    .find(a => a && Number.isFinite(dryHours(a)) && dryHours(a) > 0);
  if (!drying) { el.hidden = true; return; }
  // nowIndex is the NEAREST hour to now, so anchor by rounding, not flooring
  const anchor = Math.round(Date.now() / 3600e3) * 3600e3;
  const target = anchor + dryHours(drying) * 3600e3;
  const tick = () => {
    const ms = target - Date.now();
    if (ms <= 0) { el.querySelector('.cd-digits').textContent = 'NOW'; clearInterval(countdownTimer); return; }
    const h = Math.floor(ms / 3600e3), m = Math.floor(ms / 60e3) % 60, s = Math.floor(ms / 1e3) % 60;
    el.querySelector('.cd-digits').textContent =
      `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  el.querySelector('.cd-label').textContent = 'Countdown to dry rock';
  el.querySelector('.cd-who').textContent = `${drying.name} first, ${drying.verdict.label.toLowerCase()}`;
  el.hidden = false;
  tick();
  countdownTimer = setInterval(tick, 1000);
}

/* ---------- render ---------- */

function render() {
  const meta = document.getElementById('meta');
  const t = new Date(DATA.dataAt).toLocaleString('en-US',
    { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver' });
  const all = DATA.chapters.flatMap(c => c.areas);
  const dryCount = all.filter(a => a.verdict.status === 'dry').length;
  meta.innerHTML =
    `<span class="dry-count ${dryCount > 0 ? 'pos' : 'zero'}">${dryCount} of ${all.length} areas dry</span>` +
    ` · weather from ${t} Squamish time · updates every 15 minutes with each weather pull` +
    (DATA.dataStale ? ' · <span class="feed-down">FEED DOWN, SHOWING LAST GOOD DATA</span>' : '');
  document.getElementById('tldr').textContent = DATA.tldr;

  const bets = document.getElementById('bestBets');
  const track = document.getElementById('betsTrack');
  track.innerHTML = DATA.bestBets.today.map((b, i) =>
    `<button class="bet" data-area="${encodeURIComponent(b.name)}" type="button">
       <span class="rank">${i + 1}</span><span class="bname">${b.name}</span>
       <span class="bwhen">${shortChapter(b.chapter)} &middot; ${b.label}</span>
     </button>`).join('');
  bets.hidden = false;

  document.getElementById('chapters').innerHTML = DATA.chapters.map(c => `
    <details class="chapter" id="ch-${slug(c.name)}">
      <summary class="chapter-head">
        <h2>${c.name}</h2>
        <span class="ch-status ${chapterStatus(c)}">${chapterHeadline(c)}</span>
        <span class="count">${c.areas.length} areas</span>
      </summary>
      <div class="grid">${c.areas.map(cardHtml).join('')}</div>
    </details>`).join('');

  renderCountdown();
  renderTimeline();
  renderMap();

  document.querySelectorAll('[data-area]').forEach(el =>
    el.addEventListener('click', () => openDetail(decodeURIComponent(el.dataset.area))));
}

function jumpToChapter(chSlug) {
  const sec = document.getElementById(`ch-${chSlug}`);
  if (!sec) return;
  sec.open = true;
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function jumpToArea(areaName) {
  const row = document.getElementById(`area-${slug(areaName)}`);
  if (!row) return;
  const sec = row.closest('details');
  if (sec) sec.open = true;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 2000);
}

/* ---------- dry timeline: tabbed scatter (area / boulder / climb) ---------- */

const BANDS = ['V0-2', 'V3-6', 'V7-9', 'V10+'];
// the guidebook's own grade colors: green / blue / black / red
const BAND_COLOR = { 'V0-2': '#0ca30c', 'V3-6': '#2a78d6', 'V7-9': '#000000', 'V10+': '#d03b3b' };

function bandCount(a, bandKey) {
  if (bandKey === 'all') return a.problems;
  return a.grade_bands?.[bandKey] ?? 0;
}

function renderTimeline() {
  const W = 1000, H = 540, P = { l: 74, r: 40, t: 34, b: 44 };
  const MAXH = 24;
  const laneW = 110;                      // right-hand "not today" lane
  const plotR = W - P.r - laneW;
  const allAreas = DATA.chapters.flatMap(c => c.areas);

  const hrsOf = a => { const h = dryHours(a); return h <= MAXH ? h : null; };
  const xOf = hrs => hrs === null ? plotR + laneW / 2 : P.l + (hrs / MAXH) * (plotR - P.l);

  // build tab-specific dot descriptors: { hrs, yv, r, color, name, title, go }
  let items = [];
  if (TLTAB === 'area') {
    items = DATA.chapters.map(c => {
      const finite = c.areas.map(dryHours).filter(Number.isFinite);
      const lo = finite.length ? Math.min(...finite) : null;
      const rep = c.areas.reduce((m, a) => a.currentIn < m.currentIn ? a : m);
      return {
        hrs: lo !== null && lo <= MAXH ? lo : null,
        yv: rep.currentIn,
        r: 8, color: STATUS_COLOR[chapterStatus(c)],
        label: c.name,
        title: `${c.name} · ${chapterHeadline(c)}`,
        go: () => jumpToChapter(slug(c.name)),
      };
    });
  } else if (TLTAB === 'boulder') {
    items = allAreas.map(a => ({
      hrs: hrsOf(a),
      yv: a.currentIn,
      r: 6, color: STATUS_COLOR[a.verdict.status],
      title: `${a.name} · ${a.verdict.label}` +
        (a.currentIn > 0 ? ` · ${a.currentIn}″ on rock` : ''),
      go: () => openDetail(a.name),
    }));
  } else { // climb: same dry-to-wet axis, dots colored by guidebook grade band
    for (const a of allAreas) {
      for (const b of BANDS) {
        if (GRADE !== 'all' && b !== GRADE) continue;
        const n = bandCount(a, b);
        if (!n) continue;
        items.push({
          hrs: hrsOf(a),
          yv: a.currentIn,
          r: Math.min(12, 4 + Math.sqrt(n) * 1.0),
          color: BAND_COLOR[b],
          title: `${a.name} · ~${n} problems ${b} · ${a.verdict.label}` +
            (a.currentIn > 0 ? ` · ${a.currentIn}″ on rock` : ''),
          go: () => openDetail(a.name),
        });
      }
    }
  }

  const wetMax = Math.max(0.05, ...items.map(it => it.yv));
  const yOf = it => H - P.b - (it.yv / wetMax) * (H - P.t - P.b);

  // spiral collision relief so piled dots stay individually clickable;
  // clamp to the plot (or the not-today lane) so nothing bleeds past the axes
  const placed = [];
  const pos = it => {
    const inLane = it.hrs === null;
    const xmin = (inLane ? plotR + 18 : P.l + 2) + it.r;
    const xmax = (inLane ? W - 6 : plotR - 2) - it.r;
    const clampX = v => Math.min(xmax, Math.max(xmin, v));
    const clampY = v => Math.min(H - P.b - 2 - it.r, Math.max(P.t + 2 + it.r, v));
    let px = clampX(xOf(it.hrs)), py = clampY(yOf(it));
    for (let k = 0; k < 80; k++) {
      const rr = (it.r + 8);
      const hit = placed.some(p => (p[0] - px) ** 2 + (p[1] - py) ** 2 < rr ** 2);
      if (!hit) break;
      const ang = k * 2.4, rad = 9 + k * 2.1;
      px = clampX(xOf(it.hrs) + rad * Math.cos(ang));
      py = clampY(yOf(it) + rad * Math.sin(ang));
    }
    placed.push([px, py]);
    return [px, py];
  };

  const ticks = [];
  const ref = allAreas[0];
  for (let k = 0; k <= MAXH; k += 6) {
    const tx = P.l + (k / MAXH) * (plotR - P.l);
    const t = ref.times[ref.nowIndex + k];
    const clock = t ? new Date(t.slice(0, 10) + 'T' + t.slice(11) + ':00')
      .toLocaleTimeString('en-US', { hour: 'numeric' }) : '';
    ticks.push(`<line x1="${tx}" y1="${P.t}" x2="${tx}" y2="${H - P.b}" stroke="rgba(0,0,0,0.12)"/>` +
      (k === MAXH ? '' : `<text x="${tx}" y="${H - P.b + 20}" text-anchor="middle">${k === 0 ? 'NOW' : `+${k}H`}</text>
      <text x="${tx}" y="${H - P.b + 34}" text-anchor="middle" class="tick-clock">${k === 0 ? '' : clock}</text>`));
  }

  const yAxis = `<text x="14" y="${P.t + 4}" class="axis-name">WETTER</text>
       <text x="14" y="${H - P.b - 6}" class="axis-name">DRIER</text>`;

  // position all dots first, then de-collide the labels vertically (area tab)
  const withPos = items.map(it => {
    const [px, py] = pos(it);
    return { it, px, py, ly: py + 4 };
  });
  const labeled = withPos.filter(p => p.it.label).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labeled.length; i++) {
    if (labeled[i].ly - labeled[i - 1].ly < 16) labeled[i].ly = labeled[i - 1].ly + 16;
  }

  const dots = withPos.map(({ it, px, py, ly }, idx) => {
    const lbl = it.label ? (() => {
      const left = px > plotR - 120;
      return `<text x="${(left ? px - it.r - 6 : px + it.r + 6).toFixed(1)}" y="${ly.toFixed(1)}"
        text-anchor="${left ? 'end' : 'start'}" class="tl-label">${it.label}</text>`;
    })() : '';
    return `
    <g class="tl-dot" data-i="${idx}" tabindex="0" role="button" aria-label="${it.title}">
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${it.r}" fill="${it.color}" stroke="var(--paper)" stroke-width="2"/>
      ${lbl}
      <title>${it.title}</title>
    </g>`;
  }).join('');

  document.getElementById('timelineWrap').innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" class="timeline" role="img"
       aria-label="Dryness timeline, ${TLTAB} view">
    <line x1="${P.l}" y1="${H - P.b}" x2="${plotR}" y2="${H - P.b}" stroke="var(--ink)"/>
    <line x1="${plotR + 8}" y1="${P.t}" x2="${plotR + 8}" y2="${H - P.b}" stroke="rgba(0,0,0,0.25)" stroke-dasharray="3 4"/>
    ${ticks.join('')}
    <text x="${plotR + laneW / 2}" y="${H - P.b + 20}" text-anchor="middle">NOT TODAY</text>
    ${yAxis}
    <g class="legend">${TLTAB === 'climb'
      ? BANDS.map((b, i) => `<circle cx="${plotR - 340 + i * 85}" cy="${P.t - 14}" r="5" fill="${BAND_COLOR[b]}"/>
          <text x="${plotR - 330 + i * 85}" y="${P.t - 10}">${b}</text>`).join('')
      : `<circle cx="${plotR - 310}" cy="${P.t - 14}" r="5" fill="var(--dry)"/><text x="${plotR - 300}" y="${P.t - 10}">DRY</text>
         <circle cx="${plotR - 230}" cy="${P.t - 14}" r="5" fill="var(--drying)"/><text x="${plotR - 220}" y="${P.t - 10}">WILL BE DRY</text>
         <circle cx="${plotR - 90}" cy="${P.t - 14}" r="5" fill="var(--wet)"/><text x="${plotR - 80}" y="${P.t - 10}">WET</text>`}
    </g>
    ${dots}
  </svg>`;
  document.getElementById('overviewSection').hidden = false;

  document.querySelectorAll('.tl-dot').forEach(el => {
    const it = items[Number(el.dataset.i)];
    if (!it) return;
    el.addEventListener('click', it.go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); it.go(); } });
  });

  document.querySelectorAll('#chartTabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === TLTAB));
  document.getElementById('gradeFilter').hidden = TLTAB !== 'climb';
  document.getElementById('gradeFilter').querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.grade === GRADE));
}

/* ---------- corridor map (SVG, no tiles, no dependencies) ---------- */

function renderMap() {
  const W = 360, H = 620, PAD = 46;
  const chapters = DATA.chapters.map(c => {
    const lats = c.areas.map(a => a.lat), lons = c.areas.map(a => a.lon);
    return {
      name: c.name,
      lat: lats.reduce((s, v) => s + v, 0) / lats.length,
      lon: lons.reduce((s, v) => s + v, 0) / lons.length,
      problems: c.areas.reduce((s, a) => s + a.problems, 0),
      status: chapterStatus(c),
    };
  });
  const lats = chapters.map(c => c.lat), lons = chapters.map(c => c.lon);
  const minLat = Math.min(...lats) - 0.012, maxLat = Math.max(...lats) + 0.012;
  const minLon = Math.min(...lons) - 0.015, maxLon = Math.max(...lons) + 0.015;
  const x = lon => PAD + ((lon - minLon) / (maxLon - minLon)) * (W - 2 * PAD);
  const y = lat => PAD + ((maxLat - lat) / (maxLat - minLat)) * (H - 2 * PAD);

  const spine = chapters.map(c => `${x(c.lon).toFixed(1)},${y(c.lat).toFixed(1)}`).join(' L');

  const placed = chapters.map(c => {
    const cx = x(c.lon), cy = y(c.lat);
    return { ...c, cx, cy, left: cx > W * 0.55, ly: cy + 4 };
  });
  for (const side of [true, false]) {
    const lane = placed.filter(p => p.left === side).sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < lane.length; i++) {
      if (lane[i].ly - lane[i - 1].ly < 15) lane[i].ly = lane[i - 1].ly + 15;
    }
  }

  const dots = placed.map(c => {
    const r = Math.max(9, Math.min(20, 6 + Math.sqrt(c.problems) / 2.4));
    const color = STATUS_COLOR[c.status];
    return `
    <g class="map-dot" data-chapter="${slug(c.name)}" tabindex="0" role="button" aria-label="${c.name}">
      <circle cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="0.16"/>
      <circle cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="4.5" fill="${color}"/>
      <text x="${(c.left ? c.cx - r - 6 : c.cx + r + 6).toFixed(1)}" y="${c.ly.toFixed(1)}"
            text-anchor="${c.left ? 'end' : 'start'}">${c.name}</text>
    </g>`;
  }).join('');

  document.getElementById('mapWrap').innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" class="corridor" role="img" aria-label="Map of Squamish bouldering zones, colored by dryness">
    <path d="M${x(minLon + 0.004)},${H} L${x(minLon + 0.01)},${y(49.665).toFixed(0)} L${x(minLon)},${y(49.69).toFixed(0)} L0,${y(49.70).toFixed(0)} L0,${H} Z"
          fill="var(--rain)" opacity="0.12"/>
    <text x="10" y="${H - 14}" class="water-label">Howe Sound</text>
    <path d="M${spine}" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="2" stroke-dasharray="1 5" stroke-linecap="round"/>
    ${dots}
    <text x="${W - 10}" y="22" text-anchor="end" class="compass">N &uarr;</text>
  </svg>`;
  document.getElementById('overviewSection').hidden = false;

  document.querySelectorAll('.map-dot').forEach(el => {
    const go = () => jumpToChapter(el.dataset.chapter);
    el.addEventListener('click', go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

/* ---------- detail dialog ---------- */

const gradeNum = g => g === 'VB' ? -1 : g === 'VH' ? 99 : Number(g.replace(/[V+-]/g, ''));
const gradeBandOf = g => {
  const n = gradeNum(g);
  return n >= 10 ? 'V10+' : n >= 7 ? 'V7-9' : n >= 3 ? 'V3-6' : 'V0-2';
};

function climbsHtml(areaName) {
  const list = (PROBLEMS || []).filter(p => p.a === areaName);
  if (!list.length) return '';
  const sorted = [...list].sort((x, y) => {
    const gx = x.g ? gradeNum(x.g) : 100, gy = y.g ? gradeNum(y.g) : 100;
    return gx - gy || x.n.localeCompare(y.n);
  });
  const items = sorted.map(p => `
    <li>${p.g ? `<span class="gdot" style="background:${BAND_COLOR[gradeBandOf(p.g)]}"></span>` : '<span class="gdot gdot-unknown"></span>'}
      <span class="climb-name">${p.n}</span>${p.g ? `<span class="climb-grade">${p.g}</span>` : ''}
    </li>`).join('');
  return `
  <details class="climbs">
    <summary>Climbs (${list.length})</summary>
    <ul class="climb-list">${items}</ul>
  </details>`;
}

async function openDetail(name) {
  await ensureProblems();
  const a = DATA.chapters.flatMap(c => c.areas).find(x => x.name === name);
  if (!a) return;
  const dlg = document.getElementById('detail');
  let dlgView = 'week';
  const rows = a.dailyRainIn.map(d => {
    const today = d.date === new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
    const day = new Date(d.date + 'T12:00').toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Vancouver' });
    return `<tr class="${today ? 'today-row' : ''}"><td>${day}${today ? ' · today' : ''}</td><td>${d.inches.toFixed(2)}″</td><td>${d.mm} mm</td></tr>`;
  }).join('');
  const notes = (a.drying_notes || []).map(n =>
    `<p class="note"><span class="kicker">From the guidebook</span>“${n}”</p>`).join('');
  const seep = a.seepage.active
    ? `<p class="note"><span class="kicker">Seepage watch</span>Recent rain was heavy enough that cracks may weep until ~${fmtTime(a.seepage.until)}.</p>` : '';

  const chart = mode => `${sparkSvg(a, { w: 640, h: 190, big: true, mode })}
      <div class="axis-cap">${mode === 'today'
        ? '<span>now</span><span>+12 h</span><span>+24 h</span>'
        : '<span>7 days ago</span><span>now</span><span>+7 days</span>'}</div>`;

  dlg.innerHTML = `
    <div class="detail-body">
      <div class="detail-head">
        <div>
          <h3>${a.name}</h3>
          <p class="detail-sub">${a.chapter} · ${[SUN_LABEL[a.sun], hikeLabel(a), a.problems + ' problems'].filter(Boolean).join(' · ')}</p>
        </div>
        <button class="close" type="button">Close</button>
      </div>
      <div class="verdict-line">
        <span class="pill ${a.verdict.status}">${a.verdict.label}</span>
        ${chipHtml(a)}
        <span class="conf ${a.confidence}">Forecast confidence: ${a.confidence}</span>
      </div>
      <p class="conf-note">${CONF_NOTE[a.confidence]}</p>
      <div class="dlg-tabs" role="group" aria-label="Chart window">
        <button type="button" data-v="week" class="active">14 days</button>
        <button type="button" data-v="today">Next 24 h</button>
      </div>
      <div id="dlgChart">${chart('week')}</div>
      ${seep}${notes}
      <table class="rain-table">
        <thead><tr><th>Day</th><th>Rain (in)</th><th>(mm)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="table-note">Past days lean wet: shown rain averages the two wettest of three forecast models, so wet rock never gets called dry.</p>
      ${climbsHtml(a.name)}
    </div>`;
  dlg.querySelector('.close').addEventListener('click', () => dlg.close());
  dlg.querySelectorAll('.dlg-tabs button').forEach(b =>
    b.addEventListener('click', () => {
      dlgView = b.dataset.v;
      dlg.querySelector('#dlgChart').innerHTML = chart(dlgView);
      dlg.querySelectorAll('.dlg-tabs button').forEach(x =>
        x.classList.toggle('active', x.dataset.v === dlgView));
    }));
  dlg.showModal();
}

/* ---------- search: areas + all problem names ---------- */

async function ensureProblems() {
  if (PROBLEMS) return PROBLEMS;
  const res = await fetch('/api/problems');
  PROBLEMS = res.ok ? await res.json() : [];
  return PROBLEMS;
}

function runSearch(q) {
  const box = document.getElementById('searchResults');
  q = q.trim().toLowerCase();
  if (q.length < 2 || !DATA) { box.hidden = true; box.innerHTML = ''; return; }
  const areas = DATA.chapters.flatMap(c => c.areas)
    .filter(a => a.name.toLowerCase().includes(q))
    .slice(0, 6)
    .map(a => ({ kind: 'AREA', label: a.name, sub: a.chapter, area: a.name }));
  const probs = (PROBLEMS || [])
    .filter(p => p.n.toLowerCase().includes(q))
    .slice(0, 8)
    .map(p => ({ kind: 'PROBLEM', label: p.n + (p.g ? ` ${p.g}` : ''), sub: `${p.a} · ${p.c}`, area: p.a }));
  const results = [...areas, ...probs].slice(0, 12);
  if (!results.length) {
    box.innerHTML = '<div class="search-empty">No matches</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = results.map(r =>
    `<button type="button" class="search-hit" data-hit="${encodeURIComponent(r.area)}">
       <span class="hit-kind">${r.kind}</span><span class="hit-label">${r.label}</span><span class="hit-sub">${r.sub}</span>
     </button>`).join('');
  box.hidden = false;
  box.querySelectorAll('.search-hit').forEach(el =>
    el.addEventListener('click', () => {
      box.hidden = true;
      document.getElementById('search').value = '';
      jumpToArea(decodeURIComponent(el.dataset.hit));
    }));
}

const searchEl = document.getElementById('search');
let searchTimer = null;
searchEl.addEventListener('input', () => {
  ensureProblems();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(searchEl.value), 120);
});
searchEl.addEventListener('focus', () => ensureProblems());
document.addEventListener('click', e => {
  if (!e.target.closest('.searchbox')) document.getElementById('searchResults').hidden = true;
});

document.getElementById('chartTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  TLTAB = b.dataset.tab;
  renderTimeline();
});

document.getElementById('gradeFilter').addEventListener('click', e => {
  const b = e.target.closest('button[data-grade]');
  if (!b) return;
  GRADE = b.dataset.grade;
  renderTimeline();
});

const dlgEl = document.getElementById('detail');
dlgEl.addEventListener('click', e => { if (e.target === dlgEl) dlgEl.close(); });
document.getElementById('retry').addEventListener('click', load);
// server weather cache TTL is 15 min (lib/weather.js) — re-pull on the same cadence
setInterval(load, 15 * 60 * 1000);
load();
