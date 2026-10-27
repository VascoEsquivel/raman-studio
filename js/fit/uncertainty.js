/* Standard uncertainties of quantities derived from a deconvolution, by first-order
   (delta-method) propagation through each fit window's covariance matrix.

   What the number means: the 1σ scatter the value would show under repeated noise
   for THIS model (its bands, line shape and baseline), a fit-model standard
   uncertainty. It does not cover the choice of model, which can move a ratio far
   more, and it is not a probability.

   Components in different windows come from independent fits, so their
   covariance is zero. A parameter held fixed in the fit has no variance. */

import { GAREA, LAREA } from './profile.js';

/** d(measure)/d(parameter) for one component, as [key, coefficient] pairs. */
function gradient(c, measure) {
  if (measure === 'height') return [['h', 1]];
  const f = (c.g / 100) * GAREA + (1 - c.g / 100) * LAREA;   // area = h·w·f(g)
  return [['h', c.w * f], ['w', c.h * f], ['g', c.h * c.w * (GAREA - LAREA) / 100]];
}

function value(c, measure) { return measure === 'height' ? c.h : c.area; }

/**
 * Standard uncertainty of a ratio of two fitted components' heights or areas.
 * @param {{windows:object[]}} deconv result of deconvolve()
 * @param {object} num numerator component (from deconv.components)
 * @param {object} den denominator component
 * @param {'height'|'area'} [measure='height']
 * @returns {number|null} 1σ of num/den; null when a window's covariance is singular,
 *   a component is missing or the denominator is not positive
 */
export function ratioUncertainty(deconv, num, den, measure = 'height') {
  if (!deconv || !Array.isArray(deconv.windows) || !num || !den) return null;
  const A = value(num, measure), B = value(den, measure);
  if (!(B > 0) || !Number.isFinite(A)) return null;
  // dR/dθ: (1/B)·dA/dθ for the numerator's parameters, −(A/B²)·dB/dθ for the denominator's
  const terms = [
    ...gradient(num, measure).map(([k, g]) => ({ c: num, k, d: g / B })),
    ...gradient(den, measure).map(([k, g]) => ({ c: den, k, d: -A * g / (B * B) })),
  ];
  let v = 0;
  for (const s of terms) {
    for (const t of terms) {
      const cv = covarianceOf(deconv, s.c, s.k, t.c, t.k);
      if (cv === null) return null;
      v += s.d * t.d * cv;
    }
  }
  return Math.sqrt(Math.max(v, 0));
}

/**
 * Covariance of two component parameters: 0 across windows or for a fixed parameter.
 * @returns {number|null} null when the window's covariance matrix is unavailable
 */
export function covarianceOf(deconv, a, ka, b, kb) {
  if (a.windowIndex !== b.windowIndex) return 0;
  const w = deconv.windows[a.windowIndex], C = w && w.covariance;
  if (!C) return null;
  const at = (c, k) => C.params.findIndex(q => q.bandId === c.bandId && q.k === k);
  const i = at(a, ka), j = at(b, kb);
  if (i < 0 || j < 0) return 0;
  return C.matrix[i * C.params.length + j];
}
