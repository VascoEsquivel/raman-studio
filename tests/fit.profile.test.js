// The profile is PeakForge's WiRE-compatible linear pseudo-Voigt. These tests pin
// the convention so nobody "upgrades" it: the regression number below is the area
// WiRE itself reports for PeakForge's Curve 1.
import { test, assert, assertEqual, assertClose } from './harness.js';
import { FOURLN2, GAREA, LAREA, peakY, peakArea, peakType } from '../js/fit/profile.js';

test('constants match their documented values', () => {
  assertClose(FOURLN2, 2.7725887, 1e-7);
  assertClose(GAREA, 1.0644670, 1e-7);
  assertClose(LAREA, 1.5707963, 1e-7);
});

test('PeakForge regression: Curve 1 area rounds to 225343', () => {
  const curve1 = { x0: 1350.05, w: 44.7659, h: 3317.12, g: 10.5212 };
  assertEqual(Math.round(peakArea(curve1)), 225343);
});

test('peakType boundaries follow WiRE (±0.005 %)', () => {
  const cases = [
    [100, 'Gaussian'], [99.995, 'Gaussian'], [99.9949, 'Mixed'],
    [50, 'Mixed'], [0.0051, 'Mixed'], [0.005, 'Lorentzian'], [0, 'Lorentzian'],
  ];
  for (const [g, want] of cases) assertEqual(peakType({ g }), want, `g = ${g}`);
});

test('every mixture has FWHM = w and apex = h at x0', () => {
  for (const g of [0, 10, 25, 50, 75, 90, 100]) {
    const p = { x0: 1585.3, w: 37.2, h: 812.5, g };
    assertClose(peakY(p, p.x0), p.h, 1e-9 * p.h, `apex g=${g}`);
    assertClose(peakY(p, p.x0 - p.w / 2), p.h / 2, 1e-9 * p.h, `left half-max g=${g}`);
    assertClose(peakY(p, p.x0 + p.w / 2), p.h / 2, 1e-9 * p.h, `right half-max g=${g}`);
    // Inside the FWHM it is above half height, outside below.
    assert(peakY(p, p.x0 + 0.49 * p.w) > p.h / 2, `inside g=${g}`);
    assert(peakY(p, p.x0 + 0.51 * p.w) < p.h / 2, `outside g=${g}`);
  }
});

test('analytic area equals the numerical integral', () => {
  for (const g of [0, 30, 100]) {
    const p = { x0: 500, w: 20, h: 3, g };
    // Simpson over ±R plus the Lorentzian tails beyond, which are analytic:
    // ∫_{|d|>R} 1/(1+4d²/w²) dd = w·(π/2 − atan(2R/w)).
    const R = 200 * p.w, N = 400000, hstep = 2 * R / N;
    let s = peakY(p, p.x0 - R) + peakY(p, p.x0 + R);
    for (let i = 1; i < N; i++) s += (i % 2 ? 4 : 2) * peakY(p, p.x0 - R + i * hstep);
    const core = s * hstep / 3;
    const tail = (1 - g / 100) * p.h * p.w * (Math.PI / 2 - Math.atan(2 * R / p.w));
    assertClose(core + tail, peakArea(p), 1e-6 * peakArea(p), `g=${g}`);
  }
});

test('symmetric about x0 and sign follows h (dip components)', () => {
  const p = { x0: 2753.96, w: 55.1563, h: -742.023, g: 0 };
  for (const d of [1, 10, 40, 200]) assertClose(peakY(p, p.x0 - d), peakY(p, p.x0 + d), 1e-9);
  assert(peakY(p, p.x0) < 0, 'negative height gives a dip');
  assert(peakArea(p) < 0, 'and a negative area');
});
