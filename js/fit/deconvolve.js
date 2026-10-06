/* Atlas-seeded deconvolution: one pseudo-Voigt component per library band,
   fitted with PeakForge's Levenberg–Marquardt (lm.js).

   First- and second-order bands are fitted in separate windows, each with its
   own linear local baseline: the two regions are ~1000 cm⁻¹ apart and sit on
   different stretches of whatever fluorescence background survived processing,
   so one global baseline would bias both.

   Overlapping GO bands (D″ under D–G, G against D′) are degenerate enough that
   the starting heights matter. Seeding each height from the data at its own
   centre double-counts the overlap — every band would start at the full
   envelope height. Instead, with centres and widths fixed at their atlas seeds,
   the model is linear in the heights and the baseline, so the heights are seeded
   by non-negative least squares against the data with the linear baseline
   solved for jointly. That is the best possible start for the seeded shapes and
   LM only has to refine shape parameters. */

import { peakY } from './profile.js';
import { fitPeaks, evaluateModel } from './lm.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const fmt = v => (Math.round(v * 10) / 10).toString();

// Least-squares line v ≈ a + b·u.
function lineFit(u, v) {
  const n = u.length;
  let su = 0, sv = 0, suu = 0, suv = 0;
  for (let i = 0; i < n; i++) { su += u[i]; sv += v[i]; suu += u[i] * u[i]; suv += u[i] * v[i]; }
  const den = n * suu - su * su;
  if (!(Math.abs(den) > 1e-300)) return { a: n ? sv / n : 0, b: 0 };
  const b = (n * suv - su * sv) / den;
  return { a: (sv - b * su) / n, b };
}

// v minus its own least-squares line: projecting out the free baseline turns
// "heights ≥ 0 plus an unconstrained line" into a plain NNLS problem.
function detrend(u, v) {
  const { a, b } = lineFit(u, v), out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - (a + b * u[i]);
  return out;
}

// Small dense solve with partial pivoting; null when singular.
function solveSmall(A, b, n) {
  A = Float64Array.from(A); b = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (!(Math.abs(A[piv * n + c]) > 1e-300)) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; }
      const t = b[c]; b[c] = b[piv]; b[piv] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const s = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let v = b[r];
    for (let k = r + 1; k < n; k++) v -= A[r * n + k] * s[k];
    s[r] = v / A[r * n + r];
  }
  return s;
}

// Lawson–Hanson NNLS on the normal equations: min ‖Σ cols[j]·h[j] − b‖², h ≥ 0.
// A handful of columns per window, so the normal-equation form is plenty.
function nnls(cols, b) {
  const k = cols.length, n = b.length;
  const G = new Float64Array(k * k), c = new Float64Array(k);
  for (let j = 0; j < k; j++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += cols[j][i] * b[i];
    c[j] = s;
    for (let l = j; l < k; l++) {
      let t = 0;
      for (let i = 0; i < n; i++) t += cols[j][i] * cols[l][i];
      G[j * k + l] = t; G[l * k + j] = t;
    }
  }
  let scale = 0;
  for (let j = 0; j < k; j++) scale = Math.max(scale, Math.abs(c[j]));
  const tol = 1e-10 * (scale || 1);
  let x = new Float64Array(k);
  const passive = new Array(k).fill(false);
  const subSolve = () => {
    const idx = [];
    for (let j = 0; j < k; j++) if (passive[j]) idx.push(j);
    const p = idx.length, A = new Float64Array(p * p), rhs = new Float64Array(p);
    for (let a = 0; a < p; a++) {
      rhs[a] = c[idx[a]];
      for (let q = 0; q < p; q++) A[a * p + q] = G[idx[a] * k + idx[q]];
    }
    const s = solveSmall(A, rhs, p);
    if (!s) return null;
    const full = new Float64Array(k);
    idx.forEach((j, a) => { full[j] = s[a]; });
    return { s: full, idx };
  };
  for (let outer = 0; outer < 3 * k + 3; outer++) {
    let t = -1, best = tol;
    for (let j = 0; j < k; j++) {
      if (passive[j]) continue;
      let w = c[j];
      for (let l = 0; l < k; l++) w -= G[j * k + l] * x[l];
      if (w > best) { best = w; t = j; }
    }
    if (t < 0) break;
    passive[t] = true;
    for (let inner = 0; inner < 3 * k + 3; inner++) {
      const sol = subSolve();
      if (!sol) { passive[t] = false; return x; }
      const { s, idx } = sol;
      if (idx.every(j => s[j] > 0)) { x = s; break; }
      let alpha = Infinity;
      for (const j of idx) if (s[j] <= 0) alpha = Math.min(alpha, x[j] / (x[j] - s[j]));
      if (!Number.isFinite(alpha)) alpha = 0;
      for (let j = 0; j < k; j++) x[j] += alpha * (s[j] - x[j]);
      let xmax = 0;
      for (let j = 0; j < k; j++) xmax = Math.max(xmax, Math.abs(x[j]));
      for (const j of idx) if (x[j] <= 1e-14 * Math.max(1, xmax)) { passive[j] = false; x[j] = 0; }
    }
  }
  for (let j = 0; j < k; j++) if (!(x[j] > 0)) x[j] = 0;
  return x;
}

