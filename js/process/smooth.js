/* Savitzky–Golay smoothing.

   Coefficients come from the least-squares polynomial fit over the window
   (the same construction as scipy.signal.savgol_coeffs, 'dot' order: the
   value at i is Σ c[k]·y[i − h + k]). Edges follow scipy's mode='interp': a
   polynomial of the same order is fitted to the first / last full window and
   evaluated there, so the ends are not padded with invented data. */

/**
 * Savitzky–Golay coefficients for the centre point.
 * @param {number} window odd window length
 * @param {number} order polynomial order (< window)
 * @param {number} [deriv=0] derivative order (per sample)
 * @returns {Float64Array} 'dot' order coefficients
 */
export function sgCoefficients(window, order, deriv = 0) {
  if (window % 2 !== 1 || window < 1) throw new Error('Savitzky–Golay window must be odd');
  if (order >= window) throw new Error('Savitzky–Golay order must be less than the window');
  const h = (window - 1) / 2, m = order + 1;
  const out = new Float64Array(window);
  if (deriv > order) return out;
  // Solve (AᵀA) c = e_deriv, then coefficient_k = Σ_j c_j t_k^j · deriv!
  const AtA = new Float64Array(m * m);
  for (let t = -h; t <= h; t++) for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) AtA[r * m + c] += t ** (r + c);
  const e = new Float64Array(m); e[deriv] = 1;
  const c = solveSmall(AtA, e, m);
  let fact = 1; for (let k = 2; k <= deriv; k++) fact *= k;
  for (let k = 0; k < window; k++) {
    const t = k - h;
    let v = 0;
    for (let j = 0; j < m; j++) v += c[j] * t ** j;
    out[k] = v * fact;
  }
  return out;
}

/**
 * Savitzky–Golay filter with scipy mode='interp' edges.
 * @param {ArrayLike<number>} y
 * @param {{window?:number, order?:number, deriv?:number}} [opts]
 * @returns {Float64Array}
 */
export function savitzkyGolay(y, { window = 11, order = 3, deriv = 0 } = {}) {
  const n = y.length;
  let w = Math.round(window);
  if (w % 2 === 0) w += 1;
  if (w > n) w = n % 2 ? n : n - 1;
  let ord = Math.min(Math.round(order), w - 1);
  if (w < 3 || ord < 0) return Float64Array.from(y);
  const h = (w - 1) / 2;
  const c = sgCoefficients(w, ord, deriv);
  const out = new Float64Array(n);
  for (let i = h; i < n - h; i++) {
    let v = 0;
    for (let k = 0; k < w; k++) v += c[k] * y[i - h + k];
    out[i] = v;
  }
  edgeFit(y, out, 0, w, ord, deriv, 0, h);
  edgeFit(y, out, n - w, w, ord, deriv, n - h, n);
  return out;
}

/** Fit a polynomial to y[start..start+w) and evaluate (or differentiate) it at [from, to). */
function edgeFit(y, out, start, w, ord, deriv, from, to) {
  const h = (w - 1) / 2, m = ord + 1;
  const AtA = new Float64Array(m * m), Atb = new Float64Array(m);
  for (let k = 0; k < w; k++) {
    const t = (k - h) / h;                 // scaled to [−1, 1] for conditioning
    for (let r = 0; r < m; r++) {
      Atb[r] += t ** r * y[start + k];
      for (let c = 0; c < m; c++) AtA[r * m + c] += t ** (r + c);
    }
  }
  const coef = solveSmall(AtA, Atb, m);
  for (let i = from; i < to; i++) {
    const t = (i - start - h) / h;
    let v = 0;
    for (let j = deriv; j < m; j++) {
      let f = 1; for (let q = 0; q < deriv; q++) f *= (j - q);
      v += coef[j] * f * t ** (j - deriv);
    }
    out[i] = v / h ** deriv;
  }
}

function solveSmall(A, b, n) {
  A = Float64Array.from(A); b = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (piv !== c) { for (let k = 0; k < n; k++) { const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t; } const t = b[c]; b[c] = b[piv]; b[piv] = t; }
    const d = A[c * n + c] || 1e-300;
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const s = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) { let v = b[r]; for (let k = r + 1; k < n; k++) v -= A[r * n + k] * s[k]; s[r] = v / (A[r * n + r] || 1e-300); }
  return s;
}
