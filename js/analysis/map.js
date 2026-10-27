/* Band-intensity maps over the spectra of a Raman map.

   WiRE's univariate "signal to baseline" map, done the same simple way: in a
   band window, the band's height is the largest excess of the spectrum over a
   straight line joining the window's two edges (each edge level the median of
   its outermost points, so one noisy point cannot tilt the line). A ratio map
   divides two such heights. Comparing two maps by their correlation across
   the map points automates the lab's "toggle two heat maps and see whether
   they match" step: bands from the same component rise and fall together.
   Correlation shows co-variation, not identity; the panel says so. */

const EDGE = 3;   // points averaged (median) at each window edge

/**
 * Height of a band above a straight line across its window.
 * @param {ArrayLike<number>} x ascending
 * @param {ArrayLike<number>} y
 * @param {number} lo window start (cm⁻¹)
 * @param {number} hi window end (cm⁻¹)
 * @returns {number} NaN if the window holds fewer than 2·EDGE + 1 points
 */
export function bandHeight(x, y, lo, hi) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi);
  let i0 = -1, i1 = -1;
  for (let i = 0; i < x.length; i++) if (x[i] >= a && x[i] <= b) { if (i0 < 0) i0 = i; i1 = i; }
  if (i0 < 0 || i1 - i0 + 1 < 2 * EDGE + 1) return NaN;
  const med = arr => { const s = Float64Array.from(arr).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const yl = med(Array.from({ length: EDGE }, (_, k) => y[i0 + k])), yr = med(Array.from({ length: EDGE }, (_, k) => y[i1 - k]));
  const xl = x[i0 + (EDGE >> 1)], xr = x[i1 - (EDGE >> 1)];
  let best = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const line = yl + (yr - yl) * (x[i] - xl) / ((xr - xl) || 1);
    if (y[i] - line > best) best = y[i] - line;
  }
  return best;
}

/**
 * Map values for a measure: one band's height, or the ratio of two.
 * @param {{x:ArrayLike<number>, y:ArrayLike<number>}[]} spectra one per map point
 * @param {{lo:number, hi:number}} num
 * @param {{lo:number, hi:number}|null} [den] ratio denominator
 * @returns {Float64Array} NaN where a value cannot be formed: the window holds too few points,
 *   or (ratios) the denominator band is absent, below DEN_FLOOR of its largest height in the map,
 *   where the ratio would only divide by noise
 */
export function mapValues(spectra, num, den = null) {
  const a = Float64Array.from(spectra, s => bandHeight(s.x, s.y, num.lo, num.hi));
  if (!den) return a;
  const b = Float64Array.from(spectra, s => bandHeight(s.x, s.y, den.lo, den.hi));
  let top = 0;
  for (const v of b) if (v > top) top = v;
  return Float64Array.from(a, (v, i) => (b[i] > DEN_FLOOR * top && b[i] > 0 ? v / b[i] : NaN));
}

/** Share of the largest denominator height below which a ratio cell is left empty. */
export const DEN_FLOOR = 0.05;

/**
 * Pearson correlation of two maps over the points where both are finite.
 * @returns {{r:number, n:number}} r is NaN for fewer than 3 points or a constant map
 */
export function correlation(a, b) {
  const xs = [], ys = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  const n = xs.length;
  if (n < 3) return { r: NaN, n };
  const mx = xs.reduce((p, q) => p + q, 0) / n, my = ys.reduce((p, q) => p + q, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return { r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN, n };
}

/**
 * Layout of map points: the distinct x and y coordinates and each point's cell.
 * Points need not fill the grid; cells without a spectrum stay empty.
 * @param {{x:number, y:number}[]} pts stage coordinates
 * @returns {{xs:number[], ys:number[], nx:number, ny:number, cell:Array<[number, number]>, dx:number, dy:number}}
 */
export function layout(pts) {
  const distinct = vals => {
    const s = [...vals].sort((p, q) => p - q);
    const span = (s[s.length - 1] - s[0]) || 1, tol = 1e-6 * span;
    const out = [];
    for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
    return out;
  };
  const xs = distinct(pts.map(p => p.x)), ys = distinct(pts.map(p => p.y));
  const near = (arr, v) => { let best = 0; for (let k = 1; k < arr.length; k++) if (Math.abs(arr[k] - v) < Math.abs(arr[best] - v)) best = k; return best; };
  const step = arr => { let d = Infinity; for (let k = 1; k < arr.length; k++) d = Math.min(d, arr[k] - arr[k - 1]); return Number.isFinite(d) ? d : 1; };
  return { xs, ys, nx: xs.length, ny: ys.length, cell: pts.map(p => [near(xs, p.x), near(ys, p.y)]), dx: step(xs), dy: step(ys) };
}

/** Sequential ramp (one hue, light → dark), steps 100…700 of the reference blue. */
export const RAMP = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

/**
 * Colour for t ∈ [0, 1]: low values recede toward the surface, so the light end
 * is low on a light surface and the dark end is low on a dark one.
 * @param {number} t
 * @param {boolean} dark
 * @returns {string} hex colour
 */
export function rampColor(t, dark) {
  if (!Number.isFinite(t)) return null;
  const u = Math.max(0, Math.min(1, dark ? 1 - t : t)) * (RAMP.length - 1);
  const k = Math.min(RAMP.length - 2, Math.floor(u)), f = u - k;
  const c0 = hex(RAMP[k]), c1 = hex(RAMP[k + 1]);
  return '#' + c0.map((v, i) => Math.round(v + (c1[i] - v) * f).toString(16).padStart(2, '0')).join('');
}

function hex(h) { return [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); }