/**
 * Deconvolve a spectrum into one pseudo-Voigt component per prepared library band.
 *
 * Bands are grouped by `order` ('first' / 'second'); each group is fitted in one
 * window spanning its band windows ± `fitDefaults.windowPadCm`, clipped to the
 * data, with a linear local baseline refined during the fit. Bands whose window
 * misses the data are reported in `skipped`. Seeds: x0 = band centre, w =
 * `fwhmSeed`, g = `fitDefaults.gaussianPercentSeed`, heights by non-negative least
 * squares above the local linear baseline. Bounds: x0 within the band window, w
 * within [fwhmMin, fwhmMax], h ≥ 0. A component whose height reaches 0 is refitted
 * with its shape frozen so the rest of the window still gets uncertainties.
 *
 * Missing `fitDefaults` fields fall back to: fwhmMin → the fitter's own lower
 * width bound, fwhmMax → its upper bound, gaussianPercentSeed 50, windowPadCm 100.
 *
 * @param {ArrayLike<number>} x ascending Raman shift, cm⁻¹
 * @param {ArrayLike<number>} y intensity (normally baseline-corrected)
 * @param {object[]} preparedBands PreparedBand objects (id, label, order, center, window, fwhmSeed, …)
 * @param {object} [opts]
 * @param {{fwhmMin?:number, fwhmMax?:number, gaussianPercentSeed?:number, windowPadCm?:number}} [opts.fitDefaults]
 *   the library's fitDefaults block
 * @param {'unit'|'poisson'} [opts.weighting='unit']
 * @param {number} [opts.maxIter=300]
 * @returns {{windows:Array<{lo:number, hi:number, bandIds:string[], stats:object, baseline:object,
 *   residual:{x:Float64Array, r:Float64Array}, worstCorrelation:object|null, undersampled:string[],
 *   insignificant:string[]}>, components:Array<{bandId:string, label:string, x0:number, w:number,
 *   h:number, g:number, area:number, se:{x0:?number, w:?number, h:?number, g:?number},
 *   significant:boolean, windowIndex:number}>, skipped:Array<{bandId:string, reason:string}>,
 *   model:function((number|ArrayLike<number>)):(number|Float64Array)}} Deconvolution. `model(x)`
 *   is NaN outside the fitted windows; given an array it returns a Float64Array. A component is
 *   significant when h > 0, its height uncertainty is known and h ≥ 2σ_h.
 */
