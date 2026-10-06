// PeakForge's Levenberg–Marquardt, decoupled. Checked the way PeakForge itself was
// validated: generate a spectrum from known parameters, add noise, corrupt the
// starting guess, fit, compare with the truth.
import { test, assert, assertEqual, assertClose, assertThrows, rng, gauss } from './harness.js';
import { fitPeaks, evaluateModel, fitQuality, estimateNoise } from '../js/fit/lm.js';
import { peakY, peakArea } from '../js/fit/profile.js';

const linspace = (a, b, n) => Float64Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));
const median = a => { const s = [...a].sort((p, q) => p - q); return s[Math.floor((s.length - 1) / 2)]; };
const finite = v => typeof v === 'number' && Number.isFinite(v);

test('estimateNoise recovers the σ of white noise', () => {
  const r = rng(11), n = 20000, y = new Float64Array(n);
  for (let i = 0; i < n; i++) y[i] = 100 + 3 * gauss(r);
  assertClose(estimateNoise(y), 3, 0.15);
  assertEqual(estimateNoise([1, 2, 3]), 0, 'fewer than 4 points');
});

test('evaluateModel sums components and the u-normalised baseline', () => {
  const peaks = [{ x0: 10, w: 4, h: 5, g: 30 }, { x0: 16, w: 2, h: -1, g: 100 }];
  const baseline = { mode: 'quad', c0: 1, c1: 2, c2: -3, xMin: 0, xMax: 20 };
  const x = [0, 5, 10, 16, 20];
  const got = evaluateModel(peaks, baseline, x);
  assert(got instanceof Float64Array, 'returns Float64Array');
  x.forEach((xv, i) => {
    const u = xv / 20;
    const want = 1 + 2 * u - 3 * u * u + peakY(peaks[0], xv) + peakY(peaks[1], xv);
    assertClose(got[i], want, 1e-12, `x=${xv}`);
    assertClose(evaluateModel(peaks, baseline, xv), want, 1e-12, `scalar x=${xv}`);
  });
  assertClose(evaluateModel(peaks, { mode: 'none' }, 10), peakY(peaks[0], 10) + peakY(peaks[1], 10), 1e-12);
});

test('fitQuality ≈ 1 for a perfect model and points at a missing component', () => {
  const r = rng(5), x = linspace(0, 1000, 1200);
  const truth = [{ x0: 300, w: 30, h: 500, g: 50 }, { x0: 700, w: 25, h: 400, g: 50 }];
  const clean = evaluateModel(truth, null, x);
  const y = Float64Array.from(clean, v => v + 5 * gauss(r));
  const good = fitQuality(x, y, clean);
  assert(good.med > 0.8 && good.med < 1.25, `perfect model quality ${good.med}`);
  const missing = evaluateModel([truth[0]], null, x);
  const bad = fitQuality(x, y, missing);
  assert(bad.worst > 3, `worst window ${bad.worst}`);
  assert(Math.abs(bad.worstAt - 700) < 25, `worst window centre ${bad.worstAt}`);
  assert(Number.isNaN(fitQuality([1, 2], [1, 2], [1, 2]).med), 'NaN below 40 points');
  // The model may also be given as a function of x.
  assertClose(fitQuality(x, y, xv => evaluateModel(truth, null, xv)).med, good.med, 1e-12);
});

