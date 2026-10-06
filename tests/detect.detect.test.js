// Tier-1 detection on synthetic spectra. All signals are generated here from
// seeded noise; band positions in the atlas test come from graphene-go.json,
// widths and heights there are synthetic.
import { test, assert, assertEqual, assertClose, assertDeepEqual, assertThrows, rng, gauss } from './harness.js';
import { DEFAULT_DETECT, sensitivityToK, detectPeaks } from '../js/detect/detect.js';
import { estimateNoise } from '../js/detect/noise.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();

const lorentz = (x, x0, w) => 1 / (1 + 4 * ((x - x0) / w) ** 2);
const gaussian = (x, x0, w) => Math.exp(-4 * Math.LN2 * ((x - x0) / w) ** 2);

/** Unevenly spaced axis: spacing drifts ±vary around dx and jitters a little. */
function axis(lo, hi, dx, r, vary = 0.35, jitter = 0.1) {
  const xs = [];
  for (let x = lo, k = 0; x <= hi; k++) {
    xs.push(x);
    x += dx * (1 + vary * Math.sin(k / 83)) * (1 + jitter * (r() - 0.5));
  }
  return Float64Array.from(xs);
}

/** Sum of peaks {x0, w, h, shape: 'L'|'G'} plus white noise of σ = sigma. */
function spectrum(x, peaks, sigma, r, offset = 0) {
  return Float64Array.from(x, v => {
    let s = offset;
    for (const p of peaks) s += p.h * (p.shape === 'G' ? gaussian(v, p.x0, p.w) : lorentz(v, p.x0, p.w));
    return s + (sigma ? sigma * gauss(r) : 0);
  });
}

function nearest(found, x0) {
  let best = null;
  for (const p of found) if (!best || Math.abs(p.x - x0) < Math.abs(best.x - x0)) best = p;
  return best;
}

test('DEFAULT_DETECT matches the contract', () => {
  assertDeepEqual(DEFAULT_DETECT, { sensitivity: 0.5, minWidthCm: 4, minDistanceCm: 8, maxPeaks: 30 });
});

test('sensitivityToK: 50σ at 0, 3σ at 1, geometric between, clamped', () => {
  assertEqual(sensitivityToK(0), 50);
  assertEqual(sensitivityToK(1), 3);
  assertClose(sensitivityToK(0.5), Math.sqrt(150), 1e-12);
  assertClose(sensitivityToK(0.25) / sensitivityToK(0), sensitivityToK(1) / sensitivityToK(0.75), 1e-12, 'log-spaced');
  assertEqual(sensitivityToK(-2), 50);
  assertEqual(sensitivityToK(7), 3);
  assertClose(sensitivityToK(NaN), sensitivityToK(DEFAULT_DETECT.sensitivity), 0);
  for (let s = 0; s < 1; s += 0.05) assert(sensitivityToK(s + 0.05) < sensitivityToK(s), 'decreasing at ' + s);
});

test('estimateNoise: recovers σ of white noise, ignores slow baselines', () => {
  const r = rng(11);
  const n = 20000;
  const noise = Float64Array.from({ length: n }, () => 2.5 * gauss(r));
  const s0 = estimateNoise(noise);
  assert(Math.abs(s0 / 2.5 - 1) < 0.03, `σ = ${s0}`);
  const withBaseline = noise.map((v, i) => v + 300 + 0.01 * i + 40 * Math.sin(i / 900));
  assert(Math.abs(estimateNoise(withBaseline) / s0 - 1) < 0.02, 'baseline invariant');
});

test('estimateNoise: PeakForge details (upper median, < 4 samples, NaN)', () => {
  const k = 0.6745 * Math.SQRT2;
  assertClose(estimateNoise([0, 1, 3, 6]), 2 / k, 1e-15);
  assertClose(estimateNoise([0, 1, 3, 6, 10]), 3 / k, 1e-15, 'even count → upper middle');
  assertEqual(estimateNoise([1, 2, 3]), 0);
  assertEqual(estimateNoise([]), 0);
  assertEqual(estimateNoise(new Float64Array(50).fill(7)), 0);
  assertClose(estimateNoise([0, 1, NaN, 3, 6, 10, 15]), 4 / k, 1e-15, 'NaN differences skipped');
});

