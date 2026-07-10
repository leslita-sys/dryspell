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
  HIGH: 'Canadian GEM and European ECMWF models agree on the week ahead.',
  MEDIUM: 'Forecast models mostly agree; timing of rain may shift.',
  LOW: 'GEM and ECMWF disagree on incoming rain — trust the next 24h, doubt the rest.',
};

let DATA = null;
let VIEW = 'week';      // 'week' = 14-day window, 'today' = now .. +24h
let GRADE = 'all';      // timeline filter: 'all' | 'V0-2' | 'V3-6' | 'V7-9' | 'V10+'
let PROBLEMS = null;    // lazy-loaded index of all 3,569 problem names

async function load() {
  const fail = document.getElementById('fail');
  fail.hidden = true;
  document.getElementById('meta').textContent = 'Reading the sky…';
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

function hikeLabel(a) {
  if (!a.hike_min) return null;
  const range = a.hike_min_max ? `${a.hike_min}–${a.hike_min_max}` : `${a.hike_min}`;
  const walk = a.approach ? a.approach.replace(/_/g, ' ') : '';
  return `${range} min ${walk}`.trim();
}

/* ---------- sparkline (single wetness series + rain bars) ---------- */

function viewWindow(a) {
  if (VIEW === 'today') {
    // window starts AT now so the left edge and the "now" captions agree
    return [a.nowIndex, Math.min(a.series.length, a.nowIndex + 25)];
  }
  return [0, a.series.length];
}

function sparkSvg(a, { w = 600, h = 120, big = false } = {}) {
  const [s0, s1] = viewWindow(a);
  const s = a.series.slice(s0, s1);
  const n = s.length;
  if (!n) return '';
  const nowI = a.nowIndex - s0;
  const maxW = Math.max(2, ...s);           // mm scale, floor keeps flat lines low
  const rain = dailyRainBars(a, w, h, s0, s1);
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

function dailyRainBars(a, w, h, s0 = 0, s1 = a.series.length) {
  // hourly precip drawn as slim bottom bars, 24h buckets are too coarse for timing
  const p = [];
  const n = s1 - s0;
  const maxRainMm = 5; // full-height bar at 5mm/h — heavy rain
  const bw = VIEW === 'today' ? 6 : 2;
  for (let i = 0; i < n; i++) {
    const mm = rainAt(a, i + s0);
    if (mm <= 0.05) continue;
    const bh = Math.min(1, mm / maxRainMm) * (h * 0.42);
    const x = (i / Math.max(1, n - 1)) * w;
    p.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${(h - 4 - bh).toFixed(1)}" width="${bw}" height="${bh.toFixed(1)}" fill="var(--rain)" opacity="0.55"/>`);
  }
  return p.join('');
}

function sparkCaps(a) {
  const wetIn = a.seriesInches[a.nowIndex];
  const mid = wetIn > 0 ? `${wetIn}&Prime; on the rock` : '';
  return VIEW === 'today'
    ? `<span>now</span><span>${mid}</span><span>+24 h</span>`
    : `<span>7 days back</span><span>${mid}</span><span>7 days out</span>`;
}

function rainAt(a, i) {
  return a.precipHourly ? (a.precipHourly[i] ?? 0) : 0;
}

/* ---------- cards ---------- */

function chipHtml(a) {
  const chips = [];
  if (a.seepage.active) chips.push('<span class="chip seep">Seepage</span>');
  if (a.climbable_in_rain) chips.push('<span class="chip rainproof">Rainproof</span>');
  if (a.dries_fast) chips.push('<span class="chip">Dries fast</span>');
  return chips.join('');
}

function cardHtml(a, idx) {
  const facts = [SUN_LABEL[a.sun], hikeLabel(a), `${a.problems} problems`]
    .filter(Boolean).map(f => `<span>${f}</span>`).join('');
  const wetIn = a.seriesInches[a.nowIndex];
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

function render() {
  const meta = document.getElementById('meta');
  const t = new Date(DATA.dataAt).toLocaleString('en-US',
    { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver' });
  const all = DATA.chapters.flatMap(c => c.areas);
  const dryCount = all.filter(a => a.verdict.status === 'dry').length;
  meta.textContent = `${dryCount} of ${all.length} areas dry · weather from ${t} Squamish time` +
    (DATA.dataStale ? ' · FEED DOWN, SHOWING LAST GOOD DATA' : '');
  document.getElementById('tldr').textContent = DATA.tldr;

  const bets = document.getElementById('bestBets');
  const track = document.getElementById('betsTrack');
  track.innerHTML = DATA.bestBets.today.map((b, i) =>
    `<button class="bet" data-area="${encodeURIComponent(b.name)}" type="button">
       <span class="rank">${i + 1}</span><span class="bname">${b.name}</span><span class="bwhen">${b.label}</span>
     </button>`).join('');
  bets.hidden = false;

  document.getElementById('navLinks').innerHTML = DATA.chapters.map(c =>
    `<a href="#ch-${slug(c.name)}" data-nav="${slug(c.name)}">${c.name}</a>`).join('');
  document.getElementById('quicknav').hidden = false;
  document.getElementById('viewToggle').textContent = VIEW === 'week' ? 'View: Week' : 'View: Today';

  document.getElementById('chapters').innerHTML = DATA.chapters.map(c => `
    <details class="chapter" id="ch-${slug(c.name)}" open>
      <summary class="chapter-head">
        <h2>${c.name}</h2>
        <span class="count">${c.areas.length} areas</span>
      </summary>
      <div class="grid">${c.areas.map(cardHtml).join('')}</div>
    </details>`).join('');

  renderTimeline();
  renderMap();

  document.querySelectorAll('[data-area]').forEach(el =>
    el.addEventListener('click', () => openDetail(decodeURIComponent(el.dataset.area))));
  document.querySelectorAll('[data-nav]').forEach(el =>
    el.addEventListener('click', e => {
      e.preventDefault();
      jumpToChapter(el.dataset.nav);
    }));
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

/* ---------- corridor map (SVG, no tiles, no dependencies) ---------- */

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/* ---------- dry timeline: every area by hours-until-dry vs wetness now ---------- */

const STATUS_COLOR = { dry: 'var(--dry)', drying: 'var(--drying)', wet: 'var(--wet)' };

// zone status: green = everything dry, yellow = will be dry (something dries), red = wet
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

function bandCount(a, bandKey) {
  if (bandKey === 'all') return a.problems;
  return a.grade_bands?.[bandKey] ?? 0;
}

function renderTimeline() {
  const W = 1000, H = 540, P = { l: 64, r: 40, t: 34, b: 44 };
  const MAXH = 24;
  const laneW = 110;                      // right-hand "not today" lane
  const plotR = W - P.r - laneW;

  const all = DATA.chapters.flatMap(c => c.areas)
    .filter(a => bandCount(a, GRADE) > 0);

  const items = all.map(a => {
    const hrs = dryHours(a);
    return { a, hrs: hrs <= MAXH ? hrs : null };       // null -> later lane
  });

  const wetMax = Math.max(0.05, ...all.map(a => a.currentIn));
  const x = it => it.hrs === null
    ? plotR + laneW / 2
    : P.l + (it.hrs / MAXH) * (plotR - P.l);
  const y = it => H - P.b - (it.a.currentIn / wetMax) * (H - P.t - P.b);

  // spiral collision relief so piled dots stay individually clickable
  const placed = [];
  const pos = it => {
    let px = x(it), py = y(it);
    for (let k = 0; k < 80; k++) {
      const hit = placed.some(p => (p[0] - px) ** 2 + (p[1] - py) ** 2 < 15 ** 2);
      if (!hit) break;
      const ang = k * 2.4, rad = 9 + k * 2.1;
      px = Math.min(W - 12, Math.max(14, x(it) + rad * Math.cos(ang)));
      py = Math.min(H - P.b - 8, Math.max(P.t + 8, y(it) + rad * Math.sin(ang)));
    }
    placed.push([px, py]);
    return [px, py];
  };

  const ticks = [];
  const ref = DATA.chapters[0].areas[0];
  for (let k = 0; k <= MAXH; k += 6) {
    const tx = P.l + (k / MAXH) * (plotR - P.l);
    const t = ref.times[ref.nowIndex + k];
    const clock = t ? new Date(t.slice(0, 10) + 'T' + t.slice(11) + ':00')
      .toLocaleTimeString('en-US', { hour: 'numeric' }) : '';
    ticks.push(`<line x1="${tx}" y1="${P.t}" x2="${tx}" y2="${H - P.b}" stroke="rgba(0,0,0,0.12)"/>` +
      (k === MAXH ? '' : `<text x="${tx}" y="${H - P.b + 20}" text-anchor="middle">${k === 0 ? 'NOW' : `+${k}H`}</text>
      <text x="${tx}" y="${H - P.b + 34}" text-anchor="middle" class="tick-clock">${k === 0 ? '' : clock}</text>`));
  }

  const dots = items.map(it => {
    const [px, py] = pos(it);
    const color = STATUS_COLOR[it.a.verdict.status];
    const n = bandCount(it.a, GRADE);
    const gradeNote = GRADE === 'all' ? '' : ` · ${n} in ${GRADE}`;
    return `
    <g class="tl-dot" data-tl="${encodeURIComponent(it.a.name)}" tabindex="0" role="button"
       aria-label="${it.a.name}: ${it.a.verdict.label}">
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" fill="${color}" stroke="var(--paper)" stroke-width="2"/>
      <title>${it.a.name} · ${it.a.verdict.label}${gradeNote}${it.a.currentIn > 0 ? ` · ${it.a.currentIn}″ on rock` : ''}</title>
    </g>`;
  }).join('');

  document.getElementById('timelineWrap').innerHTML = `
  <svg viewBox="0 0 ${W} ${H}" class="timeline" role="img"
       aria-label="Areas plotted by hours until dry and current wetness">
    <line x1="${P.l}" y1="${H - P.b}" x2="${plotR}" y2="${H - P.b}" stroke="var(--ink)"/>
    <line x1="${plotR + 8}" y1="${P.t}" x2="${plotR + 8}" y2="${H - P.b}" stroke="rgba(0,0,0,0.25)" stroke-dasharray="3 4"/>
    ${ticks.join('')}
    <text x="${plotR + laneW / 2}" y="${H - P.b + 20}" text-anchor="middle">NOT TODAY</text>
    <text x="14" y="${P.t + 4}" class="axis-name">WETTER</text>
    <text x="14" y="${H - P.b - 6}" class="axis-name">DRIER</text>
    <g class="legend">
      <circle cx="${plotR - 310}" cy="${P.t - 14}" r="5" fill="var(--dry)"/><text x="${plotR - 300}" y="${P.t - 10}">DRY</text>
      <circle cx="${plotR - 230}" cy="${P.t - 14}" r="5" fill="var(--drying)"/><text x="${plotR - 220}" y="${P.t - 10}">WILL BE DRY</text>
      <circle cx="${plotR - 90}" cy="${P.t - 14}" r="5" fill="var(--wet)"/><text x="${plotR - 80}" y="${P.t - 10}">WET</text>
    </g>
    ${dots}
  </svg>`;
  document.getElementById('overviewSection').hidden = false;

  document.querySelectorAll('.tl-dot').forEach(el => {
    const go = () => openDetail(decodeURIComponent(el.dataset.tl));
    el.addEventListener('click', go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });

  const gradeRow = document.getElementById('gradeFilter');
  gradeRow.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.grade === GRADE));
}

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

  // Highway 99 spine: chapters south to north (payload is already in that order)
  const spine = chapters.map(c => `${x(c.lon).toFixed(1)},${y(c.lat).toFixed(1)}`).join(' L');

  // label placement with de-collision: same-side labels get pushed apart vertically
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
    const go = () => document.getElementById(`ch-${el.dataset.chapter}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.addEventListener('click', go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

/* ---------- detail dialog ---------- */

function openDetail(name) {
  const a = DATA.chapters.flatMap(c => c.areas).find(x => x.name === name);
  if (!a) return;
  const dlg = document.getElementById('detail');
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
      ${sparkSvg(a, { w: 640, h: 190, big: true })}
      <div class="axis-cap">${VIEW === 'today'
        ? '<span>now</span><span>+12 h</span><span>+24 h</span>'
        : '<span>7 days ago</span><span>now</span><span>+7 days</span>'}</div>
      ${seep}${notes}
      <table class="rain-table">
        <thead><tr><th>Day</th><th>Rain (in)</th><th>(mm)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  dlg.querySelector('.close').addEventListener('click', () => dlg.close());
  dlg.showModal();
}

/* ---------- search: areas + all 3,569 problem names ---------- */

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
    .map(p => ({ kind: 'PROBLEM', label: p.n, sub: `${p.a} · ${p.c}`, area: p.a }));
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

document.getElementById('viewToggle').addEventListener('click', () => {
  VIEW = VIEW === 'week' ? 'today' : 'week';
  render();
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
document.getElementById('refresh').addEventListener('click', load);
load();