export function deconvolve(x, y, preparedBands, { fitDefaults = {}, weighting = 'unit', maxIter = 300 } = {}) {
  if (!x || !y || x.length !== y.length) throw new Error('Deconvolution needs x and y arrays of the same length.');
  const n = x.length;
  const X = Float64Array.from(x), Y = Float64Array.from(y);
  const fd = fitDefaults || {};
  const fwhmMin = isNum(fd.fwhmMin) ? fd.fwhmMin : 0;
  const fwhmMax = isNum(fd.fwhmMax) ? fd.fwhmMax : Infinity;
  const gSeed = isNum(fd.gaussianPercentSeed) ? clamp(fd.gaussianPercentSeed, 0, 100) : 50;
  const padCm = isNum(fd.windowPadCm) ? Math.max(0, fd.windowPadCm) : 100;

  const windows = [], components = [], skipped = [], fitted = [];
  let xmin = Infinity, xmax = -Infinity;
  for (let i = 0; i < n; i++) { if (X[i] < xmin) xmin = X[i]; if (X[i] > xmax) xmax = X[i]; }
  const bands = preparedBands || [];
  const order = new Map(bands.map((b, i) => [b, i]));

  // Which bands have data to fit at all.
  const groups = new Map();
  for (const band of bands) {
    const [wlo, whi] = band.window;
    if (!(n > 0 && whi >= xmin && wlo <= xmax)) {
      skipped.push({ bandId: band.id, reason: n
        ? `window ${fmt(wlo)}–${fmt(whi)} cm⁻¹ lies outside the data (${fmt(xmin)}–${fmt(xmax)} cm⁻¹)`
        : 'no data' });
      continue;
    }
    let inside = 0;
    for (let i = 0; i < n; i++) if (X[i] >= wlo && X[i] <= whi) inside++;
    if (inside < 3) {
      skipped.push({ bandId: band.id, reason: `only ${inside} data point(s) inside the ${fmt(wlo)}–${fmt(whi)} cm⁻¹ window` });
      continue;
    }
    const key = band.order;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(band);
  }

  const plans = [...groups.values()].map(list => {
    let lo = Infinity, hi = -Infinity;
    for (const b of list) { lo = Math.min(lo, b.window[0]); hi = Math.max(hi, b.window[1]); }
    return { list, lo: Math.max(xmin, lo - padCm), hi: Math.min(xmax, hi + padCm) };
  }).sort((a, b) => a.lo - b.lo);

  for (const plan of plans) {
    const { list } = plan;
    const idx = [];
    for (let i = 0; i < n; i++) if (X[i] >= plan.lo && X[i] <= plan.hi) idx.push(i);
    const nw = idx.length;
    // Need comfortably more points than parameters (4 per band + 2 baseline).
    if (nw < 4 * list.length + 5) {
      for (const b of list) skipped.push({ bandId: b.id, reason: `too few data points (${nw}) in the fit window` });
      continue;
    }
    const xs = Float64Array.from(idx, i => X[i]), ys = Float64Array.from(idx, i => Y[i]);
    const xlo = xs[0], xhi = xs[nw - 1];
    const u = Float64Array.from(xs, v => (v - xlo) / ((xhi - xlo) || 1));

    const seeds = list.map(band => {
      const blo = Math.max(band.window[0], xlo), bhi = Math.min(band.window[1], xhi);
      const wRaw = isNum(band.fwhmSeed) && band.fwhmSeed > 0 ? band.fwhmSeed : band.window[1] - band.window[0];
      return {
        band,
        x0: clamp(isNum(band.center) ? band.center : (blo + bhi) / 2, blo, bhi),
        w: clamp(wRaw, fwhmMin, fwhmMax),
        g: gSeed,
        bounds: { x0: [blo, bhi], w: [fwhmMin, fwhmMax], h: [0, Infinity] },
        // A band window that only grazes the data edge leaves no room to move.
        lock: bhi - blo < 1e-9 ? { x0: true } : undefined,
      };
    });

    // Heights by NNLS with the linear baseline projected out, then the baseline
    // from what the seeded components leave.
    const cols = seeds.map(s => Float64Array.from(xs, v => peakY({ x0: s.x0, w: s.w, h: 1, g: s.g }, v)));
    const hs = nnls(cols.map(c => detrend(u, c)), detrend(u, ys));
    const rest = Float64Array.from(ys);
    for (let j = 0; j < cols.length; j++) for (let i = 0; i < nw; i++) rest[i] -= hs[j] * cols[j][i];
    const line = lineFit(u, rest);
    // A small positive floor keeps every component's shape derivatives non-zero
    // at the start; LM is free to take a height back to 0.
    let above = 0, ylo = Infinity, yhi = -Infinity;
    for (let i = 0; i < nw; i++) {
      above = Math.max(above, ys[i] - (line.a + line.b * u[i]));
      ylo = Math.min(ylo, ys[i]); yhi = Math.max(yhi, ys[i]);
    }
    const yspan = Math.abs(yhi - ylo) || 1;
    const hFloor = above > 0 ? 0.01 * above : 1e-6 * yspan;

    const startPeaks = seeds.map((s, j) => {
      const p = { x0: s.x0, w: s.w, h: Math.max(hs[j], hFloor), g: s.g, bounds: s.bounds,
        bandId: s.band.id, label: s.band.label, name: s.band.label };
      if (s.lock) p.lock = s.lock;
      return p;
    });
    const startBaseline = { mode: 'linear', c0: line.a, c1: line.b, c2: 0, fit: true, xMin: xlo, xMax: xhi };
    let res = fitPeaks({ x: xs, y: ys, peaks: startPeaks, baseline: startBaseline, weighting, maxIter });

    // A height pinned at 0 leaves that component's x0/w/g columns exactly zero,
    // which makes JᵀJ singular and would cost every component in the window its
    // uncertainty. Freeze the shape of the vanished ones and refit from here.
    const dead = new Set();
    res.peaks.forEach((p, j) => { if (!(p.h > 1e-9 * yspan)) dead.add(j); });
    if (dead.size) {
      const again = res.peaks.map((p, j) => (dead.has(j)
        ? Object.assign({}, p, { lock: Object.assign({}, p.lock, { x0: true, w: true, g: true }) })
        : p));
      const res2 = fitPeaks({ x: xs, y: ys, peaks: again, baseline: res.baseline, weighting, maxIter });
      res2.stats.iters += res.stats.iters;
      res2.stats.ms += res.stats.ms;
      res = res2;
    }

    const windowIndex = windows.length;
    const ids = res.peaks.map(p => p.bandId);
    windows.push({
      lo: xlo, hi: xhi, bandIds: ids, stats: res.stats, baseline: res.baseline,
      residual: { x: xs, r: res.residual },
      worstCorrelation: res.worstCorrelation,
      undersampled: res.undersampled.map(j => ids[j]),
      insignificant: res.insignificant.map(j => ids[j]),
    });
    fitted.push({ lo: xlo, hi: xhi, peaks: res.peaks, baseline: res.baseline });
    res.peaks.forEach((p, j) => {
      const sh = p.se.h;
      components.push({
        bandId: p.bandId, label: p.label,
        x0: p.x0, w: p.w, h: p.h, g: p.g, area: p.area,
        se: { x0: p.se.x0, w: p.se.w, h: p.se.h, g: p.se.g },
        significant: p.h > 0 && Number.isFinite(sh) && !res.insignificant.includes(j),
        windowIndex,
        _order: order.get(list[j]),
      });
    });
  }

  components.sort((a, b) => a._order - b._order);
  for (const c of components) delete c._order;

  // Overlapping windows (only possible with a very large pad) resolve to the
  // window whose centre is nearest, since each carries its own baseline.
  function model(xv) {
    if (typeof xv !== 'number') return Float64Array.from(xv, v => model(v));
    let best = null, bd = Infinity;
    for (const f of fitted) {
      if (xv >= f.lo && xv <= f.hi) {
        const d = Math.abs(xv - (f.lo + f.hi) / 2);
        if (d < bd) { bd = d; best = f; }
      }
    }
    return best ? evaluateModel(best.peaks, best.baseline, xv) : NaN;
  }

  return { windows, components, skipped, model };
}