test('finds every true peak within ±1 cm⁻¹ at default sensitivity (SNR ≥ 30, uneven axis)', () => {
  // Narrow-to-medium bands: where a 3-point apex parabola can resolve ±1 cm⁻¹
  // at SNR 30 (see the broad-band test for the noise-limited case).
  const truth = [
    { x0: 412.3, w: 6, h: 30, shape: 'L' }, { x0: 655.8, w: 6, h: 45, shape: 'G' },
    { x0: 901.1, w: 8, h: 50, shape: 'L' }, { x0: 1188.6, w: 6, h: 32, shape: 'G' },
    { x0: 1350.4, w: 9, h: 100, shape: 'L' }, { x0: 1584.9, w: 9, h: 80, shape: 'G' },
    { x0: 2003.2, w: 12, h: 150, shape: 'L' }, { x0: 2690.7, w: 12, h: 200, shape: 'G' },
    { x0: 3101.5, w: 7, h: 40, shape: 'L' },
  ];
  for (const seed of [1, 2, 3, 4]) {
    const r = rng(seed);
    const x = axis(200, 3300, 1.2, r);
    const y = spectrum(x, truth, 1, r);
    const found = detectPeaks(x, y);
    assertEqual(found.length, truth.length, `seed ${seed}: count (${found.map(p => p.x.toFixed(1))})`);
    for (const t of truth) {
      const p = nearest(found, t.x0);
      assert(Math.abs(p.x - t.x0) <= 1, `seed ${seed}: ${t.x0} found at ${p.x}`);
    }
  }
});

test('broad bands at SNR ≥ 30 are all found; position error within the noise limit', () => {
  // The apex parabola uses three samples, so its scatter grows like FWHM/√SNR;
  // detection must still find each band and stay within that bound.
  const truth = [
    { x0: 1180, w: 40, h: 30, shape: 'G' }, { x0: 1350, w: 60, h: 45, shape: 'L' },
    { x0: 1590, w: 30, h: 40, shape: 'L' }, { x0: 2450, w: 45, h: 30, shape: 'G' },
    { x0: 2690, w: 50, h: 60, shape: 'L' }, { x0: 3230, w: 35, h: 30, shape: 'G' },
  ];
  for (const seed of [5, 6, 7]) {
    const r = rng(seed);
    const x = axis(900, 3500, 1.5, r);
    const y = spectrum(x, truth, 1, r);
    const found = detectPeaks(x, y);
    assertEqual(found.length, truth.length, `seed ${seed}: count (${found.map(p => p.x.toFixed(1))})`);
    for (const t of truth) {
      const p = nearest(found, t.x0);
      const bound = 1.5 * t.w / Math.sqrt(t.h);
      assert(Math.abs(p.x - t.x0) <= bound, `seed ${seed}: ${t.x0} found at ${p.x} (bound ±${bound.toFixed(2)})`);
    }
  }
});

test('band positions from the atlas (D, G, 2D) are detected', () => {
  const ids = ['D', 'G', 'twoD'];
  const truth = ids.map((id, k) => ({ x0: lib.bands.find(b => b.id === id).posSort, w: 20 + 5 * k, h: 400, shape: 'L' }));
  const r = rng(21);
  const x = axis(1000, 3000, 1, r);
  const found = detectPeaks(x, spectrum(x, truth, 1, r));
  assertEqual(found.length, 3, 'three bands');
  for (const t of truth) assert(Math.abs(nearest(found, t.x0).x - t.x0) <= 1, `${t.x0}`);
});

