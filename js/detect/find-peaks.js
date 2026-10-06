/* Port of scipy.signal.find_peaks (SciPy 1.18.1, scipy/signal/_peak_finding.py
   and the Cython kernels in _peak_finding_utils.pyx).

   Kept deliberately literal: same loops, same comparisons (strict vs. non-strict),
   same filter order, same snake_case property names. Peak tables are compared
   with what a Python user would get from SciPy, so any "improvement" here is a
   regression. tests/fixtures/find_peaks_vectors.json pins the behaviour against
   real SciPy output (regenerate with tools/make_scipy_vectors.py).

   Index-valued outputs (peaks, *_bases, *_edges, plateau_sizes) are plain
   number arrays; real-valued outputs are Float64Array.

   One unavoidable difference: SciPy orders peaks for the `distance` filter with
   np.argsort's default sort, which is unstable and SIMD-dependent, so which of
   two *equally high* competing peaks survives varies between machines. Here the
   order is a stable sort: the right-most of equal peaks is evaluated first and
   wins. Peaks of different height behave exactly as in SciPy. */

/**
 * Find all local maxima, including flat ones, by comparing neighbours
 * (SciPy `_local_maxima_1d`). For a plateau the middle sample is returned,
 * rounded down: `(left_edge + right_edge) // 2`. The first and last samples are
 * never maxima, and a plateau that runs into either edge is not one either.
 * @param {ArrayLike<number>} x signal
 * @returns {{peaks: number[], left_edges: number[], right_edges: number[]}}
 */
export function localMaxima1d(x) {
  const xs = asSignal(x);
  const peaks = [], leftEdges = [], rightEdges = [];
  let i = 1;
  const iMax = xs.length - 1;
  while (i < iMax) {
    if (xs[i - 1] < xs[i]) {
      let iAhead = i + 1;
      // Walk across a plateau to the first sample that differs from x[i].
      while (iAhead < iMax && xs[iAhead] === xs[i]) iAhead++;
      if (xs[iAhead] < xs[i]) {
        leftEdges.push(i);
        rightEdges.push(iAhead - 1);
        peaks.push(Math.floor((i + iAhead - 1) / 2));
        // Nothing inside the plateau can start another maximum.
        i = iAhead;
      }
    }
    i++;
  }
  return { peaks, left_edges: leftEdges, right_edges: rightEdges };
}

/**
 * Mark peaks to keep so that the survivors are at least `distance` samples
 * apart, removing lower peaks first (SciPy `_select_by_peak_distance`).
 * @param {ArrayLike<number>} peaks ascending peak indices
 * @param {ArrayLike<number>} priority one value per peak; the highest is kept first
 * @param {number} distance minimal distance in samples (rounded up to an integer)
 * @returns {boolean[]} keep flag per peak
 */
export function selectByPeakDistance(peaks, priority, distance) {
  const n = peaks.length;
  // Real peak distances are whole samples, so round the requirement up.
  const d = Math.ceil(distance);
  const keep = new Array(n).fill(true);
  const order = stableArgsort(priority);
  for (let i = n - 1; i >= 0; i--) {
    const j = order[i];
    if (!keep[j]) continue;
    let k = j - 1;
    while (k >= 0 && peaks[j] - peaks[k] < d) { keep[k] = false; k--; }
    k = j + 1;
    while (k < n && peaks[k] - peaks[j] < d) { keep[k] = false; k++; }
  }
  return keep;
}

/**
 * Prominence of each peak: its height above the higher of the two lowest
 * points reached before the signal climbs above the peak on either side
 * (SciPy `peak_prominences`). With `wlen` the search is confined to a window of
 * `wlen` samples centred on the peak (even lengths act as the next odd one).
 * Of equally low candidates, the base closest to the peak is reported.
 * @param {ArrayLike<number>} x signal
 * @param {ArrayLike<number>} peaks integer sample indices (any valid index, not only maxima)
 * @param {number|null} [wlen] window length in samples, > 1; non-integers are rounded up
 * @returns {{prominences: Float64Array, left_bases: number[], right_bases: number[], warnings: string[]}}
 */
export function peakProminences(x, peaks, wlen = null) {
  const xs = asSignal(x);
  const pk = asPeaks(peaks);
  return prominencesKernel(xs, pk, wlenAsExpected(wlen));
}

