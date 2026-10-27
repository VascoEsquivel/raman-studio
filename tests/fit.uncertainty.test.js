// Ratio uncertainties from the fit covariance. The Monte Carlo test is the one
// that matters: the propagated 1σ must match the scatter of the ratio over
// repeated noise draws of the same synthetic spectrum. Band shapes, heights and
// noise levels here are arbitrary synthetic choices.
import { test, assert, assertEqual, assertClose, rng, gauss } from './harness.js';
import { fitPeaks } from '../js/fit/lm.js';
import { deconvolve } from '../js/fit/deconvolve.js';
import { peakY, peakArea } from '../js/fit/profile.js';
import { ratioUncertainty, covarianceOf } from '../js/fit/uncertainty.js';
import { prepareLibrary } from '../js/match/library.js';
import { computeRatios } from '../js/analysis/ratios.js';
import { fmtPm } from '../js/ui/dom.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();

const X = Float64Array.from({ length: 701 }, (_, i) => 1100 + i);
// A, B and an overlapping shoulder C on B's high side (the G / D′ situation)
const TRUTH = [
  { id: 'A', x0: 1350, w: 100, h: 300, g: 50 },
  { id: 'B', x0: 1590, w: 80, h: 400, g: 50 },
  { id: 'C', x0: 1625, w: 40, h: 90, g: 50 },
];
const BANDS = TRUTH.map(t => ({ id: t.id, label: t.id, order: 'first', center: t.x0 + 6, window: [t.x0 - 25, t.x0 + 25], fwhmSeed: t.w * 1.2 }));
const FD = { fwhmMin: 6, fwhmMax: 300, gaussianPercentSeed: 50, windowPadCm: 300 };
const draw = (seed, sigma = 8) => {
  const r = rng(seed);
  return Float64Array.from(X, x => 40 + 0.02 * (x - 1100) + TRUTH.reduce((s, t) => s + peakY(t, x), 0) + sigma * gauss(r));
};
const sd = a => { const m = a.reduce((p, q) => p + q, 0) / a.length; return Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / (a.length - 1)); };
const mean = a => a.reduce((p, q) => p + q, 0) / a.length;

test('fit covariance: its diagonal square roots are the standard errors', () => {
  const res = fitPeaks({ x: X, y: draw(3), peaks: TRUTH.map(t => ({ ...t })), baseline: { mode: 'linear', c0: 40, c1: 14, fit: true } });
  const C = res.covariance, m = C.params.length;
  assertEqual(C.matrix.length, m * m);
  C.params.forEach((q, i) => {
    const se = q.peak < 0 ? res.baseline.se[q.k] : res.peaks[q.peak].se[q.k];
    assertClose(Math.sqrt(C.matrix[i * m + i]), se, 1e-9 * Math.max(1, se), `${q.peak}.${q.k}`);
  });
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) assertClose(C.matrix[i * m + j], C.matrix[j * m + i], 1e-9 * Math.abs(C.matrix[i * m + j]) + 1e-12, 'symmetric');
});

test('propagated 1σ matches the Monte Carlo scatter of height and area ratios', () => {
  const R = { AB: [], CB: [], ABa: [] }, S = { AB: [], CB: [], ABa: [] };
  for (let k = 0; k < 120; k++) {
    const dc = deconvolve(X, draw(100 + k), BANDS, { fitDefaults: FD });
    const c = id => dc.components.find(q => q.bandId === id);
    R.AB.push(c('A').h / c('B').h); S.AB.push(ratioUncertainty(dc, c('A'), c('B'), 'height'));
    R.CB.push(c('C').h / c('B').h); S.CB.push(ratioUncertainty(dc, c('C'), c('B'), 'height'));
    R.ABa.push(c('A').area / c('B').area); S.ABa.push(ratioUncertainty(dc, c('A'), c('B'), 'area'));
  }
  for (const key of Object.keys(R)) {
    const q = mean(S[key]) / sd(R[key]);
    assert(q > 0.75 && q < 1.33, `${key}: propagated ${mean(S[key]).toFixed(4)} vs scatter ${sd(R[key]).toFixed(4)} (×${q.toFixed(2)})`);
  }
  // C sits on B's flank: ignoring their covariance would misstate C/B, so the cross terms matter
  const dc = deconvolve(X, draw(7), BANDS, { fitDefaults: FD });
  const c = id => dc.components.find(q => q.bandId === id);
  assert(covarianceOf(dc, c('C'), 'h', c('B'), 'h') < 0, 'overlapping heights are anti-correlated');
});

