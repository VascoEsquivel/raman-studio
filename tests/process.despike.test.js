import { test, assert, assertEqual, assertClose, rng, gauss } from './harness.js';
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

// ---------------------------------------------------------------- model-based criteria
// The cases below come from the 2026-10 review on real lab spectra (wide tracks
// missed, narrow real bands removed by the old 3-point width cap) and from an
// adversarial synthetic sweep.

const gau = (x, c, w, h) => h * Math.exp(-4 * Math.LN2 * ((x - c) / w) ** 2);
/** Shot noise: σ ∝ √signal, as on a CCD. */
const shot = (y, seed) => { const r = rng(seed); return Float64Array.from(y, v => v + Math.sqrt(Math.max(v, 1)) * gauss(r)); };
const hits = (r, lo, hi) => r.removed.filter(p => p.index >= lo && p.index <= hi).length;

test('a wide jagged cosmic-ray track (9 points) is removed completely', () => {
  const track = [200, 600, 850, 690, 770, 870, 830, 1500, 420];
  for (const seed of [1, 2, 3]) {
    const y = shot(Float64Array.from(X, () => 20), seed);
    for (let k = 0; k < 9; k++) y[600 + k] += track[k];
    const r = despike(X, y);
    assertEqual(hits(r, 600, 608), 9, `seed ${seed}: all 9 points`);
    assert(r.removed.every(p => p.index >= 598 && p.index <= 610), `seed ${seed}: nothing else`);
    assertEqual(r.spikes.length, 1, `seed ${seed}: one event`);
    assertEqual(r.spikes[0].kind, 'cosmic');
  }
});

test('a track on top of a broad band is removed, the band under it is kept', () => {
  const track = [200, 600, 850, 690, 770, 870, 830, 1500, 420];
  const clean = shot(Float64Array.from(X, x => 100 + lor(x, 804, 40, 500)), 9);
  const y = Float64Array.from(clean);
  for (let k = 0; k < 9; k++) y[600 + k] += track[k];
  const r = despike(X, y);
  assertEqual(hits(r, 600, 608), 9, 'track removed');
  assertEqual(r.removed.filter(p => p.index < 598 || p.index > 610).length, 0, 'band flanks untouched');
  for (let i = 600; i <= 608; i++) assert(Math.abs(r.y[i] - clean[i]) < 60, `point ${i} restored near the band (${r.y[i]} vs ${clean[i]})`);
});

test('narrow strong real bands (FWHM 3–7 points, up to 20 000 counts, shot noise) are never touched', () => {
  for (const w of [3, 3.5, 4, 5, 7]) for (const h of [200, 2000, 20000]) for (const seed of [1, 2, 3, 4]) {
    const y = shot(Float64Array.from(X, x => 300 + lor(x, 500.3, w, h) + gau(x, 900.6, w, 0.7 * h)), 100 * w + seed);
    const r = despike(X, y);
    assertEqual(hits(r, 270, 330) + hits(r, 670, 730), 0, `FWHM ${w}, h ${h}, seed ${seed}`);
  }
});

test('a close doublet of narrow bands is kept', () => {
  for (const sep of [4, 5, 7]) for (const seed of [1, 2, 3]) {
    const y = shot(Float64Array.from(X, x => 300 + lor(x, 600, 4, 1500) + lor(x, 600 + sep, 4, 1100)), seed + 10 * sep);
    assertEqual(despike(X, y).removed.length, 0, `separation ${sep}, seed ${seed}`);
  }
});

test('a narrow band on the steep flank of a broad one, and an asymmetric (Fano) band, are kept', () => {
  for (const seed of [1, 2, 3]) {
    const y = shot(Float64Array.from(X, x => 200 + lor(x, 600, 60, 5000) + lor(x, 630, 4, 600)), seed);
    assertEqual(despike(X, y).removed.length, 0, `flank, seed ${seed}`);
    const f = shot(Float64Array.from(X, x => { const e = 2 * (x - 600) / 15; return 200 + 3000 * (1 - e / 4) ** 2 / (1 + e * e); }), seed);
    assertEqual(despike(X, f).removed.length, 0, `Fano, seed ${seed}`);
  }
});

test('steps in the baseline (stitched scans) are not mistaken for spikes', () => {
  for (const h of [50, 300, 3000]) for (const seed of [1, 2, 3]) {
    const y = shot(Float64Array.from(X, x => 500 + (x >= 800 ? h : 0)), seed);
    assertEqual(despike(X, y).removed.length, 0, `step ${h}, seed ${seed}`);
  }
});

test('a spike on the apex of a narrow band: only the spike goes', () => {
  const clean = shot(Float64Array.from(X, x => 200 + lor(x, 600, 6, 1200)), 4);
  const y = Float64Array.from(clean); y[400] += 1500;
  const r = despike(X, y);
  assert(r.removed.some(p => p.index === 400), 'spike removed');
  assert(r.removed.length <= 3, `at most the spike and a shoulder: ${r.removed.map(p => p.index)}`);
  for (let i = 396; i <= 404; i++) {
    if (r.removed.some(p => p.index === i)) assert(Math.abs(r.y[i] - clean[i]) < 0.1 * 1200, `point ${i} replaced within 10 % of the band (${Math.round(r.y[i])} vs ${Math.round(clean[i])})`);
    else assert(r.y[i] === y[i], `point ${i} untouched`);
  }
});

