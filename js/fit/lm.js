/* Levenberg–Marquardt peak fitter — PeakForge's runFit (Curve-gen), with the
   global `state` taken out so it can run on any spectrum, window or worker.

   The algorithm is deliberately unchanged from PeakForge, which was validated by
   randomised round-trip testing (see its README). Every constant below — the
   per-parameter scales, the default bounds, the 1e-4 difference step, the λ
   schedule — is PeakForge's. Two additions, both opt-in per peak:
     · `bounds` intersect the default bounds (deconvolution keeps centres inside
       their band window and heights ≥ 0);
     · `lock` freezes a parameter, exactly like PeakForge's C/W/H/G "fix" column.
   Starting values are clamped into their bounds before the first iteration.
   PeakForge did the same implicitly on its first accepted or rejected step; doing
   it up front keeps χ² consistent with the parameters it was computed from. */

import { peakY, peakArea } from './profile.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

const BASELINE_MODES = ['none', 'const', 'linear', 'quad'];
const PEAK_KEYS = ['x0', 'w', 'h', 'g'];

// performance.now is a plain global in browsers and workers; Date.now keeps the
// module usable in any other JS host. Timing is informational only.
function now() {
  const p = globalThis.performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

/**
 * Robust noise level straight from the data: the median absolute successive
 * difference, scaled to a Gaussian σ. Signal slope inflates individual
 * differences but not the median, so this tracks the detector noise floor and
 * gives a goodness-of-fit yardstick that does not depend on the weighting choice.
 * @param {ArrayLike<number>} y intensities
 * @returns {number} σ estimate (0 for fewer than 4 points)
 */
export function estimateNoise(y) {
  const n = y.length;
  if (n < 4) return 0;
  const df = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) df[i - 1] = Math.abs(y[i] - y[i - 1]);
  df.sort();
  return (df[Math.floor(df.length / 2)] || 0) / (0.6745 * Math.SQRT2);
}

/**
 * Goodness of fit measured against the LOCAL noise level, window by window.
 * A single global σ fails on shot noise, where σ grows with intensity: the
 * median successive difference samples mostly baseline, underestimates the noise
 * under the peaks and inflates the ratio (in PeakForge's testing that mislabelled
 * the four most accurate fits in 100 as "poor"). Comparing each window's residual
 * to that window's own noise removes the bias, and the worst window points at
 * whatever the model is failing to describe.
 * ~1 means the residual is pure noise; < 1.15 noise floor, < 1.6 good, < 3
 * under-fitted, ≥ 3 the model does not describe the data.
 * @param {ArrayLike<number>} x abscissae
 * @param {ArrayLike<number>} y data
 * @param {ArrayLike<number>|function(number):number} model model values at each x, or a function of x
 * @returns {{med:number, worst:number, worstAt:number}} median and worst window ratio, and the
 *   centre of the worst window; all NaN when there are fewer than 40 points
 */
export function fitQuality(x, y, model) {
  const none = { med: NaN, worst: NaN, worstAt: NaN };
  const n = x.length;
  if (n < 40) return none;
  const at = typeof model === 'function' ? i => model(x[i]) : i => model[i];
  const K = Math.min(24, Math.max(4, Math.floor(n / 40)));
  const rs = [];
  let worst = -1, worstAt = NaN;
  for (let k = 0; k < K; k++) {
    const a = Math.floor(n * k / K), b = Math.floor(n * (k + 1) / K);
    if (b - a < 8) continue;
    const df = new Float64Array(b - a - 1);
    for (let i = a + 1; i < b; i++) df[i - a - 1] = Math.abs(y[i] - y[i - 1]);
    df.sort();
    const sg = (df[Math.floor(df.length / 2)] || 0) / (0.6745 * Math.SQRT2);
    if (!(sg > 0)) continue;
    let ss = 0, c = 0;
    for (let i = a; i < b; i++) { const r = y[i] - at(i); ss += r * r; c++; }
    const ratio = Math.sqrt(ss / c) / sg;
    rs.push(ratio);
    if (ratio > worst) { worst = ratio; worstAt = (x[a] + x[b - 1]) / 2; }
  }
  if (!rs.length) return none;
  rs.sort((p, q) => p - q);
  return { med: rs[Math.floor((rs.length - 1) / 2)], worst, worstAt };
}

// Baseline over the normalised window u = (x − xMin)/(xMax − xMin), as in
// PeakForge, so c1 and c2 read as "counts across the window" and stay well
// conditioned whatever the x offset.
function baseAt(b, x) {
  if (b.mode === 'none') return 0;
  const u = (x - b.xMin) / ((b.xMax - b.xMin) || 1);
  if (b.mode === 'const') return b.c0;
  if (b.mode === 'linear') return b.c0 + b.c1 * u;
  return b.c0 + b.c1 * u + b.c2 * u * u;
}