/**
 * Width of each peak at `relHeight` of its prominence below the apex, with the
 * crossing positions linearly interpolated between samples (SciPy
 * `peak_widths`). The contour line is `width_heights = x[peak] − prominence ·
 * relHeight` and the search never leaves the prominence bases.
 * @param {ArrayLike<number>} x signal
 * @param {ArrayLike<number>} peaks integer sample indices
 * @param {number} [relHeight=0.5] 0.5 = full width at half prominence; 1 = at the base
 * @param {null|{prominences: ArrayLike<number>, left_bases: ArrayLike<number>, right_bases: ArrayLike<number>}|Array<ArrayLike<number>>} [prominenceData]
 *   output of `peakProminences` (object, or a `[prominences, left_bases, right_bases]`
 *   triple as SciPy takes); computed when omitted
 * @param {number|null} [wlen] only used when `prominenceData` is omitted
 * @returns {{widths: Float64Array, width_heights: Float64Array, left_ips: Float64Array, right_ips: Float64Array, warnings: string[]}}
 */
export function peakWidths(x, peaks, relHeight = 0.5, prominenceData = null, wlen = null) {
  const xs = asSignal(x);
  const pk = asPeaks(peaks);
  let pd = prominenceData;
  if (pd == null) {
    pd = prominencesKernel(xs, pk, wlenAsExpected(wlen));
  } else if (Array.isArray(pd)) {
    pd = { prominences: pd[0], left_bases: pd[1], right_bases: pd[2] };
  }
  const prom = Float64Array.from(pd.prominences);
  const lb = asPeaks(pd.left_bases);
  const rb = asPeaks(pd.right_bases);
  return widthsKernel(xs, pk, relHeight, prom, lb, rb);
}

/**
 * Find peaks (local maxima) and select them by their properties, exactly as
 * `scipy.signal.find_peaks`. Conditions are evaluated in SciPy's order:
 * plateauSize, height, threshold, distance, prominence, width.
 *
 * Interval conditions (height, threshold, prominence, width, plateauSize) take
 * a number (minimum), or `[min, max]` with `null` for an open end; either border
 * may also be an array with one value per sample of `x` (SciPy's array borders).
 * `[null, null]` computes the property without excluding anything. A
 * condition left `undefined`/`null` is not evaluated and its properties are
 * not returned.
 *
 * @param {ArrayLike<number>} x signal (NaNs give the same odd results as in SciPy)
 * @param {object} [opts]
 * @param {*} [opts.height] required height
 * @param {*} [opts.threshold] required vertical distance to both neighbouring samples
 * @param {number} [opts.distance] minimal horizontal distance between peaks in samples, ≥ 1
 * @param {*} [opts.prominence] required prominence
 * @param {*} [opts.width] required width in samples
 * @param {number} [opts.wlen] prominence window (see `peakProminences`)
 * @param {number} [opts.relHeight=0.5] contour height for widths (see `peakWidths`)
 * @param {*} [opts.plateauSize] required flat-top size in samples
 * @returns {{peaks: number[], properties: Object<string, Float64Array|number[]>, warnings: string[]}}
 *   properties use SciPy's keys: plateau_sizes, left_edges, right_edges,
 *   peak_heights, left_thresholds, right_thresholds, prominences, left_bases,
 *   right_bases, widths, width_heights, left_ips, right_ips
 */
export function findPeaks(x, opts = {}) {
  const { height = null, threshold = null, distance = null, prominence = null, width = null,
    wlen = null, relHeight = 0.5, plateauSize = null } = opts || {};
  const xs = asSignal(x);
  if (distance != null && distance < 1) throw new Error('`distance` must be greater or equal to 1');

  const lm = localMaxima1d(xs);
  let peaks = lm.peaks;
  let properties = {};
  const warnings = [];

  if (plateauSize != null) {
    const sizes = lm.right_edges.map((r, i) => r - lm.left_edges[i] + 1);
    const [pmin, pmax] = unpackConditionArgs(plateauSize, xs, peaks);
    const keep = selectByProperty(sizes, pmin, pmax);
    peaks = filterKeep(peaks, keep);
    properties.plateau_sizes = sizes;
    properties.left_edges = lm.left_edges;
    properties.right_edges = lm.right_edges;
    properties = filterProperties(properties, keep);
  }

  if (height != null) {
    const heights = Float64Array.from(peaks, p => xs[p]);
    const [hmin, hmax] = unpackConditionArgs(height, xs, peaks);
    const keep = selectByProperty(heights, hmin, hmax);
    peaks = filterKeep(peaks, keep);
    properties.peak_heights = heights;
    properties = filterProperties(properties, keep);
  }

  if (threshold != null) {
    const [tmin, tmax] = unpackConditionArgs(threshold, xs, peaks);
    const { keep, left, right } = selectByPeakThreshold(xs, peaks, tmin, tmax);
    peaks = filterKeep(peaks, keep);
    properties.left_thresholds = left;
    properties.right_thresholds = right;
    properties = filterProperties(properties, keep);
  }

  if (distance != null) {
    const keep = selectByPeakDistance(peaks, Float64Array.from(peaks, p => xs[p]), distance);
    peaks = filterKeep(peaks, keep);
    properties = filterProperties(properties, keep);
  }

  if (prominence != null || width != null) {
    // Widths are measured against the prominence bases, so both need these.
    const pr = prominencesKernel(xs, peaks, wlenAsExpected(wlen));
    properties.prominences = pr.prominences;
    properties.left_bases = pr.left_bases;
    properties.right_bases = pr.right_bases;
    warnings.push(...pr.warnings);
  }

  if (prominence != null) {
    const [pmin, pmax] = unpackConditionArgs(prominence, xs, peaks);
    const keep = selectByProperty(properties.prominences, pmin, pmax);
    peaks = filterKeep(peaks, keep);
    properties = filterProperties(properties, keep);
  }

  if (width != null) {
    const w = widthsKernel(xs, peaks, relHeight, properties.prominences,
      properties.left_bases, properties.right_bases);
    properties.widths = w.widths;
    properties.width_heights = w.width_heights;
    properties.left_ips = w.left_ips;
    properties.right_ips = w.right_ips;
    warnings.push(...w.warnings);
    const [wmin, wmax] = unpackConditionArgs(width, xs, peaks);
    const keep = selectByProperty(properties.widths, wmin, wmax);
    peaks = filterKeep(peaks, keep);
    properties = filterProperties(properties, keep);
  }

  return { peaks, properties, warnings };
}

