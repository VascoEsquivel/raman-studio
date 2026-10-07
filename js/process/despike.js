/* Cosmic-ray (spike) removal.

   Cosmic rays hit single detector pixels: 1–3 point, very sharp, positive
   excursions. Real Raman bands are wider than the instrument line width, so
   the job is to remove the former without ever touching the latter.

   1. Noise σ comes from the Whitaker–Hayes statistic: the median absolute
      deviation of the point-to-point differences (robust to the bands
      themselves), scaled to a Gaussian σ.
   2. Every point is compared with a prediction from its surroundings that
      leaves a HOLE over the point itself: a quadratic through the points
      maxWidth+1 … maxWidth+5 samples away on each side. A spike up to maxWidth
      wide is entirely inside the hole, so the prediction sees only the
      underlying signal: flat background, a band flank or a broad band top.
      Points whose excess over the prediction, in units of the residual's own
      noise (σ × the predictor's noise gain), exceeds `threshold` are flagged.
   3. Flagged runs are kept as spikes only if they are ≤ maxWidth points wide
      AND their immediate neighbours are not elevated too (excess < half the
      run's excess). That neighbour test is what protects real bands: plain
      Whitaker–Hayes flags the steep flanks of narrow bands in low-noise data,
      but a band — even a 5-point-FWHM one — lifts its neighbours, a cosmic ray
      does not.
   4. Two passes: the second masks the spikes found in the first, so a spike
      can't distort the prediction for another one a few points away.

   Removed points are replaced by linear interpolation between the nearest
   clean neighbours (at an array edge: the nearest clean value). */

const NEIGHBOUR_FRACTION = 0.5;

/**
 * Remove cosmic-ray spikes.
 * @param {ArrayLike<number>} x ascending Raman shift (used only to report positions)
 * @param {ArrayLike<number>} y intensity
 * @param {{threshold?:number, maxWidth?:number}} [opts] threshold: excess over the local
 *   prediction in noise σ (modified z-score); maxWidth: widest spike in points (1–5)
 * @returns {{y:Float64Array, removed:Array<{index:number,x:number,y:number,replacedY:number}>,
 *   spikes:Array<{start:number,end:number,xStart:number,xEnd:number,height:number}>}}
 */
export function despike(x, y, { threshold = 6, maxWidth = 3 } = {}) {
  const n = y ? y.length : 0;
  const Y = Float64Array.from(y || []);
  const out = Float64Array.from(Y);
  const result = { y: out, removed: [], spikes: [] };
  const hw = Math.max(1, Math.min(5, Math.round(maxWidth) || 3));
  if (n < 2 * (hw + SYM) + 1) return result;    // too short to tell a spike from a band
  for (let i = 0; i < n; i++) if (!Number.isFinite(Y[i])) return result;

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (Y[i] < lo) lo = Y[i]; if (Y[i] > hi) hi = Y[i]; }
  // A noiseless spectrum has σ = 0; a floor keeps rounding error from ever counting as a spike.
  const sigma = Math.max(noiseSigma(Y), 1e-4 * (hi - lo), 1e-300);
  const W = predictorWeights(hw);

  let runs = [];
  let work = Y;
  for (let pass = 0; pass < 3; pass++) {
    // z = excess / (σ · gain): the prediction carries noise of its own, so the
    // residual's spread is σ·gain, not σ. Comparing raw excess with threshold·σ
    // would flag ~1 noise point in 5000.
    const r = new Float64Array(n), z = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const [pred, gain] = predict(work, k, hw, W);
      r[k] = Y[k] - pred;
      z[k] = r[k] / (sigma * gain);
    }
    const found = [];
    for (let k = 0; k < n; k++) {
      if (!(z[k] > threshold)) continue;
      let j = k;
      while (j + 1 < n && z[j + 1] > threshold) j++;
      if (j - k + 1 <= hw) {
        let e = -Infinity;
        for (let q = k; q <= j; q++) if (r[q] > e) e = r[q];
        const left = k > 0 ? r[k - 1] : -Infinity, right = j < n - 1 ? r[j + 1] : -Infinity;
        if (left < NEIGHBOUR_FRACTION * e && right < NEIGHBOUR_FRACTION * e) found.push([k, j, e]);
      }
      k = j;
    }
    const same = found.length === runs.length && found.every((f, i) => f[0] === runs[i][0] && f[1] === runs[i][1]);
    runs = found;
    if (same || !runs.length) break;
    work = Float64Array.from(Y);
    for (const [a, b] of runs) fill(work, a, b);
  }

  for (const [a, b, e] of runs) {
    fill(out, a, b);
    for (let k = a; k <= b; k++) result.removed.push({ index: k, x: x ? +x[k] : k, y: Y[k], replacedY: out[k] });
    result.spikes.push({ start: a, end: b, xStart: x ? +x[a] : a, xEnd: x ? +x[b] : b, height: e });
  }
  return result;
}

