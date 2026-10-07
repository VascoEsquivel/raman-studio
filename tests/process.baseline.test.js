import { test, assert, assertEqual, assertArrayClose, assertThrows, rng, gauss } from './harness.js';
import { baselinePoly, baselineALS, computeBaseline, BASELINE_METHODS } from '../js/process/baseline.js';

const lor = (x, c, w, h) => h / (1 + 4 * ((x - c) / w) ** 2);
const X = Float64Array.from({ length: 900 }, (_, i) => 1000 + 2 * i);   // 1000–2798 cm⁻¹

test('methods list matches PeakForge plus ALS', () => {
  assertEqual(JSON.stringify(BASELINE_METHODS), JSON.stringify(['none', 'constant', 'linear', 'quadratic', 'als']));
});

test('modified polyfit recovers a known quadratic under peaks', () => {
  const bg = x => 800 - 0.3 * (x - 1000) + 1.1e-4 * (x - 1000) ** 2;
  const r = rng(2);
  const y = Float64Array.from(X, x => bg(x) + lor(x, 1350, 60, 900) + lor(x, 1590, 40, 1500) + lor(x, 2690, 70, 600) + 2 * gauss(r));
  const b = baselinePoly(X, y, { order: 2 });
  let worst = 0;
  for (let i = 0; i < X.length; i++) worst = Math.max(worst, Math.abs(b[i] - bg(X[i])));
  // modpoly sits slightly below the noise centreline by construction; it must not ride up the peaks
  assert(worst < 40, `max deviation ${worst.toFixed(1)} (peaks up to 1500)`);
});

test('constant and linear orders, and order is clamped', () => {
  const y = Float64Array.from(X, x => 50 + 0.1 * (x - 1000) + lor(x, 1800, 50, 400));
  const lin = baselinePoly(X, y, { order: 1 });
  assert(Math.abs(lin[0] - 50) < 3 && Math.abs(lin[X.length - 1] - (50 + 0.1 * 1798)) < 3, 'linear baseline ends');
  const c = baselinePoly(X, Float64Array.from(X, () => 12), { order: 0 });
  assert(c.every(v => Math.abs(v - 12) < 1e-9), 'constant of a constant');
  assertEqual(baselinePoly(X, y, { order: 7 }).length, X.length, 'order > 2 clamps');
});

test('polynomial baseline is offset-invariant (PeakForge normalised window)', () => {
  const y = Float64Array.from(X, x => 30 + 0.05 * (x - 1000) + lor(x, 1500, 30, 200));
  const a = baselinePoly(X, y, { order: 2 });
  const b = baselinePoly(X.map(v => v + 1e6), y, { order: 2 });
  assertArrayClose(a, b, 1e-6);
});

test('ALS matches a dense NumPy solution', () => {
  const y = [5, 6, 5.5, 7, 9, 15, 9, 7, 6.5, 6, 6.2, 6.1, 8, 12, 8, 6.4, 6.3, 6.6, 6.9, 7.2];
  const ref = [5.366268400382357, 5.506881028814456, 5.6440141074429215, 5.774434645949715, 5.893541519996085, 5.997346387920304, 6.083414137300656, 6.153810982521464, 6.212061430898405, 6.262113084255892, 6.308057513702894, 6.351496216047946, 6.3930041417194055, 6.430767027093177, 6.463774106474307, 6.4937992306543, 6.523384363371429, 6.554180375672739, 6.5857159871532485, 6.617542827220148];
  assertArrayClose(baselineALS(y, { lambda: 100, p: 0.05 }), ref, 1e-9);
});

test('ALS follows a curved fluorescence background and leaves peaks on top', () => {
  const bg = x => 3000 * Math.exp(-(x - 1000) / 900) + 400;
  const r = rng(4);
  const y = Float64Array.from(X, x => bg(x) + lor(x, 1350, 50, 700) + lor(x, 1590, 35, 1200) + 4 * gauss(r));
  const b = baselineALS(y, { lambda: 1e6, p: 0.01 });
  const corr = Float64Array.from(y, (v, i) => v - b[i]);
  // a peak-free stretch sits near zero after correction
  let s = 0, c = 0;
  for (let i = 0; i < X.length; i++) if (X[i] > 2000 && X[i] < 2600) { s += corr[i]; c++; }
  assert(Math.abs(s / c) < 25, 'peak-free region near zero: ' + (s / c).toFixed(1));
  const iG = X.findIndex(x => x >= 1590);
  assert(corr[iG] > 1000, 'G peak height preserved: ' + corr[iG].toFixed(0));
});

test('ALS handles 20 000 points quickly and tiny inputs safely', () => {
  const r = rng(8), n = 20000;
  const y = Float64Array.from({ length: n }, (_, i) => 100 + 50 * Math.sin(i / 3000) + 3 * gauss(r));
  const t0 = performance.now();
  const b = baselineALS(y, { lambda: 1e7 });
  assert(performance.now() - t0 < 300, 'under 300 ms');
  assert(b.every(Number.isFinite), 'finite');
  assertArrayClose(baselineALS([1, 2], {}), [1, 2], 0);
  assertEqual(baselineALS([3, 4, 5]).length, 3);
});

test('computeBaseline dispatches and rejects unknown methods', () => {
  const y = Float64Array.from(X, x => 10 + 0.01 * x);
  assertEqual(computeBaseline(X, y, { method: 'none' }), null);
  for (const m of ['constant', 'linear', 'quadratic', 'als']) assertEqual(computeBaseline(X, y, { method: m }).length, X.length, m);
  assertThrows(() => computeBaseline(X, y, { method: 'spline' }), /Unknown baseline/);
});