// ---------------------------------------------------------------------------
// Kernels (SciPy's Cython functions) and argument handling.

function prominencesKernel(xs, peaks, wlen) {
  const n = peaks.length;
  const prominences = new Float64Array(n);
  const leftBases = new Array(n), rightBases = new Array(n);
  let zero = false;
  for (let pn = 0; pn < n; pn++) {
    const peak = peaks[pn];
    let iMin = 0, iMax = xs.length - 1;
    if (!(iMin <= peak && peak <= iMax)) throw new Error(`peak ${peak} is not a valid index for \`x\``);
    if (wlen >= 2) {
      // An even wlen gives the same window as wlen + 1: the window is symmetric.
      iMin = Math.max(peak - Math.floor(wlen / 2), iMin);
      iMax = Math.min(peak + Math.floor(wlen / 2), iMax);
    }
    // Left base: lowest point before the signal rises above the peak. Strict <
    // keeps the candidate nearest the peak when several minima are equal.
    let i = peak, lb = peak, leftMin = xs[peak];
    while (iMin <= i && xs[i] <= xs[peak]) {
      if (xs[i] < leftMin) { leftMin = xs[i]; lb = i; }
      i--;
    }
    i = peak;
    let rb = peak, rightMin = xs[peak];
    while (i <= iMax && xs[i] <= xs[peak]) {
      if (xs[i] < rightMin) { rightMin = xs[i]; rb = i; }
      i++;
    }
    leftBases[pn] = lb;
    rightBases[pn] = rb;
    prominences[pn] = xs[peak] - Math.max(leftMin, rightMin);
    if (prominences[pn] === 0) zero = true;
  }
  return { prominences, left_bases: leftBases, right_bases: rightBases,
    warnings: zero ? ['some peaks have a prominence of 0'] : [] };
}

function widthsKernel(xs, peaks, relHeight, prominences, leftBases, rightBases) {
  if (relHeight < 0) throw new Error('`rel_height` must be greater or equal to 0.0');
  const n = peaks.length;
  if (!(n === prominences.length && n === leftBases.length && n === rightBases.length)) {
    throw new Error('arrays in `prominence_data` must have the same shape as `peaks`');
  }
  const widths = new Float64Array(n), heights = new Float64Array(n);
  const leftIps = new Float64Array(n), rightIps = new Float64Array(n);
  let zero = false;
  for (let p = 0; p < n; p++) {
    const iMin = leftBases[p], iMax = rightBases[p], peak = peaks[p];
    if (!(0 <= iMin && iMin <= peak && peak <= iMax && iMax < xs.length)) {
      throw new Error(`prominence data is invalid for peak ${peak}`);
    }
    const h = xs[peak] - prominences[p] * relHeight;
    heights[p] = h;
    let i = peak;
    while (iMin < i && h < xs[i]) i--;
    let leftIp = i;
    // Interpolate only when the contour falls between two samples.
    if (xs[i] < h) leftIp += (h - xs[i]) / (xs[i + 1] - xs[i]);
    i = peak;
    while (i < iMax && h < xs[i]) i++;
    let rightIp = i;
    if (xs[i] < h) rightIp -= (h - xs[i]) / (xs[i - 1] - xs[i]);
    widths[p] = rightIp - leftIp;
    if (widths[p] === 0) zero = true;
    leftIps[p] = leftIp;
    rightIps[p] = rightIp;
  }
  return { widths, width_heights: heights, left_ips: leftIps, right_ips: rightIps,
    warnings: zero ? ['some peaks have a width of 0'] : [] };
}

