/* Tier-1 peak detection for a processed (baseline-corrected) spectrum.

   The heavy lifting is the SciPy-faithful findPeaks; this module translates
   spectroscopist settings into its sample-based arguments:
   - "sensitivity" is a single 0..1 knob mapped to a prominence threshold in
     units of the robust noise σ, so the same setting behaves the same on a
     noisy survey scan and on a long accumulation;
   - widths and distances are given in cm⁻¹ and converted with the median
     sample spacing (instrument axes are rarely exactly uniform, and the median
     ignores the odd gap or stitched-window seam).
   Filters run in SciPy's order (distance before prominence). That keeps the
   distance step independent of sensitivity, so raising the sensitivity can
   only ever add peaks — the slider never makes a peak vanish. */

import { findPeaks } from './find-peaks.js';
import { estimateNoise } from './noise.js';

/**
 * Default detection settings.
 * sensitivity 0..1 (0 = only very strong peaks), minWidthCm minimal FWHM,
 * minDistanceCm minimal separation of reported peaks, maxPeaks cap.
 * @type {{sensitivity: number, minWidthCm: number, minDistanceCm: number, maxPeaks: number}}
 */
export const DEFAULT_DETECT = { sensitivity: 0.5, minWidthCm: 4, minDistanceCm: 8, maxPeaks: 30 };

// Prominence multiples of σ at sensitivity 0 and 1. 3σ is the usual detection
// limit; 50σ leaves only dominant bands. Log spacing makes each slider step
// change the threshold by the same factor.
const K_STRICT = 50;
const K_LOOSE = 3;

// Floor on the prominence threshold as a fraction of the signal range, so that
// a nearly noise-free (e.g. synthetic or heavily smoothed) spectrum, whose σ
// estimate is tiny, does not report every numerical ripple.
const RANGE_FLOOR = 0.005;

/**
 * Map the sensitivity knob to a prominence threshold in multiples of σ:
 * s = 0 → 50σ, s = 1 → 3σ, geometric in between (s = 0.5 → √150 ≈ 12.2σ).
 * Values outside 0..1 are clamped; a non-number gives the default sensitivity.
 * @param {number} s sensitivity
 * @returns {number} k, the prominence multiple of σ
 */
export function sensitivityToK(s) {
  const v = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : DEFAULT_DETECT.sensitivity;
  if (v <= 0) return K_STRICT;
  if (v >= 1) return K_LOOSE;
  return Math.exp(Math.log(K_STRICT) + v * (Math.log(K_LOOSE) - Math.log(K_STRICT)));
}

/**
 * Detect peaks in a spectrum.
 *
 * Minimum prominence = max(k·σ, 0.005·(max − min)) with k from
 * `sensitivityToK` and σ from `estimateNoise`. Peaks narrower than
 * `minWidthCm` (width at half prominence) are dropped; of peaks closer than
 * `minDistanceCm` the higher one is kept; if more than `maxPeaks` remain, the
 * most prominent ones are kept. Each peak's position is refined by a parabola
 * through the apex sample and its two neighbours (exact for uneven spacing);
 * `fwhm` is the distance between the interpolated half-prominence crossings
 * `leftX` and `rightX`. `snr` = prominence / σ (Infinity if σ is 0).
 *
 * @param {ArrayLike<number>} x Raman shift, cm⁻¹, ascending
 * @param {ArrayLike<number>} y intensity (baseline-corrected for best results)
 * @param {Partial<typeof DEFAULT_DETECT>} [opts] missing or non-numeric fields
 *   take their defaults; minWidthCm / minDistanceCm ≤ 0 switch that filter off;
 *   maxPeaks = Infinity removes the cap
 * @returns {Array<{id: string, index: number, x: number, y: number, prominence: number,
 *   fwhm: number, leftX: number, rightX: number, snr: number}>} DetectedPeak[], sorted by x
 */
