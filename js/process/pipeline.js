/* The processing chain: crop → despike → baseline → smooth → normalise.
   Every step is optional and the intermediate arrays are all returned, so the
   UI can show raw vs processed and exactly what each step removed. */

import { despike } from './despike.js';
import { computeBaseline } from './baseline.js';
import { savitzkyGolay } from './smooth.js';
import { normalize } from './normalize.js';

/** Default settings; the UI clones and edits a copy. */
export const DEFAULT_SETTINGS = Object.freeze({
  crop: Object.freeze({ on: false, lo: null, hi: null }),
  despike: Object.freeze({ on: true, threshold: 6, maxWidth: 3 }),
  baseline: Object.freeze({ on: true, method: 'als', lambda: 1e5, p: 0.01 }),
  smooth: Object.freeze({ on: false, window: 11, order: 3 }),
  normalize: Object.freeze({ on: false, mode: 'max' }),
});

const merged = s => {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = { ...DEFAULT_SETTINGS[k], ...((s && s[k]) || {}) };
  return out;
};

/**
 * Run the processing chain on one spectrum.
 * @param {{x:ArrayLike<number>, y:ArrayLike<number>}} spectrum ascending x
 * @param {object} [settings] partial settings, merged over DEFAULT_SETTINGS
 * @param {{bandWindow?:[number,number]|null}} [opts] band window for 'band' normalisation (e.g. G)
 * @returns {object} Processed (see docs/ARCHITECTURE.md)
 */
export function runPipeline(spectrum, settings, { bandWindow = null } = {}) {
  const s = merged(settings);
  const warnings = [];
  let x = Float64Array.from(spectrum.x), raw = Float64Array.from(spectrum.y);

  if (s.crop.on && (Number.isFinite(s.crop.lo) || Number.isFinite(s.crop.hi))) {
    const lo = Number.isFinite(s.crop.lo) ? s.crop.lo : -Infinity, hi = Number.isFinite(s.crop.hi) ? s.crop.hi : Infinity;
    const keep = [];
    for (let i = 0; i < x.length; i++) if (x[i] >= Math.min(lo, hi) && x[i] <= Math.max(lo, hi)) keep.push(i);
    if (keep.length >= 3) { x = Float64Array.from(keep, i => x[i]); raw = Float64Array.from(keep, i => raw[i]); }
    else warnings.push('Crop range leaves fewer than 3 points; showing the full spectrum.');
  }
  const n = x.length;
  const steps = { despike: false, baseline: false, smooth: false, normalize: false };

  let despiked = raw, removed = [], spikes = [];
  if (s.despike.on) {
    if (n >= 20) {
      const r = despike(x, raw, { threshold: s.despike.threshold, maxWidth: s.despike.maxWidth });
      despiked = r.y; removed = r.removed; spikes = r.spikes; steps.despike = true;
    } else warnings.push('Too few points for spike removal; skipped.');
  }

  let baseline = null, corrected = despiked;
  if (s.baseline.on && s.baseline.method !== 'none') {
    if (n >= 4) {
      baseline = computeBaseline(x, despiked, s.baseline);
      corrected = new Float64Array(n);
      for (let i = 0; i < n; i++) corrected[i] = despiked[i] - baseline[i];
      steps.baseline = true;
    } else warnings.push('Too few points for a baseline; skipped.');
  }

  let smoothed = corrected;
  if (s.smooth.on) {
    if (n >= 5) { smoothed = savitzkyGolay(corrected, { window: s.smooth.window, order: s.smooth.order }); steps.smooth = true; }
    else warnings.push('Too few points for smoothing; skipped.');
  }

  let y = smoothed, normFactor = 1, normRef = 'none';
  if (s.normalize.on) {
    const r = normalize(x, smoothed, { mode: s.normalize.mode, window: bandWindow });
    y = r.y; normFactor = r.factor; normRef = r.ref;
    if (r.warning) warnings.push(r.warning);
    steps.normalize = r.ref !== 'none';
  }

  return {
    x, raw, despiked, removed, spikes, baseline, corrected, smoothed, y,
    normFactor, normRef, steps, warnings,
  };
}