/** Whitaker–Hayes noise level: MAD of first differences, as a Gaussian σ of y. */
function noiseSigma(Y) {
  const n = Y.length;
  const d = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) d[i - 1] = Y[i] - Y[i - 1];
  const med = median(d);
  for (let i = 0; i < d.length; i++) d[i] = Math.abs(d[i] - med);
  return median(d) / 0.6745 / Math.SQRT2;
}

function median(a) {
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SYM = 5;   // points per side in the symmetric predictor
const ONE = 6;   // points in the one-sided (array edge) predictor

/** Least-squares weights for the hole predictor (fixed index offsets) and their noise gains. */
function predictorWeights(hw) {
  // symmetric quadratic through offsets ±(hw+1 … hw+SYM), evaluated at 0
  const ts = Array.from({ length: SYM }, (_, i) => hw + 1 + i);
  let S2 = 0, S4 = 0;
  for (const t of ts) { S2 += 2 * t * t; S4 += 2 * t ** 4; }
  const den = 2 * SYM * S4 - S2 * S2;
  const sym = ts.map(t => (S4 - S2 * t * t) / den);
  // one-sided straight line through offsets hw+1 … hw+ONE, extrapolated to 0 (array edges)
  const us = Array.from({ length: ONE }, (_, i) => hw + 1 + i);
  const Su = us.reduce((a, u) => a + u, 0), Suu = us.reduce((a, u) => a + u * u, 0);
  const one = us.map(u => (Suu - Su * u) / (ONE * Suu - Su * Su));
  // σ of (point − prediction) in units of the point noise σ
  const symGain = Math.sqrt(1 + 2 * sym.reduce((a, w) => a + w * w, 0));
  const oneGain = Math.sqrt(1 + one.reduce((a, w) => a + w * w, 0));
  return { ts, sym, us, one, symGain, oneGain };
}

/** [prediction, noise gain] for point k from points outside the hole. */
function predict(Y, k, hw, W) {
  const n = Y.length, far = hw + SYM;
  if (k - far >= 0 && k + far < n) {
    let v = 0;
    for (let i = 0; i < SYM; i++) v += W.sym[i] * (Y[k - W.ts[i]] + Y[k + W.ts[i]]);
    return [v, W.symGain];
  }
  const dir = k - far < 0 ? 1 : -1;               // extrapolate from the side that exists
  let v = 0;
  for (let i = 0; i < ONE; i++) {
    const j = k + dir * W.us[i];
    if (j < 0 || j >= n) return [Y[k], 1];        // not enough points either way: never flag
    v += W.one[i] * Y[j];
  }
  return [v, W.oneGain];
}

/** Replace a..b by linear interpolation between the clean neighbours. */
function fill(arr, a, b) {
  const n = arr.length;
  const L = a - 1, R = b + 1;
  if (L < 0 && R >= n) return;
  for (let k = a; k <= b; k++) {
    if (L < 0) arr[k] = arr[R];
    else if (R >= n) arr[k] = arr[L];
    else arr[k] = arr[L] + (arr[R] - arr[L]) * (k - L) / (R - L);
  }
}
