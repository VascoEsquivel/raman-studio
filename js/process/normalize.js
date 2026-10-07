/* Intensity normalisation. Ratios are scale-free, so normalising never
   changes I_D/I_G etc.; it only makes spectra comparable on one plot. */

/**
 * Divide y by a reference value.
 * @param {ArrayLike<number>} x ascending
 * @param {ArrayLike<number>} y
 * @param {{mode?:'none'|'max'|'band'|'area', window?:[number,number]|null}} [opts]
 *   band: maximum inside `window` (e.g. the G band); area: trapezoid ∫ y dx
 * @returns {{y:Float64Array, factor:number, ref:string, warning?:string}}
 */
export function normalize(x, y, { mode = 'none', window = null } = {}) {
  const n = y.length;
  const result = (factor, ref, warning) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = y[i] / factor;
    return warning ? { y: out, factor, ref, warning } : { y: out, factor, ref };
  };
  if (mode === 'none' || !n) return { y: Float64Array.from(y), factor: 1, ref: 'none' };
  const maxOf = (a, b) => { let m = -Infinity; for (let i = a; i < b; i++) if (y[i] > m) m = y[i]; return m; };
  const byMax = warning => {
    const m = maxOf(0, n);
    return m > 0 && isFinite(m) ? result(m, 'max', warning) : { y: Float64Array.from(y), factor: 1, ref: 'none', warning: 'Spectrum has no positive maximum; not normalised.' };
  };
  if (mode === 'max') return byMax();
  if (mode === 'band') {
    if (!window || !(window[1] >= window[0])) return byMax('No band window available; normalised to the maximum instead.');
    let m = -Infinity, any = false;
    for (let i = 0; i < n; i++) if (x[i] >= window[0] && x[i] <= window[1]) { any = true; if (y[i] > m) m = y[i]; }
    if (!any) return byMax(`No data inside the band window (${Math.round(window[0])}–${Math.round(window[1])} cm⁻¹); normalised to the maximum instead.`);
    if (!(m > 0)) return byMax('Band maximum is not positive; normalised to the maximum instead.');
    return result(m, 'band');
  }
  if (mode === 'area') {
    let a = 0;
    for (let i = 1; i < n; i++) a += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
    if (!(a > 0)) return byMax('Integrated area is not positive; normalised to the maximum instead.');
    return result(a, 'area');
  }
  throw new Error(`Unknown normalisation mode "${mode}"`);
}
