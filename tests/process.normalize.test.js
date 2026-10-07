import { test, assert, assertEqual, assertClose, assertThrows } from './harness.js';
import { normalize } from '../js/process/normalize.js';

const X = Float64Array.from({ length: 401 }, (_, i) => 1000 + i * 2);
const Y = Float64Array.from(X, x => 10 + 500 / (1 + ((x - 1350) / 25) ** 2) + 800 / (1 + ((x - 1590) / 18) ** 2));

test('none returns a copy with factor 1', () => {
  const r = normalize(X, Y, { mode: 'none' });
  assertEqual(r.factor, 1); assertEqual(r.ref, 'none');
  assert(r.y !== Y && r.y[5] === Y[5]);
});

test('max scales the maximum to 1', () => {
  const r = normalize(X, Y, { mode: 'max' });
  assertClose(Math.max(...r.y), 1, 1e-12);
  assertEqual(r.ref, 'max');
});

test('band uses the maximum inside the window', () => {
  const r = normalize(X, Y, { mode: 'band', window: [1300, 1400] });
  const i = X.indexOf(1350);
  assertClose(r.y[i], 1, 1e-12, 'D band → 1');
  assertEqual(r.ref, 'band');
  assert(!r.warning);
});

test('band falls back to max with a warning when the window is empty or missing', () => {
  const r = normalize(X, Y, { mode: 'band', window: [3000, 3100] });
  assertEqual(r.ref, 'max'); assert(/window/.test(r.warning));
  const s = normalize(X, Y, { mode: 'band', window: null });
  assertEqual(s.ref, 'max'); assert(s.warning);
});

test('area integrates to 1 (trapezoid)', () => {
  const r = normalize(X, Y, { mode: 'area' });
  let a = 0; for (let i = 1; i < X.length; i++) a += 0.5 * (r.y[i] + r.y[i - 1]) * (X[i] - X[i - 1]);
  assertClose(a, 1, 1e-12);
});

test('non-positive data is left unnormalised with a warning, unknown modes throw', () => {
  const neg = Float64Array.from(X, () => -1);
  const r = normalize(X, neg, { mode: 'max' });
  assertEqual(r.factor, 1); assert(r.warning);
  assertThrows(() => normalize(X, Y, { mode: 'median' }), /Unknown/);
});