export function detectPeaks(x, y, opts = {}) {
  if (!x || !y || typeof x.length !== 'number' || typeof y.length !== 'number') {
    throw new Error('detectPeaks needs x and y arrays');
  }
  if (x.length !== y.length) throw new Error(`x and y differ in length (${x.length} vs ${y.length})`);
  const o = resolveOptions(opts);
  const n = y.length;
  if (n < 3 || o.maxPeaks < 1) return [];

  const X = Float64Array.from(x);
  const Y = Float64Array.from(y);
  const dx = medianSpacing(X);
  if (!(dx > 0)) return [];

  const sigma = estimateNoise(Y);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = Y[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi > lo ? hi - lo : 0;
  const minProm = Math.max(sensitivityToK(o.sensitivity) * sigma, RANGE_FLOOR * range);

  const { peaks, properties } = findPeaks(Y, {
    prominence: [minProm, null],
    // Always ask for widths (open interval if the filter is off): fwhm needs them.
    width: [o.minWidthCm > 0 ? o.minWidthCm / dx : null, null],
    distance: o.minDistanceCm > 0 ? Math.max(1, o.minDistanceCm / dx) : null,
    relHeight: 0.5,
  });

  const prom = properties.prominences;
  let chosen = peaks.map((_, j) => j);
  if (chosen.length > o.maxPeaks) {
    // Ties go to the lower index so the result is deterministic.
    chosen.sort((a, b) => (prom[b] - prom[a]) || (a - b));
    chosen = chosen.slice(0, o.maxPeaks);
  }

  const out = chosen.map(j => {
    const index = peaks[j];
    const apex = refineApex(X, Y, index);
    const xl = xAtIndex(X, properties.left_ips[j]);
    const xr = xAtIndex(X, properties.right_ips[j]);
    return {
      id: `pk-${index}`,
      index,
      x: apex.x,
      y: apex.y,
      prominence: prom[j],
      fwhm: Math.abs(xr - xl),
      leftX: Math.min(xl, xr),
      rightX: Math.max(xl, xr),
      snr: sigma > 0 ? prom[j] / sigma : Infinity,
    };
  });
  out.sort((a, b) => (a.x - b.x) || (a.index - b.index));
  return out;
}

function resolveOptions(opts) {
  const src = opts || {};
  const o = {};
  for (const key of Object.keys(DEFAULT_DETECT)) {
    const v = src[key];
    o[key] = typeof v === 'number' && !Number.isNaN(v) ? v : DEFAULT_DETECT[key];
  }
  o.maxPeaks = o.maxPeaks === Infinity ? Infinity : Math.floor(o.maxPeaks);
  return o;
}

/** Median |Δx|; robust to a single gap or a stitched-window seam. */
function medianSpacing(X) {
  const d = [];
  for (let i = 1; i < X.length; i++) {
    const v = Math.abs(X[i] - X[i - 1]);
    if (Number.isFinite(v)) d.push(v);
  }
  if (!d.length) return NaN;
  d.sort((a, b) => a - b);
  const m = d.length >> 1;
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/**
 * Vertex of the parabola through the apex sample and its neighbours. Built in
 * coordinates relative to the apex so that x ≈ 3000 cm⁻¹ loses no precision,
 * and valid for uneven spacing. Falls back to the sample itself when the three
 * points are not strictly concave (e.g. the middle of a flat top).
 */
function refineApex(X, Y, i) {
  if (i <= 0 || i >= X.length - 1) return { x: X[i], y: Y[i] };
  const a = X[i - 1] - X[i], c = X[i + 1] - X[i];
  const sa = (Y[i - 1] - Y[i]) / a, sc = (Y[i + 1] - Y[i]) / c;
  const A = (sa - sc) / (a - c);
  const B = sa - A * a;
  if (!(A < 0)) return { x: X[i], y: Y[i] };
  const t = -B / (2 * A);
  if (!(t >= Math.min(a, c) && t <= Math.max(a, c))) return { x: X[i], y: Y[i] };
  return { x: X[i] + t, y: Y[i] + B * t / 2 };
}

/** x at a fractional sample index (linear between samples, as peak_widths assumes). */
function xAtIndex(X, f) {
  const last = X.length - 1;
  if (!(f > 0)) return X[0];
  if (f >= last) return X[last];
  const i = Math.floor(f), t = f - i;
  return X[i] + t * (X[i + 1] - X[i]);
}