test('decisions do not depend on the intensity scale', () => {
  const y = shot(Float64Array.from(X, x => 300 + lor(x, 500, 20, 900)), 3);
  y[300] += 400; y[700] += 250; y[701] += 500;
  for (let k = 0; k < 7; k++) y[950 + k] += [200, 500, 300, 700, 650, 1200, 300][k];
  const key = r => r.removed.map(p => p.index).join(',');
  const a = despike(X, y);
  assert(a.spikes.length >= 3, 'three events found');
  assertEqual(key(despike(X, y.map(v => v / 1e4))), key(a), 'scaled down');
  assertEqual(key(despike(X, y.map(v => v * 1e3))), key(a), 'scaled up');
});

test('minBandCm: a 2-point-wide real line is removed under the 3-point default and kept when declared', () => {
  const y = shot(Float64Array.from(X, x => 200 + gau(x, 520, 2, 3000)), 5);
  const auto = despike(X, y), declared = despike(X, y, { minBandCm: 1.5 });
  assert(hits(auto, 316, 324) > 0, 'auto (3 points) treats it as too sharp to be real');
  assertEqual(hits(declared, 316, 324), 0, 'declared narrowest band 1.5 cm⁻¹ keeps it');
  assertEqual(auto.info.minBandAuto, true); assertClose(auto.info.minBandCm, 3, 1e-9);
  assertEqual(declared.info.minBandAuto, false); assertClose(declared.info.minBandPts, 1.5, 1e-9);
});

test('companions: a feature the other spectra share is real, a one-point one is a detector artifact', () => {
  const N2 = 800, X2 = X.slice(0, N2);
  const mk = (k, f) => shot(Float64Array.from(X2, f), 1000 + k);
  // narrow line in every spectrum, too sharp for the default: put back as recurring
  const si = k => mk(k, x => 100 + gau(x, 520, 2, 900 + 40 * k));
  const r = despike(X2, si(50), { companions: [...Array(8)].map((_, k) => si(k)) });
  assertEqual(hits(r, 316, 324), 0, 'shared narrow line kept');
  assert(r.restored.some(e => e.kind === 'recurring' && e.share >= 0.2), 'reported as recurring');
  assertEqual(r.info.companions, 8);
  // hot pixel at the same index everywhere
  const hp = k => { const v = mk(k, () => 100); v[700] += 300; return v; };
  const r2 = despike(X2, hp(77), { companions: [...Array(8)].map((_, k) => hp(k)) });
  const e = r2.spikes.find(s => s.start === 700);
  assert(e && e.kind === 'artifact' && e.share > 0.5, 'labelled artifact');
  // a cosmic ray on the apex of a band the companions share is still a cosmic ray
  const band = k => mk(k, x => 100 + lor(x, 600, 30, 400 + 30 * k));
  const comps3 = [...Array(8)].map((_, k) => band(k));
  const y = band(99); y[399] += 1600; y[401] += 700;
  const r3 = despike(X2, y, { companions: comps3 });
  assert(r3.spikes.some(s => s.start <= 399 && s.end >= 399 && s.kind === 'cosmic'), 'still removed');
  assertEqual(r3.restored.length, 0, 'not put back because the others have the band');
  assert(r3.removed.every(p => p.index >= 398 && p.index <= 402), 'the band itself is kept');
  // a bell-shaped 3-point spike there could be a ~2-point band: left in place but listed
  const yb = band(99); yb[398] += 900; yb[399] += 1600; yb[400] += 500;
  const r4 = despike(X2, yb, { companions: comps3 });
  assert(r4.spikes.some(s => s.start <= 399 && s.end >= 399) || r4.suspects.some(s => s.start <= 399 && s.end >= 399 && s.share === 0),
    'removed, or listed as unique to this spectrum');
  // fewer than 4 companions are ignored
  assertEqual(despike(X2, si(50), { companions: [si(1), si(2)] }).info.companions, 0);
});

test('edits: keep restores an automatic removal, zaps interpolate by hand', () => {
  const y = shot(Float64Array.from(X, () => 100), 3); y[400] += 500;
  assertEqual(despike(X, y).spikes.length, 1);
  const kept = despike(X, y, { edits: { keep: [X[400]] } });
  assertEqual(kept.spikes.length, 0);
  assertEqual(kept.restored[0].kind, 'kept');
  assert(kept.y[400] === y[400], 'value back');
  const zapped = despike(X, y, { edits: { zaps: [[X[505], X[500]]] } });
  const z = zapped.spikes.find(s => s.kind === 'manual');
  assert(z && z.start === 500 && z.end === 505, 'zap range, ends in either order');
  for (let i = 500; i <= 505; i++) assertClose(zapped.y[i], y[499] + (y[506] - y[499]) * (i - 499) / 7, 1e-9, `interpolated ${i}`);
  assert(zapped.spikes.some(s => s.kind === 'cosmic'), 'automatic removal still there');
});

test('result shape: events, suspects, restored and info are always present', () => {
  const y = shot(Float64Array.from(X, () => 100), 8); y[300] += 400;
  const r = despike(X, y);
  for (const k of ['y', 'removed', 'spikes', 'suspects', 'restored', 'info']) assert(k in r, k);
  for (const k of ['sigma', 'shotNoise', 'spacing', 'minBandPts', 'minBandCm', 'minBandAuto', 'maxWidth', 'threshold', 'companions']) assert(k in r.info, 'info.' + k);
  const s = r.spikes[0];
  for (const k of ['start', 'end', 'xStart', 'xEnd', 'height', 'kind', 'misfit', 'share']) assert(k in s, 'spike.' + k);
  assertEqual(s.xStart, X[s.start]);
  const empty = despike([], []);
  assertEqual(empty.spikes.length + empty.suspects.length + empty.restored.length, 0);
});
