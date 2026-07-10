#!/usr/bin/env node
// Fetch fresh Open-Meteo weather from THIS machine (whose IP isn't throttled)
// and push it to the Render deployment. Run by launchd every 15 minutes.
// Requires: DRYSPELL_PUSH_KEY (same value as the Render env var).
const { loadAreas, uniqueCells } = require('../lib/areas');
const { getWeather } = require('../lib/weather');

const TARGET = process.env.DRYSPELL_PUSH_URL || 'https://dryspell.onrender.com/api/push-cache';
const KEY = process.env.DRYSPELL_PUSH_KEY;

(async () => {
  if (!KEY) { console.error('DRYSPELL_PUSH_KEY not set'); process.exit(2); }
  const w = await getWeather(uniqueCells(loadAreas()));
  if (w.meta.source !== 'live') {
    console.error(`local fetch not live (${w.meta.source}), not pushing`);
    process.exit(1);
  }
  const map = Object.fromEntries(w.entries());
  const res = await fetch(TARGET, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ts: w.meta.fetchedAt, map }),
  });
  console.log(`${new Date().toISOString()} push -> ${res.status}`);
  process.exit(res.status === 204 ? 0 : 1);
})().catch(err => { console.error(err.message); process.exit(1); });