// --- randomised round trip ------------------------------------------------
function makeTrial(seed) {
  const r = rng(seed), U = (a, b) => a + (b - a) * r();
  const L = Math.pow(10, U(0.5, 3.3)), off = r() < 0.5 ? 0 : U(0, 1) * Math.pow(10, U(0, 4));
  const n = 300 + Math.floor(r() * 600);
  const x = linspace(off, off + L, n);
  const K = 1 + Math.floor(r() * 5);
  const noiseMode = ['abs', 'poisson', 'percent'][seed % 3];
  const hmax = noiseMode === 'poisson' ? Math.pow(10, U(2.5, 4)) : Math.pow(10, U(-2, 4));
  // Centres spread so neighbours overlap but stay resolvable.
  const peaks = [];
  for (let attempt = 0; peaks.length < K && attempt < 500; attempt++) {
    const w = L * U(0.02, 0.08), x0 = off + L * U(0.12, 0.88);
    if (peaks.every(p => Math.abs(p.x0 - x0) > 0.8 * (p.w + w) / 2)) {
      const gr = r(), g = gr < 0.2 ? 0 : gr < 0.4 ? 100 : U(0, 100);
      peaks.push({ x0, w, h: hmax * U(0.25, 1), g });
    }
  }
  const mode = ['none', 'const', 'linear', 'quad'][Math.floor(seed / 3) % 4];
  const c1 = mode === 'linear' || mode === 'quad' ? hmax * U(-0.15, 0.15) : 0;
  const c2 = mode === 'quad' ? hmax * U(-0.1, 0.1) : 0;
  const c0 = mode === 'none' ? 0 : Math.abs(c1) + Math.abs(c2) + hmax * U(0.02, 0.3);
  const baseline = { mode, c0, c1, c2, xMin: off, xMax: off + L };
  const clean = evaluateModel(peaks, baseline, x);
  const pct = U(0.5, 2);
  const y = Float64Array.from(clean, v => v + gauss(r) * (noiseMode === 'abs' ? 0.01 * hmax
    : noiseMode === 'poisson' ? Math.sqrt(Math.max(v, 1)) : hmax * pct / 100));
  // Starting guess corrupted by up to 30 %.
  const c = () => U(-0.3, 0.3);
  const start = peaks.map(p => ({ x0: p.x0 + c() * p.w, w: p.w * (1 + c()), h: p.h * (1 + c()),
    g: Math.min(100, Math.max(0, p.g + 100 * c())) }));
  const startBase = { mode, fit: mode !== 'none', xMin: off, xMax: off + L,
    c0: c0 + c() * (Math.abs(c0) + 0.05 * hmax), c1: c1 + c() * (Math.abs(c1) + 0.05 * hmax),
    c2: c2 + c() * (Math.abs(c2) + 0.05 * hmax) };
  return { x, y, peaks, start, startBase, weighting: seed % 2 ? 'poisson' : 'unit' };
}

// Two in five components are pure Gaussian or pure Lorentzian, i.e. sit at a
// %Gaussian bound: that is what exercises the inward finite difference.
test('randomised round trip: 32 trials, 1–5 peaks, noise, 30 % corrupted starts', () => {
  const trials = 32, centreErr = [], qualities = [];
  let exceptions = 0, nonFinite = 0, collapsed = 0;
  for (let t = 0; t < trials; t++) {
    const tr = makeTrial(1000 + t);
    let res;
    try {
      res = fitPeaks({ x: tr.x, y: tr.y, peaks: tr.start, baseline: tr.startBase, weighting: tr.weighting });
    } catch (err) { exceptions++; continue; }
    qualities.push(res.stats.quality);
    for (const p of res.peaks) if (!['x0', 'w', 'h', 'g', 'area'].every(k => finite(p[k]))) nonFinite++;
    if (!finite(res.stats.chiRed) || !finite(res.stats.quality)) nonFinite++;
    // Match fitted to true components by order of centre (bounded steps keep order).
    const fit = [...res.peaks].sort((a, b) => a.x0 - b.x0), tru = [...tr.peaks].sort((a, b) => a.x0 - b.x0);
    tru.forEach((p, i) => {
      centreErr.push(Math.abs(fit[i].x0 - p.x0) / p.w);
      if (fit[i].w < 0.2 * p.w) collapsed++;
    });
  }
  assertEqual(exceptions, 0, 'exceptions');
  assertEqual(nonFinite, 0, 'non-finite results');
  assertEqual(collapsed, 0, 'collapsed widths');
  const med = median(centreErr);
  assert(med < 0.1, `median centre error ${med.toFixed(4)} FWHM`);
  const good = qualities.filter(q => q < 1.6).length;
  assert(good >= 0.9 * trials, `${good}/${trials} fits reached quality < 1.6 (${qualities.map(q => q.toFixed(2)).join(' ')})`);
});

