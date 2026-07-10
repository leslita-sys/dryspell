// All coefficients are initial physics-informed estimates — tune in v2 with feedback data.
const MODEL = {
  bucketCapMm: 15,          // surface holds ~15mm; beyond that runs off
  dryThresholdMm: 0.05,
  canopyCatch: {            // fraction of rain reaching the boulder
    sunny_most_of_day: 1.0, variable: 1.0,
    morning_sun: 0.9, afternoon_sun: 0.9,
    tree_filtered_sun_am: 0.85, tree_filtered_sun_pm: 0.85,
    shady_most_of_day: 0.85,
  },
  weights: { radiation: 0.6, wind: 0.25, vpd: 0.15 },
  radiationNormWm2: 700,
  windNormKmh: 20,
  vpdNormKpa: 1.2,
  maxDryMmPerHour: 1.2,     // drain rate at full drying energy, before multipliers
  driesFastMult: 1.4,
  humidityCutoffPct: 92,    // above this, evaporation ~stops
  // sun_gate: multiplier on drying energy by local hour
  sunGate: {
    morning_sun:          h => (h >= 8 && h < 13) ? 1.0 : 0.3,
    afternoon_sun:        h => (h >= 12 && h < 19) ? 1.0 : 0.3,
    tree_filtered_sun_am: h => (h >= 8 && h < 13) ? 0.5 : 0.25,
    tree_filtered_sun_pm: h => (h >= 12 && h < 19) ? 0.5 : 0.25,
    sunny_most_of_day:    () => 1.0,
    shady_most_of_day:    () => 0.35,
    variable:             () => 0.7,
  },
  seepage: { trigger3dayMm: 25.4, baseDays: 2, daysPerInch: 1, capDays: 14 },
};

function vpdKpa(tempC, rhPct) {
  const es = 0.6108 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  return es * (1 - rhPct / 100);
}

const clamp01 = v => Math.max(0, Math.min(1, v));
const localHour = iso => Number(iso.slice(11, 13)); // API returns local time (timezone param)

function computeWetness(area, hours) {
  const { time, precipitation, temperature_2m, relative_humidity_2m,
          wind_speed_10m, shortwave_radiation, nowIndex } = hours;
  const catchF = MODEL.canopyCatch[area.sun] ?? 1.0;
  const gate = MODEL.sunGate[area.sun] ?? MODEL.sunGate.variable;
  const k = area.dries_fast ? MODEL.driesFastMult : 1.0;
  const series = [];
  let w = 0;
  for (let i = 0; i < time.length; i++) {
    const rain = precipitation[i] ?? 0;
    w = Math.min(MODEL.bucketCapMm, w + rain * catchF);
    const raining = rain > 0.1;
    const humid = (relative_humidity_2m[i] ?? 100) > MODEL.humidityCutoffPct;
    if (!raining && !humid && w > 0) {
      const energy =
        MODEL.weights.radiation * clamp01((shortwave_radiation[i] ?? 0) / MODEL.radiationNormWm2) +
        MODEL.weights.wind * clamp01((wind_speed_10m[i] ?? 0) / MODEL.windNormKmh) +
        MODEL.weights.vpd * clamp01(vpdKpa(temperature_2m[i] ?? 10, relative_humidity_2m[i] ?? 80) / MODEL.vpdNormKpa);
      w = Math.max(0, w - MODEL.maxDryMmPerHour * k * gate(localHour(time[i])) * energy);
    }
    series.push(Number(w.toFixed(3)));
  }
  let dryAt = null;
  for (let i = nowIndex; i < series.length; i++) {
    if (series[i] <= MODEL.dryThresholdMm) { dryAt = time[i]; break; }
  }
  return { series, dryAt, currentMm: series[nowIndex] ?? 0 };
}

function seepageState(area, hours) {
  if (!area.seepage_prone) return { active: false, until: null };
  const { time, precipitation, nowIndex } = hours;
  const S = MODEL.seepage;
  let active = false, until = null;
  // find any 72h window ending at/before now with rain > trigger
  for (let end = nowIndex; end >= 0; end--) {
    let sum = 0;
    for (let i = Math.max(0, end - 71); i <= end; i++) sum += precipitation[i] ?? 0;
    if (sum > S.trigger3dayMm) {
      const days = Math.min(S.capDays, S.baseDays + S.daysPerInch * (sum / 25.4));
      const untilMs = new Date(time[end]).getTime() + days * 86400e3;
      if (untilMs > new Date(time[nowIndex]).getTime()) {
        active = true;
        until = new Date(untilMs).toISOString();
      }
      break;
    }
  }
  return { active, until };
}

function confidence(precipA, precipB) {
  const day = arr => {
    const d = [];
    for (let i = 0; i < arr.length; i += 24)
      d.push(arr.slice(i, i + 24).reduce((s, v) => s + (v ?? 0), 0));
    return d;
  };
  const a = day(precipA), b = day(precipB);
  const WET = 1; // mm/day
  let wetDisagree = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if ((a[i] > WET) !== (b[i] > WET)) wetDisagree++;
  }
  const ta = a.reduce((s, v) => s + v, 0), tb = b.reduce((s, v) => s + v, 0);
  const totalAgree = Math.abs(ta - tb) <= Math.max(2, 0.2 * Math.max(ta, tb));
  if (wetDisagree === 0 && totalAgree) return 'HIGH';
  if (wetDisagree >= 2) return 'LOW';
  return 'MEDIUM';
}

const mmToIn = mm => Math.round((mm / 25.4) * 100) / 100;

module.exports = { MODEL, vpdKpa, computeWetness, seepageState, confidence, mmToIn };