test('pure noise gives no peaks at default sensitivity', () => {
  for (const seed of [31, 32, 33, 34, 35, 36]) {
    const r = rng(seed);
    const x = axis(100, 100 + 1.3 * (1500 + 300 * (seed % 4)), 1.3, r);
    const scale = seed % 2 ? 1 : 50;
    const y = Float64Array.from(x, () => 1000 + scale * gauss(r));
    const found = detectPeaks(x, y);
    assertEqual(found.length, 0, `seed ${seed}: ${found.map(p => p.x.toFixed(1))}`);
  }
});

test('peak count is monotonic non-decreasing in sensitivity', () => {
  const amps = [3, 4, 6, 8, 11, 15, 20, 28, 40, 60];
  const truth = amps.map((h, k) => ({ x0: 300 + 250 * k, w: 10 + (k % 3) * 4, h, shape: k % 2 ? 'G' : 'L' }));
  for (const seed of [41, 42]) {
    const r = rng(seed);
    const x = axis(100, 2900, 1.1, r);
    const y = spectrum(x, truth, 1, r);
    let prev = -1;
    const counts = [];
    for (let i = 0; i <= 20; i++) {
      const c = detectPeaks(x, y, { sensitivity: i / 20 }).length;
      counts.push(c);
      assert(c >= prev, `seed ${seed}: counts ${counts.join(',')}`);
      prev = c;
    }
    assert(counts[20] > counts[0], `seed ${seed}: sensitivity changes something (${counts.join(',')})`);
  }
});

test('two peaks closer than minDistanceCm collapse to the higher one', () => {
  const r = rng(51);
  const x = axis(950, 1060, 0.5, r, 0.1, 0.05);
  for (const [hA, hB] of [[100, 70], [70, 100]]) {
    const truth = [{ x0: 1000, w: 4, h: hA, shape: 'G' }, { x0: 1006.5, w: 4, h: hB, shape: 'G' }];
    const y = spectrum(x, truth, 0.2, r);
    // Control: without the distance rule both peaks are detected...
    const both = detectPeaks(x, y, { minWidthCm: 2, minDistanceCm: 0 });
    assertEqual(both.length, 2, 'both resolved without a distance rule');
    // ... with the default 8 cm⁻¹ only the higher survives.
    const one = detectPeaks(x, y, { minWidthCm: 2 });
    assertEqual(one.length, 1, 'collapsed');
    const expectX = hA > hB ? 1000 : 1006.5;
    assert(Math.abs(one[0].x - expectX) < 0.5, `kept ${one[0].x}, expected ${expectX}`);
    // Peaks farther apart than minDistanceCm both stay.
    assertEqual(detectPeaks(x, y, { minWidthCm: 2, minDistanceCm: 6 }).length, 2, 'apart enough');
  }
});

test('FWHM of a Lorentzian is recovered within 5% (even and uneven axes, with and without noise)', () => {
  for (const [label, x] of [['even', Float64Array.from({ length: 1201 }, (_, i) => 1000 + i)],
    ['uneven', axis(1000, 2200, 1.1, rng(61))]]) {
    for (const sigma of [0, 0.3]) {
      const r = rng(62);
      const w = 20, x0 = 1580.3;
      const found = detectPeaks(x, spectrum(x, [{ x0, w, h: 100, shape: 'L' }], sigma, r));
      assertEqual(found.length, 1, `${label} σ=${sigma}: one peak`);
      const p = found[0];
      assert(Math.abs(p.fwhm / w - 1) < 0.05, `${label} σ=${sigma}: fwhm ${p.fwhm}`);
      assertClose(p.rightX - p.leftX, p.fwhm, 1e-9, 'fwhm = rightX − leftX');
      assert(p.leftX < p.x && p.x < p.rightX, 'apex between the half-height crossings');
      assertClose((p.leftX + p.rightX) / 2, x0, 0.5, 'crossings symmetric about the centre');
    }
  }
});