test('per-peak bounds are respected and intersect the defaults', () => {
  const r = rng(21), x = linspace(400, 600, 500);
  const y = Float64Array.from(x, v => peakY({ x0: 500, w: 20, h: 1000, g: 50 }, v) + 3 * gauss(r));
  const res = fitPeaks({ x, y, peaks: [{ x0: 492, w: 30, h: 800, g: 50,
    bounds: { x0: [490, 495], w: [10, 12], g: [20, 60], h: [0, null] } }] });
  const p = res.peaks[0];
  assert(p.x0 >= 490 && p.x0 <= 495, `x0 ${p.x0}`);
  assertClose(p.x0, 495, 1e-9, 'x0 pushed to its upper bound');
  assert(p.w >= 10 && p.w <= 12, `w ${p.w}`);
  assertClose(p.w, 12, 1e-9, 'w pushed to its upper bound');
  assert(p.g >= 20 && p.g <= 60, `g ${p.g}`);
  assert(p.h >= 0, 'h ≥ 0');
  // Starting values outside a bound are brought inside before fitting.
  const res2 = fitPeaks({ x, y, peaks: [{ x0: 470, w: 20, h: -50, g: 50, bounds: { x0: [480, 520], h: [0, Infinity] } }] });
  assert(res2.peaks[0].x0 >= 480 && res2.peaks[0].h >= 0, 'out-of-bounds start clamped');
  assertClose(res2.peaks[0].x0, 500, 0.5, 'and then fitted');
  // Looser user bounds do not widen the defaults: x0 ∈ [400 − 10, 600 + 10] (5 % pad)
  // and w ≤ 3·span still hold, even from a start far outside both.
  const res3 = fitPeaks({ x, y, peaks: [{ x0: 1000, w: 1e6, h: 1000, g: 50, bounds: { x0: [0, 2000], w: [0, 1e9] } }] });
  assert(res3.peaks[0].x0 >= 390 && res3.peaks[0].x0 <= 610, `x0 ${res3.peaks[0].x0} inside the default range`);
  assert(res3.peaks[0].w <= 600, `w ${res3.peaks[0].w} under the default ceiling`);
});

test('locked parameters stay exactly where they were put', () => {
  const r = rng(22), x = linspace(0, 100, 400);
  const truth = [{ x0: 40, w: 8, h: 50, g: 30 }, { x0: 60, w: 10, h: 30, g: 70 }];
  const y = Float64Array.from(evaluateModel(truth, null, x), v => v + 0.5 * gauss(r));
  const start = [{ x0: 41, w: 9.3, h: 45, g: 55, lock: { w: true, g: true } },
    { x0: 59, w: 11, h: 35, g: 70, lock: { x0: true } }];
  const res = fitPeaks({ x, y, peaks: start });
  assertEqual(res.peaks[0].w, 9.3); assertEqual(res.peaks[0].g, 55); assertEqual(res.peaks[1].x0, 59);
  assertEqual(res.peaks[0].se.w, null); assertEqual(res.peaks[0].se.g, null); assertEqual(res.peaks[1].se.x0, null);
  assert(finite(res.peaks[0].se.x0) && finite(res.peaks[1].se.w), 'free parameters get uncertainties');
  assert(res.peaks[0].x0 !== 41 && res.peaks[1].w !== 11, 'free parameters moved');
  assertEqual(res.stats.npar, 5);
  assertEqual(res.peaks[0].lock.w, true, 'lock passes through');
  // Everything locked: nothing to fit, result equals the input.
  const all = { x0: true, w: true, h: true, g: true };
  const frozen = fitPeaks({ x, y, peaks: truth.map(p => ({ ...p, lock: all })) });
  assertEqual(frozen.stats.npar, 0);
  assertEqual(frozen.stats.conv, 'no free parameters');
  assertEqual(frozen.peaks[1].x0, 60);
  assertEqual(frozen.worstCorrelation, null);
});

