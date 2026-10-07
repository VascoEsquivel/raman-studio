/* Spectrum construction — the single gate every importer goes through.

   Instruments disagree on almost everything: WiRE writes x descending, some
   exports repeat the last point, map files carry NaN padding. Downstream code
   (baseline, peak finding, fitting) is simpler and faster when it can assume
   a clean, ascending axis, so all of that normalisation happens here, once. */

let seq = 0;
// A per-load salt keeps ids unique even if two module instances coexist
// (e.g. a test page and the app in the same session).
const SALT = Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');

/**
 * Build a Spectrum: pairs x/y, drops non-finite pairs, sorts ascending by x and
 * averages points that share exactly the same x.
 * @param {object} args
 * @param {ArrayLike<number>} args.x Raman shift values (any order)
 * @param {ArrayLike<number>} args.y intensities, same length as x
 * @param {string} [args.name] display name
 * @param {{file:string, format:string, sheet?:string, column?:string|number}} [args.source]
 * @param {object} [args.meta] header key/values, e.g. { laserNm: 532 }
 * @param {string} [args.yLabel] column header or 'Intensity'
 * @param {string} [args.id] explicit id (normally assigned automatically)
 * @returns {{id:string, name:string, x:Float64Array, y:Float64Array, xLabel:string, xUnit:string,
 *   yLabel:string, source:object, meta:object}}
 */
export function makeSpectrum({ x, y, name, source, meta, yLabel, id } = {}) {
  if (!x || !y) throw new Error('A spectrum needs both x and y values.');
  if (x.length !== y.length) {
    throw new Error(`x and y have different lengths (${x.length} vs ${y.length}).`);
  }
  const n = x.length;
  const xs = [], ys = [];
  for (let i = 0; i < n; i++) {
    const xi = +x[i], yi = +y[i];
    if (Number.isFinite(xi) && Number.isFinite(yi)) { xs.push(xi); ys.push(yi); }
  }
  if (!xs.length) throw new Error('The spectrum has no valid (finite) data points.');

  const { x: sx, y: sy } = sortAndMerge(xs, ys);
  return {
    id: id || `sp${++seq}-${SALT}`,
    name: name || (source && source.file) || 'Spectrum',
    x: sx,
    y: sy,
    xLabel: 'Raman shift',
    xUnit: 'cm⁻¹',
    yLabel: yLabel || 'Intensity',
    source: { file: '', format: '', ...(source || {}) },
    meta: { ...(meta || {}) },
  };
}

/** Sort ascending (fast paths for already-ascending and descending input) and average exact duplicates. */
function sortAndMerge(xs, ys) {
  const n = xs.length;
  let asc = true, desc = true;
  for (let i = 1; i < n && (asc || desc); i++) {
    if (xs[i] < xs[i - 1]) asc = false;
    if (xs[i] > xs[i - 1]) desc = false;
  }
  let order;
  if (asc) order = null;
  else if (desc) { order = new Array(n); for (let i = 0; i < n; i++) order[i] = n - 1 - i; }
  else {
    order = Array.from({ length: n }, (_, i) => i);
    // Stable tie-break on the original index keeps the duplicate-average deterministic.
    order.sort((a, b) => (xs[a] - xs[b]) || (a - b));
  }
  const ox = new Float64Array(n), oy = new Float64Array(n);
  let m = 0, count = 0;
  for (let k = 0; k < n; k++) {
    const i = order ? order[k] : k;
    const xi = xs[i];
    if (m > 0 && ox[m - 1] === xi) {
      // Running mean, so any number of repeats averages without a second pass.
      count++;
      oy[m - 1] += (ys[i] - oy[m - 1]) / count;
    } else {
      ox[m] = xi; oy[m] = ys[i]; m++; count = 1;
    }
  }
  return m === n ? { x: ox, y: oy } : { x: ox.slice(0, m), y: oy.slice(0, m) };
}

/**
 * Pull a laser wavelength (nm) out of a header key/value pair, if the key names
 * a laser/excitation and the value is a plausible Raman excitation line.
 * Shared by the text, JCAMP and SPC importers so all formats agree.
 * @param {string} key header key, e.g. 'Laser (nm)'
 * @param {string|number} value header value, e.g. '532.17' or '785 nm'
 * @returns {number|null} wavelength in nm, or null
 */
export function laserFromHeader(key, value) {
  const k = String(key || '');
  if (!/laser|excitation|wavelength|lambda/i.test(k)) return null;
  // Power, filter and shutter settings mention the laser too; their numbers are not wavelengths.
  if (/power|mw\b|filter|shutter|intensity|attenuat|%|time|focus/i.test(k)) return null;
  const m = String(value ?? '').match(/[+-]?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0].replace(',', '.'));
  // 200–1600 nm spans every practical Raman excitation (deep-UV 244 → NIR 1064).
  return v >= 200 && v <= 1600 ? v : null;
}