test('maxPeaks keeps the most prominent peaks, sorted by x', () => {
  const amps = [20, 90, 35, 60, 15, 80, 45, 70, 25, 50];
  const truth = amps.map((h, k) => ({ x0: 400 + 200 * k, w: 12, h, shape: 'L' }));
  const r = rng(71);
  const x = axis(200, 2600, 1, r);
  const y = spectrum(x, truth, 0.5, r);
  assertEqual(detectPeaks(x, y).length, 10, 'all ten without a tight cap');
  const top = detectPeaks(x, y, { maxPeaks: 4 });
  assertEqual(top.length, 4);
  const expected = truth.filter(t => t.h >= 60).map(t => t.x0);
  top.forEach((p, i) => assert(Math.abs(p.x - expected[i]) < 1, `#${i}: ${p.x} vs ${expected[i]}`));
  for (let i = 1; i < top.length; i++) assert(top[i].x > top[i - 1].x, 'ascending x');
  assertEqual(detectPeaks(x, y, { maxPeaks: 0 }).length, 0, 'maxPeaks 0');
});

test('default maxPeaks caps at 30; Infinity lifts the cap', () => {
  const truth = Array.from({ length: 40 }, (_, k) => ({ x0: 200 + 70 * k, w: 10, h: 50 + k, shape: 'L' }));
  const r = rng(72);
  const x = axis(100, 3100, 1, r);
  const y = spectrum(x, truth, 1, r);
  assertEqual(detectPeaks(x, y).length, 30);
  assertEqual(detectPeaks(x, y, { maxPeaks: Infinity }).length, 40);
});

test('DetectedPeak shape: ids, indices, apex, snr', () => {
  const truth = [{ x0: 800, w: 15, h: 60, shape: 'L' }, { x0: 1500, w: 25, h: 90, shape: 'G' }];
  const r = rng(81);
  const x = axis(500, 2000, 1.3, r);
  const y = spectrum(x, truth, 1, r, 10);
  const xCopy = x.slice(), yCopy = y.slice();
  const found = detectPeaks(Array.from(x), Array.from(y));
  const sigma = estimateNoise(y);
  assertEqual(found.length, 2);
  assertEqual(new Set(found.map(p => p.id)).size, 2, 'unique ids');
  for (const p of found) {
    for (const k of ['id', 'index', 'x', 'y', 'prominence', 'fwhm', 'leftX', 'rightX', 'snr']) assert(k in p, k);
    assertEqual(typeof p.id, 'string');
    assert(Number.isInteger(p.index), 'integer index');
    assert(Math.abs(p.x - x[p.index]) <= Math.max(x[p.index + 1] - x[p.index], x[p.index] - x[p.index - 1]),
      'refined x within one sample of the apex sample');
    assert(p.y >= y[p.index], 'parabolic apex not below the apex sample');
    assertClose(p.snr, p.prominence / sigma, 1e-9, 'snr = prominence / σ');
    assert(p.snr > 30, 'strong peaks have high snr');
  }
  assertDeepEqual(Array.from(x), Array.from(xCopy), 'x untouched');
  assertDeepEqual(Array.from(y), Array.from(yCopy), 'y untouched');
});

test('degenerate inputs', () => {
  assertDeepEqual(detectPeaks([1, 2], [0, 1]), []);
  assertDeepEqual(detectPeaks([], []), []);
  assertThrows(() => detectPeaks([1, 2, 3], [1, 2]), /length/);
  assertDeepEqual(detectPeaks(Float64Array.from({ length: 100 }, (_, i) => i), new Float64Array(100).fill(5)), []);
  // A noise-free peak: σ is ~0 there, so the range floor keeps ripples out.
  const x = Float64Array.from({ length: 400 }, (_, i) => 1000 + i);
  const found = detectPeaks(x, Float64Array.from(x, v => 100 * lorentz(v, 1200, 12)));
  assertEqual(found.length, 1);
  assertClose(found[0].x, 1200, 1e-6, 'exact apex on noise-free data');
});