function normBaseline(baseline, xlo, xhi) {
  const b = Object.assign({}, baseline || {});
  if (b.mode === undefined || b.mode === null) b.mode = 'none';
  if (!BASELINE_MODES.includes(b.mode)) {
    throw new Error(`Unknown baseline mode "${b.mode}" (expected none, const, linear or quad).`);
  }
  for (const k of ['c0', 'c1', 'c2']) b[k] = isNum(b[k]) ? b[k] : 0;
  b.fit = !!b.fit;
  if (!isNum(b.xMin)) b.xMin = xlo;
  if (!isNum(b.xMax)) b.xMax = xhi;
  return b;
}

/**
 * Evaluate the model (baseline + every component) at x.
 * Missing baseline coefficients count as 0; a missing xMin/xMax defaults to the
 * range of x (for a single number, u is then 0).
 * @param {Array<{x0:number, w:number, h:number, g:number}>} peaks components
 * @param {{mode?:string, c0?:number, c1?:number, c2?:number, xMin?:number, xMax?:number}|null} baseline
 * @param {ArrayLike<number>|number} x abscissae, or a single abscissa
 * @returns {Float64Array|number} model values (a number when x is a number)
 */
export function evaluateModel(peaks, baseline, x) {
  const list = peaks || [];
  if (typeof x === 'number') {
    const b = normBaseline(baseline, x, x);
    let s = baseAt(b, x);
    for (const p of list) s += peakY(p, x);
    return s;
  }
  const n = x.length, out = new Float64Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; }
  const b = normBaseline(baseline, lo, hi);
  for (let i = 0; i < n; i++) {
    let s = baseAt(b, x[i]);
    for (const p of list) s += peakY(p, x[i]);
    out[i] = s;
  }
  return out;
}

// Gaussian elimination with partial pivoting (PeakForge's). Returns null for a
// singular system so the caller can raise λ instead of taking a garbage step.
function solve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (Math.abs(A[piv * n + c]) < 1e-14) return null;
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

// Gauss–Jordan inverse (PeakForge's); null when singular.
function invert(A, n) {
  const n2 = 2 * n, M = new Float64Array(n * n2);
  for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) M[r * n2 + c] = A[r * n + c]; M[r * n2 + n + r] = 1; }
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n2 + c]) > Math.abs(M[piv * n2 + c])) piv = r;
    if (Math.abs(M[piv * n2 + c]) < 1e-30) return null;
    if (piv !== c) for (let k = 0; k < n2; k++) { const t = M[c * n2 + k]; M[c * n2 + k] = M[piv * n2 + k]; M[piv * n2 + k] = t; }
    const d = M[c * n2 + c];
    for (let k = 0; k < n2; k++) M[c * n2 + k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r * n2 + c];
      if (!f) continue;
      for (let k = 0; k < n2; k++) M[r * n2 + k] -= f * M[c * n2 + k];
    }
  }
  const I = new Float64Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) I[r * n + c] = M[r * n2 + n + c];
  return I;
}

// Explicit per-peak bounds narrow the defaults. If they don't overlap at all the
// caller's bounds win: they encode knowledge (a band window, a known width) that
// the generic data-derived defaults cannot.
function intersect(lo, hi, user) {
  if (!user) return [lo, hi];
  const ulo = isNum(user[0]) || user[0] === -Infinity ? user[0] : -Infinity;
  const uhi = isNum(user[1]) || user[1] === Infinity ? user[1] : Infinity;
  const a = Math.max(lo, ulo), b = Math.min(hi, uhi);
  if (a <= b) return [a, b];
  return ulo <= uhi ? [ulo, uhi] : [lo, hi];
}