test('components from different windows are independent', () => {
  const a = { bandId: 'A', windowIndex: 0, h: 200, w: 50, g: 50 }, b = { bandId: 'B', windowIndex: 1, h: 400, w: 60, g: 50 };
  const win = (id, varH) => ({ covariance: { params: [{ bandId: id, k: 'h' }], matrix: Float64Array.of(varH) } });
  const dc = { windows: [win('A', 25), win('B', 64)] };
  assertEqual(covarianceOf(dc, a, 'h', b, 'h'), 0);
  assertClose(ratioUncertainty(dc, a, b, 'height'), 0.5 * Math.sqrt((5 / 200) ** 2 + (8 / 400) ** 2), 1e-12);
});

test('area uncertainty uses the analytic area gradient (checked by finite difference)', () => {
  const a = { bandId: 'A', windowIndex: 0, h: 300, w: 90, g: 35 };
  const b = { bandId: 'B', windowIndex: 1, h: 400, w: 70, g: 60 };
  a.area = peakArea(a); b.area = peakArea(b);
  // only A's %Gaussian is uncertain (σ = 4)
  const dc = { windows: [{ covariance: { params: [{ bandId: 'A', k: 'g' }], matrix: Float64Array.of(16) } }, { covariance: { params: [], matrix: new Float64Array(0) } }] };
  const eps = 1e-4, dA = (peakArea({ ...a, g: a.g + eps }) - peakArea({ ...a, g: a.g - eps })) / (2 * eps);
  assertClose(ratioUncertainty(dc, a, b, 'area'), Math.abs(dA) * 4 / b.area, 1e-9);
});

test('no uncertainty without a covariance; detected heights and plain component lists get none', () => {
  const a = { bandId: 'A', windowIndex: 0, h: 1, w: 1, g: 50 }, b = { bandId: 'B', windowIndex: 0, h: 2, w: 1, g: 50 };
  assertEqual(ratioUncertainty({ windows: [{ covariance: null }] }, a, b), null, 'singular fit');
  assertEqual(ratioUncertainty(null, a, b), null, 'no deconvolution');
  const p532 = prepareLibrary(lib, { laserNm: 532 });
  const first = p532.bands.filter(q => ['D', 'G'].includes(q.id));
  const y = Float64Array.from(X, x => 30 + peakY({ x0: 1350, w: 100, h: 300, g: 50 }, x) + peakY({ x0: 1590, w: 80, h: 400, g: 50 }, x) + 5 * gauss(rng(9)));
  const dc = deconvolve(X, y, first, { fitDefaults: lib.fitDefaults });
  const IDG = rs => rs.find(r => r.num === 'D' && r.den === 'G');
  const withCov = IDG(computeRatios(p532, { components: dc, laserNm: 532 }));
  assert(withCov.height.source === 'fit' && withCov.height.se > 0, `fitted height ratio has a 1σ (${withCov.height.se})`);
  assert(withCov.area.se > 0, 'area ratio too');
  const la = withCov.extras.crystalliteSize.find(c => c.basis === 'height');
  assertClose(la.se / la.valueNm, withCov.height.se / withCov.height.value, 1e-12, 'Lₐ carries the ratio\'s relative uncertainty');
  assertEqual(IDG(computeRatios(p532, { components: dc.components, laserNm: 532 })).height.se, null, 'components alone: no covariance');
});

test('value ± uncertainty: two significant figures on the uncertainty, same decimals on the value', () => {
  assertEqual(fmtPm(1.0954, 0.0523), '1.095 ± 0.052');
  assertEqual(fmtPm(1340.2, 12.3), '1340 ± 12');
  assertEqual(fmtPm(0.6512, 0.15), '0.65 ± 0.15');
  assertEqual(fmtPm(1.0954, null), '1.1');
  assertEqual(fmtPm(NaN, 0.1), '—');
});
