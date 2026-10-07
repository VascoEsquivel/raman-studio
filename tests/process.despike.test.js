import { test, assert, assertEqual, rng, gauss } from './harness.js';
import { despike } from '../js/process/despike.js';

const N = 1200;
const X = Float64Array.from({ length: N }, (_, i) => 200 + i);           // 1 cm⁻¹ / point
const lor = (x, c, w, h) => h / (1 + 4 * ((x - c) / w) ** 2);

/** Background + bands (FWHM in points) + optional noise σ. */
function spectrum({ bands, sigma = 0, seed = 1, slope = 0.02 }) {
  const r = rng(seed);
  return Float64Array.from(X, x => 300 + slope * (x - 200) + bands.reduce((a, b) => a + lor(x, b.c, b.w, b.h), 0) + (sigma ? sigma * gauss(r) : 0));
}
const BANDS = [{ c: 500, w: 30, h: 400 }, { c: 800, w: 18, h: 900 }, { c: 1100, w: 45, h: 250 }];
const near = (i, list, pad = 2) => list.some(s => i >= s.start - pad && i <= s.end + pad);

test('1-, 2- and 3-point spikes are removed and reported', () => {
  const sigma = 4, y = spectrum({ bands: BANDS, sigma, seed: 3 });
  const spikes = [{ at: 300, h: [80] }, { at: 650, h: [60, 90] }, { at: 950, h: [45, 120, 50] }];
  for (const s of spikes) s.h.forEach((v, k) => { y[s.at + k] += v; });
  const r = despike(X, y);
  assertEqual(r.spikes.length, 3, 'three spike runs');
  for (const s of spikes) {
    const run = r.spikes.find(q => q.start === s.at);
    assert(run, 'spike at ' + s.at + ' found');
    assertEqual(run.end - run.start + 1, s.h.length, 'width of spike at ' + s.at);
    for (let k = 0; k < s.h.length; k++) assert(Math.abs(r.y[s.at + k] - (y[s.at + k] - s.h[k])) < 5 * sigma, 'replaced near the clean level');
  }
  assertEqual(r.removed.length, 6, 'every removed point reported');
  const p = r.removed[0];
  assert('index' in p && 'x' in p && 'y' in p && 'replacedY' in p, 'removed point fields');
  assertEqual(p.x, X[p.index]);
});

test('spikes on a band flank, on a band top, at both array ends and close together', () => {
  const sigma = 3, y = spectrum({ bands: BANDS, sigma, seed: 9 });
  const at = [0, N - 1, 790, 800, 880, 884];   // flank of 800 band, its top, two spikes 4 points apart
  for (const i of at) y[i] += 15 * sigma + 40;
  const r = despike(X, y);
  const got = r.removed.map(p => p.index).sort((a, b) => a - b);
  assertEqual(JSON.stringify(got), JSON.stringify([...at].sort((a, b) => a - b)));
});

test('real bands are left bit-identical at SNR from 20 to noiseless', () => {
  for (const sigma of [0, 0.1, 2, 20, 45]) {           // band heights 250–900 → SNR ≥ 5 up to ∞
    const y = spectrum({ bands: BANDS, sigma, seed: 17 });
    const spikeAt = [350, 1000];
    for (const i of spikeAt) y[i] += 12 * Math.max(sigma, 1) + 60;
    const r = despike(X, y);
    for (let i = 0; i < N; i++) {
      if (spikeAt.some(s => Math.abs(i - s) <= 3)) continue;
      assert(r.y[i] === y[i], `σ=${sigma}: point ${i} changed`);
    }
  }
});

test('noiseless spectrum with sharp 5-point-FWHM bands: zero removals', () => {
  const y = spectrum({ bands: [{ c: 400, w: 5, h: 1000 }, { c: 700.5, w: 5, h: 600 }, { c: 900, w: 6, h: 3000 }, ...BANDS] });
  const r = despike(X, y);
  assertEqual(r.removed.length, 0);
  // Gaussian-shaped sharp band too
  const g = Float64Array.from(X, x => 100 + 2000 * Math.exp(-4 * Math.LN2 * ((x - 600) / 5) ** 2));
  assertEqual(despike(X, g).removed.length, 0, 'Gaussian FWHM 5');
});

test('narrow but real features (5–8 points wide) survive at moderate SNR', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const y = spectrum({ bands: [{ c: 420, w: 6, h: 200 }, { c: 610, w: 5, h: 150 }, { c: 760, w: 8, h: 300 }], sigma: 2, seed });
    const r = despike(X, y);
    assert(!r.removed.some(p => Math.abs(p.index - 220) < 6 || Math.abs(p.index - 410) < 6 || Math.abs(p.index - 560) < 8),
      'seed ' + seed + ': a real narrow band was removed: ' + JSON.stringify(r.removed.map(p => p.index)));
  }
  // a 6-point-wide flat-topped feature
  const y = spectrum({ bands: BANDS, sigma: 2, seed: 4 });
  for (let i = 600; i < 606; i++) y[i] += 120;
  assert(!despike(X, y).removed.some(p => p.index >= 598 && p.index <= 607), '6-point feature kept');
});

test('negative excursions are not removed', () => {
  const y = spectrum({ bands: BANDS, sigma: 3, seed: 21 });
  y[450] -= 200; y[451] -= 150;
  assert(!despike(X, y).removed.some(p => p.index === 450 || p.index === 451));
});

test('no false positives on pure noise', () => {
  let removed = 0;
  for (let seed = 1; seed <= 10; seed++) removed += despike(X, spectrum({ bands: BANDS, sigma: 5, seed })).removed.length;
  assert(removed <= 2, `${removed} points removed from 12 000 clean points`);
});

test('short or degenerate input never throws', () => {
  assertEqual(despike([], []).removed.length, 0);
  assertEqual(despike([1, 2, 3], [1, 50, 1]).removed.length, 0);
  const flat = new Float64Array(100).fill(7);
  assertEqual(despike(X.slice(0, 100), flat).removed.length, 0, 'constant signal');
  const nan = Float64Array.from(X.slice(0, 100), (_, i) => (i === 40 ? NaN : 1));
  assertEqual(despike(X.slice(0, 100), nan).removed.length, 0, 'NaN input left alone');
});

test('20 000 points despike in well under a second', () => {
  const n = 20000, x = Float64Array.from({ length: n }, (_, i) => i * 0.2), r = rng(5);
  const y = Float64Array.from(x, v => 100 + lor(v, 1500, 40, 500) + 3 * gauss(r));
  for (const i of [1000, 9000, 15000]) y[i] += 200;
  const t0 = performance.now();
  const out = despike(x, y);
  assert(performance.now() - t0 < 800, 'fast enough');
  assertEqual(out.spikes.length, 3);
});