/**
 * Fit pseudo-Voigt components (and optionally a polynomial baseline) to data by
 * PeakForge's Levenberg–Marquardt.
 *
 * Default bounds: x0 ∈ [xlo − 5 %, xhi + 5 %] of the data span, w ∈ [max(2·dx,
 * span·2e-4), 3·span], g ∈ [0, 100], h unbounded (dips allowed). Per-peak
 * `bounds` intersect these; `lock` keys freeze parameters.
 *
 * @param {object} args
 * @param {ArrayLike<number>} args.x abscissae (ascending)
 * @param {ArrayLike<number>} args.y data
 * @param {Array<{x0:number, w:number, h:number, g:number,
 *   lock?:{x0?:boolean, w?:boolean, h?:boolean, g?:boolean},
 *   bounds?:{x0?:number[], w?:number[], h?:number[], g?:number[]}}>} args.peaks starting
 *   components; any extra fields are passed through to the result
 * @param {{mode:'none'|'const'|'linear'|'quad', c0?:number, c1?:number, c2?:number,
 *   fit?:boolean, xMin?:number, xMax?:number}} [args.baseline] baseline over
 *   u = (x − xMin)/(xMax − xMin); xMin/xMax default to the data range
 * @param {'unit'|'poisson'} [args.weighting='unit'] residual weights: 1, or 1/√max(|y|, 1)
 * @param {number} [args.maxIter=200] iteration cap (at least 5)
 * @returns {{peaks:object[], baseline:object, stats:{chiRed:number, r2:number, rmse:number,
 *   sigma:number, quality:number, qualityWorst:number, qualityAt:number, iters:number,
 *   ms:number, npar:number, n:number, conv:string}, worstCorrelation:({rho:number, a:string,
 *   b:string}|null), undersampled:number[], insignificant:number[], residual:Float64Array,
 *   covariance:({params:Array<{peak:number, k:string}>, matrix:Float64Array}|null)}}
 *   FitResult. Each peak copy carries the fitted x0/w/h/g, `se` {x0, w, h, g} (a field is
 *   null when that parameter is locked or the covariance matrix is singular) and `area`.
 *   The baseline copy carries `se` {c0, c1, c2} the same way. `covariance` is χ²ᵣ·(JᵀJ)⁻¹
 *   over the free parameters (row-major, m × m; `peak` is −1 for baseline terms), null when
 *   singular; its diagonal square roots are the `se` values.
 */