/** SciPy `_select_by_property`: borders are inclusive; null is an open end. */
function selectByProperty(props, pmin, pmax) {
  const keep = new Array(props.length).fill(true);
  for (let i = 0; i < props.length; i++) {
    if (pmin != null && !(at(pmin, i) <= props[i])) keep[i] = false;
    if (pmax != null && !(props[i] <= at(pmax, i))) keep[i] = false;
  }
  return keep;
}

/** SciPy `_select_by_peak_threshold`: the minimum is tested against the smaller
    of the two drops, the maximum against the larger one. */
function selectByPeakThreshold(xs, peaks, tmin, tmax) {
  const n = peaks.length;
  const left = new Float64Array(n), right = new Float64Array(n);
  const keep = new Array(n).fill(true);
  for (let i = 0; i < n; i++) {
    const p = peaks[i];
    left[i] = xs[p] - xs[p - 1];
    right[i] = xs[p] - xs[p + 1];
    if (tmin != null && !(at(tmin, i) <= Math.min(left[i], right[i]))) keep[i] = false;
    if (tmax != null && !(Math.max(left[i], right[i]) <= at(tmax, i))) keep[i] = false;
  }
  return { keep, left, right };
}

/** SciPy `_unpack_condition_args`: a 2-element sequence is [min, max], anything
    else is the minimum; array borders must match x and are reduced to the peaks. */
function unpackConditionArgs(interval, xs, peaks) {
  let imin, imax;
  if (isArrayLike(interval) && interval.length === 2) {
    [imin, imax] = [interval[0], interval[1]];
  } else {
    [imin, imax] = [interval, null];
  }
  if (isArrayLike(imin)) {
    if (imin.length !== xs.length) throw new Error('array size of lower interval border must match x');
    imin = Float64Array.from(peaks, p => imin[p]);
  }
  if (isArrayLike(imax)) {
    if (imax.length !== xs.length) throw new Error('array size of upper interval border must match x');
    imax = Float64Array.from(peaks, p => imax[p]);
  }
  return [imin, imax];
}

/** SciPy `_arg_wlen_as_expected`: null → -1 (no window); otherwise must exceed 1. */
function wlenAsExpected(wlen) {
  if (wlen == null) return -1;
  if (1 < wlen) return Math.ceil(wlen);
  throw new Error(`\`wlen\` must be larger than 1, was ${wlen}`);
}

/**
 * Ascending argsort that keeps equal values in index order. NaN sorts last,
 * as in NumPy, so a NaN priority is treated as the highest.
 */
function stableArgsort(values) {
  const idx = Array.from({ length: values.length }, (_, i) => i);
  idx.sort((a, b) => {
    const va = values[a], vb = values[b];
    const na = Number.isNaN(va), nb = Number.isNaN(vb);
    if (na || nb) return na === nb ? a - b : (na ? 1 : -1);
    if (va < vb) return -1;
    if (va > vb) return 1;
    return a - b;
  });
  return idx;
}

function asSignal(x) {
  if (x == null || typeof x.length !== 'number') throw new Error('`x` must be a 1-D array of numbers');
  return x instanceof Float64Array ? x : Float64Array.from(x);
}

function asPeaks(peaks) {
  if (peaks == null || typeof peaks.length !== 'number') throw new Error('`peaks` must be a 1-D array of indices');
  const out = new Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    const v = Number(peaks[i]);
    if (!Number.isInteger(v)) throw new Error('cannot safely cast `peaks` to integer indices');
    out[i] = v;
  }
  return out;
}

function isArrayLike(v) {
  return v != null && typeof v === 'object' && typeof v.length === 'number';
}

function at(border, i) {
  return isArrayLike(border) ? border[i] : border;
}

function filterKeep(arr, keep) {
  const out = [];
  for (let i = 0; i < arr.length; i++) if (keep[i]) out.push(arr[i]);
  return out;
}

/** Apply a keep mask to every property, preserving each array's type. */
function filterProperties(properties, keep) {
  const out = {};
  for (const [key, arr] of Object.entries(properties)) {
    const kept = filterKeep(arr, keep);
    out[key] = arr instanceof Float64Array ? Float64Array.from(kept) : kept;
  }
  return out;
}