test('baseline modes are fitted over u = (x − xMin)/(xMax − xMin)', () => {
  const r = rng(23), x = linspace(1000, 1400, 600);
  const truthBase = { mode: 'quad', c0: 200, c1: -80, c2: 40, xMin: 1000, xMax: 1400 };
  const peak = { x0: 1200, w: 30, h: 900, g: 40 };
  const y = Float64Array.from(evaluateModel([peak], truthBase, x), v => v + 4 * gauss(r));
  const res = fitPeaks({ x, y, peaks: [{ ...peak, x0: 1205, h: 700 }],
    baseline: { mode: 'quad', c0: 0, c1: 0, c2: 0, fit: true } });
  assertEqual(res.baseline.xMin, 1000, 'xMin defaults to the data range');
  assertEqual(res.baseline.xMax, 1400);
  assertClose(res.baseline.c0, 200, 5); assertClose(res.baseline.c1, -80, 15); assertClose(res.baseline.c2, 40, 15);
  assert(finite(res.baseline.se.c2), 'baseline uncertainties');
  assert(res.stats.quality < 1.3, `quality ${res.stats.quality}`);
  // A baseline that is not fitted stays put.
  const fixed = fitPeaks({ x, y, peaks: [peak], baseline: { ...truthBase, fit: false } });
  assertEqual(fixed.baseline.c1, -80);
  assertEqual(fixed.baseline.se.c0, null);
  assertEqual(fixed.stats.npar, 4);
});