export function fitPeaks({ x, y, peaks = [], baseline, weighting = 'unit', maxIter = 200 } = {}) {
  if (!x || !y || x.length !== y.length) throw new Error('Fit needs x and y arrays of the same length.');
  const n = x.length;
  if (n < 2) throw new Error('Fit needs at least two data points.');
  if (weighting !== 'unit' && weighting !== 'poisson') {
    throw new Error(`Unknown weighting "${weighting}" (expected unit or poisson).`);
  }
  const X = Float64Array.from(x), Y = Float64Array.from(y);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(X[i]) || !Number.isFinite(Y[i])) throw new Error('Fit data contain non-finite values.');
  }

  // Data-derived references, exactly as PeakForge's paramRefs() derived them
  // from the imported data.
  const xlo = Math.min(X[0], X[n - 1]), xhi = Math.max(X[0], X[n - 1]);
  const span = Math.abs(xhi - xlo) || 1;
  const dx = Math.abs(xhi - xlo) / (n - 1) || span / 1000;
  const pad = (xhi - xlo) * 0.05;
  const wmin = Math.max(dx * 2, span * 2e-4), wmax = span * 3;
  let ylo = Infinity, yhi = -Infinity;
  for (let i = 0; i < n; i++) { if (Y[i] < ylo) ylo = Y[i]; if (Y[i] > yhi) yhi = Y[i]; }
  const yspan = Math.abs(yhi - ylo) || 1;

  const ps = (peaks || []).map((p, i) => {
    const q = Object.assign({}, p);
    for (const k of PEAK_KEYS) {
      q[k] = +p[k];
      if (!Number.isFinite(q[k])) throw new Error(`Peak ${i + 1}: starting ${k} is not a finite number.`);
    }
    return q;
  });
  const bl = normBaseline(baseline, xlo, xhi);

  /* Parameter vector with bounds and a characteristic scale per entry. The scale
     sets the finite-difference step (so the Jacobian is well conditioned even for
     parameters near zero, like %Gaussian) and caps how far one LM step may move
     the parameter. Without that cap a poor starting guess lets a component
     collapse to zero width or run out of the window and never come back.
     Order (x0, h, w, g per peak, then c0, c1, c2) is PeakForge's: the step clamp
     reads each scale just before setting that parameter, so x0's scale must see
     the old width. */
  const P = [];
  ps.forEach((p, i) => {
    const lock = p.lock || {}, ub = p.bounds || {};
    const add = (k, lo, hi, sc) => {
      if (lock[k]) return;
      const [a, b] = intersect(lo, hi, ub[k]);
      P.push({ o: p, k, lo: a, hi: b, sc, peak: i });
    };
    add('x0', xlo - pad, xhi + pad, () => Math.max(p.w * 0.35, dx * 2));
    add('h', -Infinity, Infinity, () => Math.max(Math.abs(p.h) * 0.45, yspan * 0.02));
    add('w', wmin, wmax, () => Math.max(p.w * 0.4, dx * 2));
    add('g', 0, 100, () => 18);
  });
  if (bl.fit && bl.mode !== 'none') {
    const bs = () => Math.max(yspan * 0.25, 1e-6);
    P.push({ o: bl, k: 'c0', lo: -Infinity, hi: Infinity, sc: bs, peak: -1 });
    if (bl.mode !== 'const') P.push({ o: bl, k: 'c1', lo: -Infinity, hi: Infinity, sc: bs, peak: -1 });
    if (bl.mode === 'quad') P.push({ o: bl, k: 'c2', lo: -Infinity, hi: Infinity, sc: bs, peak: -1 });
  }
  for (const pr of P) pr.o[pr.k] = clamp(pr.o[pr.k], pr.lo, pr.hi);
  const m = P.length;

  const modelAt = xv => {
    let s = baseAt(bl, xv);
    for (let i = 0; i < ps.length; i++) s += peakY(ps[i], xv);
    return s;
  };
  const W = new Float64Array(n);
  for (let i = 0; i < n; i++) W[i] = weighting === 'unit' ? 1 : 1 / Math.sqrt(Math.max(Math.abs(Y[i]), 1));
  const sse = () => {
    let s = 0;
    for (let i = 0; i < n; i++) { const r = (Y[i] - modelAt(X[i])) * W[i]; s += r * r; }
    return s;
  };

  /* Jacobian of the weighted residual. A peak parameter only changes THAT peak's
     contribution, so its column is built as base − oldPeak + newPeak instead of
     re-summing every component (~5× less arithmetic with 10 components). The
     difference step is taken INWARD at a bound: a forward step from %Gaussian =
     100 clamps straight back to 100, giving a zero derivative and pinning pure
     Gaussian or pure Lorentzian peaks there forever. */
  const base = new Float64Array(n), old = new Float64Array(n);
  const buildJacobian = (J, r) => {
    for (let i = 0; i < n; i++) { base[i] = modelAt(X[i]); r[i] = (Y[i] - base[i]) * W[i]; }
    for (let j = 0; j < m; j++) {
      const pr = P[j], o = pr.o, k = pr.k, v0 = o[k];
      let step = Math.max(pr.sc() * 1e-4, 1e-9);
      if (v0 + step > pr.hi) step = -step;
      if (v0 + step < pr.lo) step = Math.abs(step);
      const isPeak = pr.peak >= 0;
      if (isPeak) for (let i = 0; i < n; i++) old[i] = peakY(o, X[i]);
      o[k] = v0 + step;
      if (isPeak) {
        for (let i = 0; i < n; i++) J[i * m + j] = ((Y[i] - (base[i] - old[i] + peakY(o, X[i]))) * W[i] - r[i]) / step;
      } else {
        for (let i = 0; i < n; i++) J[i * m + j] = ((Y[i] - modelAt(X[i])) * W[i] - r[i]) / step;
      }
      o[k] = v0;
    }
  };
  const normalMatrix = J => {
    const A = new Float64Array(m * m);
    for (let j = 0; j < m; j++) {
      for (let k = j; k < m; k++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += J[i * m + j] * J[i * m + k];
        A[j * m + k] = s; A[k * m + j] = s;
      }
    }
    return A;
  };

  const get = j => P[j].o[P[j].k];
  const set = (j, v) => { P[j].o[P[j].k] = clamp(v, P[j].lo, P[j].hi); };
  const iterCap = Math.max(5, maxIter | 0);
  let lam = 1e-3, chi = sse(), it = 0, conv = '', prev = Infinity;
  const t0 = now();
  if (!m) {
    conv = 'no free parameters';
  } else {
    const J = new Float64Array(n * m), r = new Float64Array(n);
    for (; it < iterCap; it++) {
      prev = chi;
      buildJacobian(J, r);
      const A = normalMatrix(J), b = new Float64Array(m);
      for (let j = 0; j < m; j++) {
        let bj = 0;
        for (let i = 0; i < n; i++) bj += J[i * m + j] * r[i];
        b[j] = -bj;
      }
      let ok = false;
      for (let tries = 0; tries < 12 && !ok; tries++) {
        const Ad = Float64Array.from(A), bd = Float64Array.from(b);
        for (let j = 0; j < m; j++) Ad[j * m + j] += lam * (A[j * m + j] || 1);
        const d = solve(Ad, bd, m);
        if (!d) { lam *= 8; continue; }
        // d solves (JᵀJ + λ·diag)·d = −Jᵀr, so the step is ADDED. Each component is
        // limited to one characteristic scale so a bad linearisation cannot throw
        // a component out of the window.
        const prevVals = P.map((_, j) => get(j));
        for (let j = 0; j < m; j++) { const s = P[j].sc(); set(j, prevVals[j] + clamp(d[j], -s, s)); }
        const nc = sse();
        if (Number.isFinite(nc) && nc < chi) { chi = nc; lam = Math.max(lam / 4, 1e-9); ok = true; }
        else { for (let j = 0; j < m; j++) set(j, prevVals[j]); lam *= 8; }
      }
      if (!ok) { conv = 'converged (no further improvement)'; break; }
      if (Math.abs(prev - chi) <= 1e-12 * Math.max(chi, 1e-300)) { it++; conv = 'converged (χ² stationary)'; break; }
      if (lam > 1e12) { conv = 'stopped (damping limit)'; break; }
    }
    if (!conv) conv = `stopped at iteration limit (${iterCap})`;
  }
  const ms = now() - t0;

  // Statistics (PeakForge's computeStats).
  const model = new Float64Array(n), residual = new Float64Array(n);
  for (let i = 0; i < n; i++) { model[i] = modelAt(X[i]); residual[i] = Y[i] - model[i]; }
  const dof = Math.max(1, n - m);
  let chi2 = 0, ssr = 0, sst = 0, mean = 0;
  for (let i = 0; i < n; i++) mean += Y[i];
  mean /= n;
  for (let i = 0; i < n; i++) {
    const d = residual[i];
    chi2 += d * d * W[i] * W[i]; ssr += d * d; sst += (Y[i] - mean) * (Y[i] - mean);
  }
  const fq = fitQuality(X, Y, model);
  const stats = {
    chiRed: chi2 / dof, r2: 1 - ssr / (sst || 1), rmse: Math.sqrt(ssr / n), sigma: estimateNoise(Y),
    quality: fq.med, qualityWorst: fq.worst, qualityAt: fq.worstAt,
    iters: it, ms, npar: m, n, conv,
  };

  /* Standard errors from C = χ²ᵣ·(JᵀJ)⁻¹. A component that is degenerate with its
     neighbour gets a huge σ — the honest signal that the envelope does not
     constrain it. */
  const se = ps.map(() => ({ x0: null, w: null, h: null, g: null }));
  const blSe = { c0: null, c1: null, c2: null };
  let worstCorrelation = null, covariance = null;
  if (m) {
    const J = new Float64Array(n * m), r = new Float64Array(n);
    buildJacobian(J, r);
    const C = invert(normalMatrix(J), m);
    if (C) {
      const s2 = Math.max(stats.chiRed, 1e-12);
      covariance = { params: P.map(pr => ({ peak: pr.peak, k: pr.k })), matrix: Float64Array.from(C, v => v * s2) };
      const name = pr => (pr.peak < 0 ? 'baseline'
        : String(pr.o.name || pr.o.label || pr.o.bandId || `peak ${pr.peak + 1}`)) + '.' + pr.k;
      for (let j = 0; j < m; j++) {
        const sig = Math.sqrt(Math.max(C[j * m + j], 0) * Math.max(stats.chiRed, 1e-12));
        if (P[j].peak >= 0) se[P[j].peak][P[j].k] = sig; else blSe[P[j].k] = sig;
      }
      for (let j = 0; j < m; j++) {
        for (let k = j + 1; k < m; k++) {
          const den = Math.sqrt(C[j * m + j] * C[k * m + k]);
          if (!(den > 0)) continue;
          const rho = C[j * m + k] / den;
          if (!worstCorrelation || Math.abs(rho) > Math.abs(worstCorrelation.rho)) {
            worstCorrelation = { rho, a: name(P[j]), b: name(P[k]) };
          }
        }
      }
    }
  }

  // Fewer than 4 points across the FWHM: width and height are not trustworthy.
  const meanDx = n > 1 ? Math.abs(X[n - 1] - X[0]) / (n - 1) : 0;
  const undersampled = [], insignificant = [];
  ps.forEach((p, i) => {
    if (meanDx > 0 && p.w / meanDx < 4) undersampled.push(i);
    // Height within 2σ of zero: the component may not be real.
    if (Number.isFinite(se[i].h) && Math.abs(p.h) < 2 * se[i].h) insignificant.push(i);
  });

  const outPeaks = ps.map((p, i) => Object.assign(p, { se: se[i], area: peakArea(p) }));
  return {
    peaks: outPeaks,
    baseline: Object.assign(bl, { se: blSe }),
    stats,
    worstCorrelation,
    undersampled,
    insignificant,
    residual,
    covariance,
  };
}
