// Open-Meteo returns timezone-naive local strings ("2026-07-10T13:00") because we
// request timezone=America/Vancouver. Parsing them with `new Date()` uses the HOST
// timezone — correct on a Vancouver/Pacific machine, 7-8h wrong on a UTC deploy
// (Render). Everything time-related must go through parseVancouver instead.
const TZ = 'America/Vancouver';

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function tzOffsetMs(atMs) {
  const parts = Object.fromEntries(dtf.formatToParts(new Date(atMs)).map(p => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    parts.hour === '24' ? 0 : +parts.hour, +parts.minute, +parts.second);
  return asUTC - atMs;
}

function parseVancouver(iso) {
  const [d, t] = iso.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [hh, mm] = (t ?? '00:00').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm); // pretend the local string is UTC…
  return new Date(guess - tzOffsetMs(guess));    // …then shift by Vancouver's offset at that moment
}

module.exports = { parseVancouver, TZ };
