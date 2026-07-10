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
  HIGH: 'Canadian HRDPS and European ECMWF models agree on the week ahead.',
  MEDIUM: 'Forecast models mostly agree; timing of rain may shift.',
  LOW: 'HRDPS and ECMWF disagree on incoming rain — trust the next 24h, doubt the rest.',
};

let DATA = null;

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

function sparkSvg(a, { w = 600, h = 120, big = false } = {}) {
  const s = a.series;
  const n = s.length;
  if (!n) return '';
  const maxW = Math.max(2, ...s);           // mm scale, floor keeps flat lines low
  const rain = dailyRainBars(a, w, h);
  const x = i => (i / (n - 1)) * w;
  const y = v => h - 4 - (v / maxW) * (h - 18);
  const nowX = x(a.nowIndex);

  let past = '', future = '';
  for (let i = 0; i < n; i++) {
    const pt = `${x(i).toFixed(1)},${y(s[i]).toFixed(1)}`;
    if (i <= a.nowIndex) past += (past ? ' L' : 'M') + pt;
    if (i >= a.nowIndex) future += (future ? ' L' : 'M') + pt;
  }
  const base = y(0).toFixed(1);
  const futureArea = `${future} L${w},${base} L${nowX.toFixed(1)},${base} Z`;

  return `
  <svg class="${big ? 'big-chart' : 'spark'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
       aria-label="Wetness, past week and forecast">
    ${rain}
    <line x1="0" y1="${base}" x2="${w}" y2="${base}" stroke="var(--grid)" stroke-width="1"/>
    <line x1="${nowX.toFixed(1)}" y1="6" x2="${nowX.toFixed(1)}" y2="${base}" stroke="var(--ink-mut)" stroke-width="1" stroke-dasharray="2 3"/>
    <path d="${futureArea}" fill="var(--rain)" opacity="0.10"/>
    <path d="${past}" fill="none" stroke="var(--rain-soft)" stroke-width="2" opacity="0.38"/>
    <path d="${future}" fill="none" stroke="var(--rain-soft)" stroke-width="2"/>
  </svg>`;
}

function dailyRainBars(a, w, h) {
  // hourly precip drawn as slim bottom bars, 24h buckets are too coarse for timing
  const p = [];
  const n = a.series.length;
  const maxRainMm = 5; // full-height bar at 5mm/h — heavy rain
  for (let i = 0; i < n; i++) {
    const mm = rainAt(a, i);
    if (mm <= 0.05) continue;
    const bh = Math.min(1, mm / maxRainMm) * (h * 0.42);
    const x = (i / (n - 1)) * w;
    p.push(`<rect x="${(x - 1).toFixed(1)}" y="${(h - 4 - bh).toFixed(1)}" width="2" height="${bh.toFixed(1)}" fill="var(--rain)" opacity="0.55"/>`);
  }
  return p.join('');
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
  <button class="card" data-area="${encodeURIComponent(a.name)}" type="button">
    <div class="card-top">
      <h3>${a.name}</h3>
      <span class="pill ${a.verdict.status}">${a.verdict.label}</span>
    </div>
    <div class="facts">${facts}</div>
    <div class="chips">${chipHtml(a)}</div>
    ${sparkSvg(a)}
    <div class="spark-cap"><span>7 days back</span><span>${wetIn > 0 ? wetIn + '″ on the rock' : ''}</span><span>7 days out</span></div>
  </button>`;
}

function render() {
  const meta = document.getElementById('meta');
  const t = new Date(DATA.generatedAt).toLocaleString('en-US',
    { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver' });
  const all = DATA.chapters.flatMap(c => c.areas);
  const dryCount = all.filter(a => a.verdict.status === 'dry').length;
  meta.textContent = `${dryCount} of ${all.length} areas dry · updated ${t} Squamish time`;

  const bets = document.getElementById('bestBets');
  const track = document.getElementById('betsTrack');
  track.innerHTML = DATA.bestBets.today.map((name, i) =>
    `<button class="bet" data-area="${encodeURIComponent(name)}" type="button">
       <span class="rank">${i + 1}</span><span class="bname">${name}</span>
     </button>`).join('');
  bets.hidden = false;

  document.getElementById('chapters').innerHTML = DATA.chapters.map(c => `
    <section class="chapter">
      <div class="chapter-head">
        <h2>${c.name}</h2>
        <span class="count">${c.areas.length} areas</span>
      </div>
      <div class="grid">${c.areas.map(cardHtml).join('')}</div>
    </section>`).join('');

  document.querySelectorAll('[data-area]').forEach(el =>
    el.addEventListener('click', () => openDetail(decodeURIComponent(el.dataset.area))));
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
      <div class="axis-cap"><span>7 days ago</span><span>now</span><span>+7 days</span></div>
      ${seep}${notes}
      <table class="rain-table">
        <thead><tr><th>Day</th><th>Rain (in)</th><th>(mm)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  dlg.querySelector('.close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.showModal();
}

document.getElementById('retry').addEventListener('click', load);
load();
