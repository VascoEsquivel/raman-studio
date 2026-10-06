/* Robust noise level, as PeakForge estimates it.

   Successive differences cancel any baseline or broad band that varies slowly
   compared with the sampling, leaving mostly noise: for white noise of standard
   deviation σ, Δy has standard deviation σ·√2. Taking the median of |Δy|
   instead of an RMS makes the estimate ignore the few large steps across sharp
   peak flanks and spikes; 0.6745 converts a median absolute deviation into σ
   for Gaussian noise. */

/**
 * Robust noise σ of a signal: median |Δy| / (0.6745·√2) (PeakForge).
 * Like PeakForge, the "median" is the upper middle element for an even count
 * and signals shorter than 4 samples give 0. Non-finite differences are
 * ignored so one NaN cannot poison the sort.
 * @param {ArrayLike<number>} y intensities (sampling assumed roughly even)
 * @returns {number} σ estimate, ≥ 0 (0 when it cannot be estimated)
 */
export function estimateNoise(y) {
  const n = y ? y.length : 0;
  if (n < 4) return 0;
  const d = [];
  for (let i = 1; i < n; i++) {
    const v = Math.abs(y[i] - y[i - 1]);
    if (Number.isFinite(v)) d.push(v);
  }
  if (!d.length) return 0;
  d.sort((a, b) => a - b);
  return (d[Math.floor(d.length / 2)] || 0) / (0.6745 * Math.SQRT2);
}