test('uncertainties match the scatter over repeated noise draws', () => {
  const x = linspace(0, 200, 400), truth = { x0: 100, w: 12, h: 60, g: 50 }, xs = [], ses = [];
  for (let k = 0; k < 30; k++) {
    const r = rng(300 + k);
    const y = Float64Array.from(x, v => peakY(truth, v) + 2 * gauss(r));
    const res = fitPeaks({ x, y, peaks: [{ ...truth, x0: 101 }] });
    xs.push(res.peaks[0].x0); ses.push(res.peaks[0].se.x0);
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
  const ratio = median(ses) / sd;
  assert(ratio > 0.6 && ratio < 1.6, `σ(x0) predicted/observed = ${ratio.toFixed(3)}`);
});

test('flags undersampled and insignificant components, and the worst correlation', () => {
  const r = rng(24), x = linspace(0, 100, 101);  // dx = 1
  const truth = [{ x0: 30, w: 2.5, h: 100, g: 50 }, { x0: 70, w: 10, h: 80, g: 50 }];
  const y = Float64Array.from(evaluateModel(truth, null, x), v => v + 2 * gauss(r));
  const res = fitPeaks({ x, y, peaks: [...truth.map(p => ({ ...p })), { x0: 50, w: 8, h: 3, g: 50, name: 'ghost' }] });
  assert(res.undersampled.includes(0), `undersampled ${res.undersampled}`);
  assert(!res.undersampled.includes(1), 'well-sampled peak not flagged');
  assert(res.insignificant.includes(2), `insignificant ${res.insignificant} (ghost h ${res.peaks[2].h} ± ${res.peaks[2].se.h})`);
  assert(!res.insignificant.includes(1), 'real peak is significant');
  // Two nearly coincident components are degenerate.
  const x2 = linspace(0, 100, 500), r2 = rng(25);
  const y2 = Float64Array.from(x2, v => peakY({ x0: 50, w: 20, h: 100, g: 50 }, v) + gauss(r2));
  const res2 = fitPeaks({ x: x2, y: y2, peaks: [{ x0: 48, w: 20, h: 50, g: 50, name: 'A' }, { x0: 52, w: 20, h: 50, g: 50, name: 'B' }] });
  assert(res2.worstCorrelation && Math.abs(res2.worstCorrelation.rho) > 0.9, `rho ${res2.worstCorrelation && res2.worstCorrelation.rho}`);
  assert(/^(A|B|baseline)\.\w+$/.test(res2.worstCorrelation.a), `label ${res2.worstCorrelation.a}`);
});

test('result shape follows the contract', () => {
  const x = linspace(0, 100, 200), y = Float64Array.from(x, v => peakY({ x0: 50, w: 10, h: 10, g: 50 }, v));
  const res = fitPeaks({ x, y, peaks: [{ x0: 50.5, w: 11, h: 9, g: 50, tag: 'keep me' }], maxIter: 50 });
  for (const k of ['chiRed', 'r2', 'rmse', 'sigma', 'quality', 'qualityWorst', 'qualityAt', 'iters', 'ms', 'npar', 'n', 'conv']) {
    assert(k in res.stats, `stats.${k}`);
  }
  assertEqual(res.peaks[0].tag, 'keep me', 'passthrough');
  assertClose(res.peaks[0].area, peakArea(res.peaks[0]), 1e-9);
  assert(res.residual instanceof Float64Array && res.residual.length === 200, 'residual');
  assertEqual(res.stats.n, 200);
  assert(/^converged/.test(res.stats.conv), res.stats.conv);
  assertThrows(() => fitPeaks({ x: [1, 2, 3], y: [1, 2], peaks: [] }), /same length/);
  assertThrows(() => fitPeaks({ x, y, peaks: [], baseline: { mode: 'cubic' } }), /baseline mode/);
  assertThrows(() => fitPeaks({ x, y, peaks: [{ x0: NaN, w: 1, h: 1, g: 0 }] }), /finite/);
});

// PeakForge's own Raman carbon preset (its 10 curves, including the negative
// dip), rendered noiseless over its 100–3500 cm⁻¹, 2000-point axis.
const RAMAN_PRESET = [
  [1350.05, 44.7659, 3317.12, 10.5212], [1388.16, 399.404, 406.754, 100],
  [1575.32, 123.819, 375.146, 100], [1582.12, 22.4851, 10934, 28.1603],
  [1616.34, 36.3255, 1010.68, 100], [2463.23, 74.4333, 302.052, 12.5186],
  [2705.51, 77.625, 5318.31, 32.1194], [2937.01, 157.954, 512.387, 0],
  [2753.96, 55.1563, -742.023, 0], [3245.49, 25.3426, 644.963, 0],
].map(([x0, w, h, g], i) => ({ name: `Curve ${i + 1}`, x0, w, h, g }));

test('recovers PeakForge\'s Raman preset from a perturbed start', () => {
  const x = linspace(100, 3500, 2000), y = evaluateModel(RAMAN_PRESET, null, x);
  const r = rng(77), U = () => 2 * r() - 1;
  const start = RAMAN_PRESET.map(p => ({ ...p, x0: p.x0 + 0.1 * p.w * U(), w: p.w * (1 + 0.1 * U()),
    h: p.h * (1 + 0.1 * U()), g: Math.min(100, Math.max(0, p.g + 10 * U())) }));
  const res = fitPeaks({ x, y, peaks: start, weighting: 'poisson', maxIter: 200 });
  res.peaks.forEach((p, i) => {
    const t = RAMAN_PRESET[i];
    assertEqual(p.name, t.name);
    assertClose(p.x0, t.x0, 0.01 * t.w, `${t.name} x0`);
    assertClose(p.w, t.w, 0.01 * t.w, `${t.name} w`);
    assertClose(p.h, t.h, 0.01 * Math.abs(t.h), `${t.name} h`);
    assertClose(p.g, t.g, 2, `${t.name} g`);
  });
  assertClose(res.peaks[0].area, 225343, 225343 * 1e-3, 'Curve 1 area');
  assert(res.stats.quality < 0.05, `quality ${res.stats.quality} (${res.stats.conv})`);
});

// Golden values from PeakForge's own runFit (Curve-gen index.html, run in Chrome)
// on two of its presets: synthetic data regenerated exactly as its synth() does
// (same mulberry32 / Box–Muller as the harness), a perturbed start, default
// iteration cap. The port must reproduce them, not merely fit well.
function peakForgeSynth({ xMin, xMax, pts, peaks, baseline, noise }) {
  const x = linspace(xMin, xMax, pts), r = rng(noise.seed);
  const clean = evaluateModel(peaks, { ...baseline, xMin, xMax }, x);
  const y = Float64Array.from(clean, v => v + gauss(r) * (noise.mode === 'poisson' ? Math.sqrt(Math.max(v, 1)) * noise.level : noise.level));
  return { x, y };
}
const GOLDEN = [
  {
    name: 'overlap preset (unit weights, fitted linear baseline)',
    data: { xMin: 900, xMax: 1200, pts: 1200, noise: { mode: 'abs', level: 8, seed: 7 },
      peaks: [{ x0: 1030, w: 26, h: 900, g: 60 }, { x0: 1062, w: 34, h: 620, g: 35 }],
      baseline: { mode: 'linear', c0: 40, c1: -25 } },
    y0: [70.0288552755294, 47.415675446918925, 40.39884913992514],
    weighting: 'unit',
    start: [
      { name: 'Curve 1', x0: 1031.2181049105711, w: 24.63498777197674, h: 842.0299349189736, g: 61.138654723763466 },
      { name: 'Curve 2', x0: 1064.5519580396824, w: 35.334500088123605, h: 619.851492701564, g: 30.717339671682566 }],
    startBase: { mode: 'linear', c0: 44.50542249158025, c1: -21.140317237004638, c2: 0, fit: true },
    peaks: [
      { x0: 1030.0449829014906, w: 25.9425812101317, h: 901.5557540864382, g: 58.65106412217889,
        se: { x0: 0.03133030309947123, h: 2.051286979772585, w: 0.07635250785807181, g: 1.006509319051933 } },
      { x0: 1061.9984808904496, w: 33.78471375047097, h: 620.9539721099214, g: 32.98793713938013,
        se: { x0: 0.05855116355202523, h: 1.838574423979343, w: 0.16099393615109175, g: 1.3745388855709642 } }],
    base: { c0: 39.13571060973188, c1: -24.589294467377595 },
    stats: { chiRed: 69.0073480970309, r2: 0.9991439768588741, rmse: 8.272380966982176,
      quality: 0.9323765100136647, qualityWorst: 1.4146495539208879, iters: 6 },
    conv: 'converged (χ² stationary)',
    worst: { rho: 0.7126760496124475, a: 'Curve 1.x0', b: 'Curve 2.x0' },
  },
  {
    name: 'XPS preset (Poisson weights, one %Gaussian locked)',
    data: { xMin: 280, xMax: 294, pts: 900, noise: { mode: 'poisson', level: 1, seed: 42 },
      peaks: [{ x0: 284.8, w: 1.0, h: 16000, g: 80 }, { x0: 286.3, w: 1.2, h: 3400, g: 80 },
        { x0: 287.9, w: 1.3, h: 1500, g: 80 }, { x0: 289.1, w: 1.4, h: 900, g: 80 }],
      baseline: { mode: 'linear', c0: 900, c1: -500 } },
    y0: [914.1674620308123, 934.8596704001757, 886.4024480666291],
    weighting: 'poisson',
    start: [
      { name: 'Curve 1', x0: 284.84404535675424, w: 0.8615986481541767, h: 15789.72252458334, g: 67.24784028949216 },
      { name: 'Curve 2', x0: 286.3631212935597, w: 1.193224950414151, h: 3386.464166115038, g: 69.85401699785143, lock: { g: true } },
      { name: 'Curve 3', x0: 287.8384466297691, w: 1.3205168175767177, h: 1362.7123133162968, g: 67.50778645044193 },
      { name: 'Curve 4', x0: 289.15986046950337, w: 1.390225776224397, h: 979.307655666489, g: 91.3931998074986 }],
    startBase: { mode: 'linear', c0: 836.5045198705047, c1: -538.11627891846, c2: 0, fit: true },
    peaks: [
      { x0: 284.79833394450884, w: 0.9982048382542204, h: 15897.133508035326, g: 81.01152416272517,
        se: { x0: 0.000761997759992468, h: 25.527999088292496, w: 0.001730063252119786, g: 0.45142455062042314 } },
      { x0: 286.28890457958636, w: 1.199653235010004, h: 3378.431156632063, g: 69.85401699785143,
        se: { x0: 0.005817205481891126, h: 51.083755251145305, w: 0.017282075809708666, g: null } },
      { x0: 287.910863333698, w: 1.3522692545908341, h: 1511.9514191993057, g: 45.73100714628771,
        se: { x0: 0.015597429343688149, h: 56.070218291583856, w: 0.07473948207092448, g: 24.40213585461465 } },
      { x0: 289.09257269899456, w: 1.4095720402202851, h: 784.7318068726064, g: 96.03366434692866,
        se: { x0: 0.032485034309682345, h: 89.39369204417683, w: 0.04564511486328445, g: 17.61296404330339 } }],
    base: { c0: 894.0872271736639, c1: -501.2985735137591 },
    stats: { chiRed: 0.9869036506344904, r2: 0.999816988991777, rmse: 47.58400381295906,
      quality: 0.9155364299321493, qualityWorst: 1.226694089106912, iters: 9 },
    conv: 'converged (χ² stationary)',
    worst: { rho: 0.9657009257027598, a: 'Curve 2.h', b: 'Curve 3.g' },
  },
];

for (const gc of GOLDEN) {
  test(`reproduces PeakForge's runFit exactly: ${gc.name}`, () => {
    const { x, y } = peakForgeSynth(gc.data);
    gc.y0.forEach((v, i) => assertClose(y[i], v, 1e-9 * Math.abs(v), `synthetic data y[${i}]`));
    const res = fitPeaks({ x, y, peaks: gc.start, weighting: gc.weighting,
      baseline: { ...gc.startBase, xMin: gc.data.xMin, xMax: gc.data.xMax } });
    const near = (a, b, what) => assertClose(a, b, 1e-8 * Math.max(Math.abs(b), 1e-300), what);
    gc.peaks.forEach((want, i) => {
      for (const k of ['x0', 'w', 'h', 'g']) {
        near(res.peaks[i][k], want[k], `peak ${i + 1} ${k}`);
        if (want.se[k] === null) assertEqual(res.peaks[i].se[k], null, `peak ${i + 1} se.${k}`);
        else near(res.peaks[i].se[k], want.se[k], `peak ${i + 1} se.${k}`);
      }
    });
    near(res.baseline.c0, gc.base.c0, 'c0');
    near(res.baseline.c1, gc.base.c1, 'c1');
    for (const k of ['chiRed', 'r2', 'rmse', 'quality', 'qualityWorst']) near(res.stats[k], gc.stats[k], k);
    assertEqual(res.stats.iters, gc.stats.iters, 'iterations');
    assertEqual(res.stats.conv, gc.conv);
    near(res.worstCorrelation.rho, gc.worst.rho, 'worst ρ');
    assertEqual(res.worstCorrelation.a, gc.worst.a);
    assertEqual(res.worstCorrelation.b, gc.worst.b);
    assertEqual(res.undersampled.length + res.insignificant.length, 0, 'no flags');
  });
}
