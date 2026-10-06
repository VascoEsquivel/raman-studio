/* Peak profile mathematics — copied unchanged from PeakForge (Curve-gen).

   Linear pseudo-Voigt, identical to the convention used by Renishaw WiRE:
       y(x) = H · [ m·G(x) + (1-m)·L(x) ],   m = %Gaussian/100
       G = exp(-4ln2 (x-x0)²/w²)      L = 1/(1 + 4(x-x0)²/w²)
   Both components have FWHM = w exactly, so the mixture does too.
   Analytic area:  A = H·w·[ m·√(π/4ln2) + (1-m)·π/2 ]
   Verified against WiRE output to 6 significant figures.

   Do not "improve" this to a true Voigt convolution: numbers coming out of the
   app must stay directly comparable with what the instrument software reports.
   Regression: PeakForge's Curve 1 (x0 1350.05, w 44.7659, h 3317.12, g 10.5212)
   has area 225343. */

/** 4·ln 2 — the Gaussian exponent factor that makes w the FWHM. */
export const FOURLN2 = 4 * Math.LN2;                 // 2.7725887
/** Area of a unit-height Gaussian of FWHM 1: √(π / 4ln2). */
export const GAREA = Math.sqrt(Math.PI / FOURLN2);   // 1.0644670
/** Area of a unit-height Lorentzian of FWHM 1: π / 2. */
export const LAREA = Math.PI / 2;                    // 1.5707963

/**
 * Height of one pseudo-Voigt component at x.
 * @param {{x0:number, w:number, h:number, g:number}} p centre, FWHM, height, % Gaussian
 * @param {number} x
 * @returns {number}
 */
export function peakY(p, x) {
  const w = Math.max(Math.abs(p.w), 1e-9), d = (x - p.x0) / w, dd = d * d, m = p.g / 100;
  return p.h * (m * Math.exp(-FOURLN2 * dd) + (1 - m) / (1 + 4 * dd));
}

/**
 * Analytic area of one component.
 * @param {{w:number, h:number, g:number}} p
 * @returns {number}
 */
export function peakArea(p) { const m = p.g / 100; return p.h * p.w * (m * GAREA + (1 - m) * LAREA); }

/**
 * 'Gaussian' | 'Lorentzian' | 'Mixed', resolved from % Gaussian as WiRE does.
 * @param {{g:number}} p
 * @returns {string}
 */
export function peakType(p) { return p.g >= 99.995 ? 'Gaussian' : p.g <= 0.005 ? 'Lorentzian' : 'Mixed'; }
