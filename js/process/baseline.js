/* Baseline estimation.

   Polynomial options mirror PeakForge (constant / linear / quadratic) but are
   fitted as a *modified polyfit* (Lieber & Mahadevan-Jansen 2003): fit, clip
   the working data down to the fit wherever the data lies above it, refit,
   repeat. Peaks are progressively shaved off, so they no longer lift the
   baseline the way an ordinary least-squares fit would. x is normalised to
   u = (x − xmin)/(xmax − xmin) as in PeakForge, which keeps the normal
   equations well conditioned at any wavenumber offset.

   Asymmetric least squares (Eilers & Boelens 2005) follows curved
   fluorescence backgrounds: minimise Σ wᵢ(yᵢ − zᵢ)² + λ Σ(Δ²z)², with small
   weight p above the baseline and 1 − p below it. The system matrix
   W + λDᵀD is symmetric pentadiagonal, solved here by banded Cholesky in O(n). */

export const BASELINE_METHODS = ['none', 'constant', 'linear', 'quadratic', 'als'];
const ORDER = { constant: 0, linear: 1, quadratic: 2 };

/**
 * Modified-polyfit baseline.
 * @param {ArrayLike<number>} x ascending
 * @param {ArrayLike<number>} y
 * @param {{order?:number, maxIter?:number, tol?:number}} [opts] order 0–2
 * @returns {Float64Array}
 */
export function baselinePoly(x, y, { order = 2, maxIter = 100, tol = 1e-3 } = {}) {
  const n = y.length;
  const k = Math.max(0, Math.min(2, Math.round(order)));
  if (n === 0) return new Float64Array(0);
  const x0 = x[0], span = (x[n - 1] - x[0]) || 1;
  const u = new Float64Array(n);
  for (let i = 0; i < n; i++) u[i] = (x[i] - x0) / span;
  let w = Float64Array.from(y);
  let fit = polyFitEval(u, w, Math.min(k, n - 1));
  for (let it = 0; it < maxIter; it++) {
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.min(w[i], fit[i]);
      num += (v - w[i]) ** 2; den += w[i] * w[i];
      w[i] = v;
    }
    fit = polyFitEval(u, w, Math.min(k, n - 1));
    if (Math.sqrt(num / (den || 1)) < tol) break;
  }
  return fit;
}

/** Least-squares polynomial of degree k evaluated at u. */
function polyFitEval(u, y, k) {
  const m = k + 1, n = u.length;
  const A = new Float64Array(m * m), b = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    let p = 1;
    const pw = [];
    for (let j = 0; j < 2 * m - 1; j++) { pw.push(p); p *= u[i]; }
    for (let r = 0; r < m; r++) {
      b[r] += pw[r] * y[i];
      for (let c = 0; c < m; c++) A[r * m + c] += pw[r + c];
    }
  }
  const c = solve(A, b, m) || new Float64Array(m).fill(0).map((_, j) => (j === 0 ? mean(y) : 0));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { let v = 0, p = 1; for (let j = 0; j < m; j++) { v += c[j] * p; p *= u[i]; } out[i] = v; }
  return out;
}

function mean(a) { let s = 0; for (const v of a) s += v; return s / (a.length || 1); }

function solve(A, b, n) {
  A = Float64Array.from(A); b = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (Math.abs(A[piv * n + c]) < 1e-300) return null;
    if (piv !== c) { for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; } const t = b[c]; b[c] = b[piv]; b[piv] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const s = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let v = b[r]; for (let k = r + 1; k < n; k++) v -= A[r * n + k] * s[k]; s[r] = v / A[r * n + r]; }
  return s;
}

/**
 * Asymmetric least squares baseline.
 * @param {ArrayLike<number>} y
 * @param {{lambda?:number, p?:number, maxIter?:number}} [opts] λ: stiffness; p: weight of points above the baseline
 * @returns {Float64Array}
 */
export function baselineALS(y, { lambda = 1e5, p = 0.01, maxIter = 10 } = {}) {
  const n = y.length;
  if (n < 3) return Float64Array.from(y);
  // λ·DᵀD for the second-difference operator, built row by row so any n ≥ 3 works
  const D0 = new Float64Array(n), D1 = new Float64Array(n), D2 = new Float64Array(n);
  for (let r = 0; r < n - 2; r++) {
    D0[r] += 1; D0[r + 1] += 4; D0[r + 2] += 1;
    D1[r] += -2; D1[r + 1] += -2;
    D2[r] += 1;
  }
  const w = new Float64Array(n).fill(1);
  const z = new Float64Array(n);
  const l0 = new Float64Array(n), l1 = new Float64Array(n), l2 = new Float64Array(n), v = new Float64Array(n);
  for (let it = 0; it < maxIter; it++) {
    // banded Cholesky of A = W + λDᵀD: l1[i] = L(i,i−1), l2[i] = L(i,i−2)
    for (let i = 0; i < n; i++) {
      const a20 = i >= 2 ? lambda * D2[i - 2] : 0;
      const a10 = i >= 1 ? lambda * D1[i - 1] : 0;
      l2[i] = i >= 2 ? a20 / l0[i - 2] : 0;
      l1[i] = i >= 1 ? (a10 - l2[i] * (i >= 2 ? l1[i - 1] : 0)) / l0[i - 1] : 0;
      const d = w[i] + lambda * D0[i] - l1[i] * l1[i] - l2[i] * l2[i];
      l0[i] = Math.sqrt(Math.max(d, 1e-300));
    }
    for (let i = 0; i < n; i++) v[i] = (w[i] * y[i] - (i >= 1 ? l1[i] * v[i - 1] : 0) - (i >= 2 ? l2[i] * v[i - 2] : 0)) / l0[i];
    for (let i = n - 1; i >= 0; i--) z[i] = (v[i] - (i + 1 < n ? l1[i + 1] * z[i + 1] : 0) - (i + 2 < n ? l2[i + 2] * z[i + 2] : 0)) / l0[i];
    let changed = 0;
    for (let i = 0; i < n; i++) {
      const nw = y[i] > z[i] ? p : 1 - p;
      if (nw !== w[i]) { w[i] = nw; changed++; }
    }
    if (!changed) break;
  }
  return z;
}

/**
 * Baseline by method name; null for 'none'.
 * @param {ArrayLike<number>} x
 * @param {ArrayLike<number>} y
 * @param {{method:string, lambda?:number, p?:number}} opts
 * @returns {Float64Array|null}
 */
export function computeBaseline(x, y, { method = 'als', lambda = 1e5, p = 0.01 } = {}) {
  if (method === 'none' || !y || !y.length) return null;
  if (method === 'als') return baselineALS(y, { lambda, p });
  if (method in ORDER) return baselinePoly(x, y, { order: ORDER[method] });
  throw new Error(`Unknown baseline method "${method}"`);
}
