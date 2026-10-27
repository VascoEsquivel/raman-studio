/* Wavenumber calibration against a silicon reference spectrum.

   The lab's procedure is a zero-order (offset) correction: measure the Si band of a
   reference spectrum, compare it with the nominal position, and shift every
   spectrum of the session by the difference. The app holds no nominal value of its
   own: the user enters it, with its source, every time, and both are recorded with
   the offset.

   The measured position is the centre of one pseudo-Voigt (PeakForge's profile)
   plus a linear baseline, fitted around the highest point of a search window on the
   UNCALIBRATED axis, so measuring again after calibrating gives the same answer. */

import { fitPeaks } from '../fit/lm.js';

/**
 * Measure the Si band of a reference spectrum.
 * @param {ArrayLike<number>} x ascending, uncalibrated (cm⁻¹)
 * @param {ArrayLike<number>} y despiked intensities
 * @param {{lo?:number, hi?:number, halfWidth?:number}} [opts] search window (cm⁻¹) and the fit
 *   half-width around its highest point
 * @returns {{x0:number, se:number|null, w:number, h:number, g:number, apexX:number, n:number,
 *   lo:number, hi:number, undersampled:boolean, quality:number}}
 * @throws {Error} when the window holds too few points or no band above its baseline
 */
export function measureSiPeak(x, y, { lo = 480, hi = 560, halfWidth = 20 } = {}) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  let im = -1;
  for (let i = 0; i < x.length; i++) if (x[i] >= a && x[i] <= b && (im < 0 || y[i] > y[im])) im = i;
  if (im < 0) throw new Error(`No data between ${a} and ${b} cm⁻¹.`);
  const idx = [];
  for (let i = 0; i < x.length; i++) if (x[i] >= Math.max(a, x[im] - halfWidth) && x[i] <= Math.min(b, x[im] + halfWidth)) idx.push(i);
  if (idx.length < 7) throw new Error(`Only ${idx.length} points around the band at ${x[im].toFixed(1)} cm⁻¹: too few to fit.`);
  const xs = Float64Array.from(idx, i => x[i]), ys = Float64Array.from(idx, i => y[i]);
  const edge = Math.min(ys[0], ys[ys.length - 1]);
  if (!(y[im] > edge)) throw new Error(`No band rises above its surroundings between ${a} and ${b} cm⁻¹.`);
  // starting width: the half-height crossings around the apex
  let l = im, r = im;
  const half = edge + (y[im] - edge) / 2;
  while (l > idx[0] && y[l] > half) l--;
  while (r < idx[idx.length - 1] && y[r] > half) r++;
  const res = fitPeaks({
    x: xs, y: ys,
    peaks: [{ x0: x[im], w: Math.max(x[r] - x[l], 1), h: y[im] - edge, g: 50 }],
    baseline: { mode: 'linear', c0: edge, c1: 0, fit: true },
    maxIter: 300,
  });
  const p = res.peaks[0];
  if (!(p.h > 0)) throw new Error('The fit found no band in the window.');
  return {
    x0: p.x0, se: Number.isFinite(p.se.x0) ? p.se.x0 : null, w: p.w, h: p.h, g: p.g,
    apexX: x[im], n: idx.length, lo: a, hi: b, undersampled: res.undersampled.length > 0, quality: res.stats.quality,
  };
}
