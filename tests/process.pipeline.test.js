import { test, assert, assertEqual, assertClose, rng, gauss } from './harness.js';
import { runPipeline, DEFAULT_SETTINGS } from '../js/process/pipeline.js';

const X = Float64Array.from({ length: 1000 }, (_, i) => 900 + 2.5 * i);
const lor = (x, c, w, h) => h / (1 + 4 * ((x - c) / w) ** 2);
function sample(seed = 1) {
  const r = rng(seed);
  const y = Float64Array.from(X, x => 2000 * Math.exp(-(x - 900) / 1500) + 300 + lor(x, 1350, 60, 800) + lor(x, 1590, 40, 1200) + lor(x, 2690, 70, 500) + 5 * gauss(r));
  y[200] += 600; y[650] += 500;   // cosmic rays
  return { x: X, y };
}
const off = { despike: { on: false }, baseline: { on: false }, smooth: { on: false }, normalize: { on: false } };

test('defaults: despike + ALS baseline on, smoothing and normalisation off', () => {
  assertEqual(DEFAULT_SETTINGS.despike.on, true);
  assertEqual(DEFAULT_SETTINGS.baseline.method, 'als');
  assertEqual(DEFAULT_SETTINGS.smooth.on, false);
  const p = runPipeline(sample(), {});
  assertEqual(JSON.stringify(p.steps), JSON.stringify({ despike: true, baseline: true, smooth: false, normalize: false }));
  assertEqual(p.spikes.length, 2, 'both cosmic rays found');
  assertEqual(p.removed.length, 2);
  assert(p.baseline && p.baseline.length === X.length);
});

test('every step off returns the raw data untouched', () => {
  const s = sample(), p = runPipeline(s, off);
  for (let i = 0; i < X.length; i++) assert(p.y[i] === s.y[i]);
  assertEqual(p.baseline, null); assertEqual(p.normFactor, 1);
});

test('order is despike → baseline → smooth → normalise', () => {
  const s = sample(2);
  const p = runPipeline(s, { smooth: { on: true, window: 9, order: 3 }, normalize: { on: true, mode: 'max' } });
  for (let i = 0; i < X.length; i++) assertClose(p.corrected[i], p.despiked[i] - p.baseline[i], 1e-9);
  assertClose(Math.max(...p.y), 1, 1e-12);
  assertClose(p.normFactor, Math.max(...p.smoothed), 1e-9);
  assert(p.despiked[200] < s.y[200] - 400, 'spike removed before the baseline is fitted');
});

test('band normalisation uses the window and falls back with a warning', () => {
  const p = runPipeline(sample(3), { normalize: { on: true, mode: 'band' } }, { bandWindow: [1560, 1620] });
  assertEqual(p.normRef, 'band');
  const iG = X.findIndex(x => x >= 1590);
  assert(Math.abs(p.y[iG] - 1) < 0.05, 'G ≈ 1');
  const q = runPipeline(sample(3), { normalize: { on: true, mode: 'band' } }, { bandWindow: null });
  assertEqual(q.normRef, 'max'); assert(q.warnings.length >= 1);
});

test('crop keeps only the chosen range', () => {
  const p = runPipeline(sample(), { ...off, crop: { on: true, lo: 1200, hi: 1800 } });
  assert(p.x[0] >= 1200 && p.x[p.x.length - 1] <= 1800);
  assertEqual(p.raw.length, p.x.length);
});

test('very short spectra skip steps with warnings instead of throwing', () => {
  const p = runPipeline({ x: [1, 2, 3], y: [4, 5, 6] }, { smooth: { on: true } });
  assertEqual(p.steps.despike, false);
  assert(p.warnings.length >= 2);
  assertEqual(p.y.length, 3);
});

test('settings objects are not mutated', () => {
  const s = { despike: { on: true, threshold: 8 } };
  runPipeline(sample(), s);
  assertEqual(JSON.stringify(s), JSON.stringify({ despike: { on: true, threshold: 8 } }));
});
