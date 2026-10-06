// Synthetic demo spectra: deterministic per seed, shaped by the atlas, with the
// documented spikes. Band positions and monolayer criteria are read from the
// library here too, never typed in, so the tests check the generator against
// the atlas rather than against itself.
import { test, assert, assertEqual, assertClose, assertThrows } from './harness.js';
import { synthFromLibrary, synthMonolayer } from '../js/sample/synth.js';
import { peakY } from '../js/fit/profile.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const band = id => lib.bands.find(b => b.id === id);

/** Centred moving average, so argmax of a noisy broad band lands near its true top. */
function smooth(y, half) {
  const out = new Float64Array(y.length);
  for (let i = 0; i < y.length; i++) {
    let s = 0, k = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(y.length - 1, i + half); j++) { s += y[j]; k++; }
    out[i] = s / k;
  }
  return out;
}

/** Index of the maximum of y over lo < x < hi. */
function argmaxIn(x, y, lo, hi) {
  let best = -1;
  for (let i = 0; i < x.length; i++) if (x[i] > lo && x[i] < hi && (best < 0 || y[i] > y[best])) best = i;
  return best;
}

/** Robust noise σ from first differences (median |Δ| / (0.6745·√2)). */
function noiseSigma(y) {
  const d = [];
  for (let i = 1; i < y.length; i++) d.push(Math.abs(y[i] - y[i - 1]));
  d.sort((a, b) => a - b);
  return d[d.length >> 1] / (0.6745 * Math.SQRT2);
}

function minus(a, b) { return Float64Array.from(a, (v, i) => v - b[i]); }

/** Copy of y with the recorded spike points replaced by their neighbours' mean. */
function withoutSpikes(y, spikes) {
  const out = Float64Array.from(y);
  for (const s of spikes) {
    const v = (y[s.start - 1] + y[s.end + 1]) / 2;
    for (let i = s.start; i <= s.end; i++) out[i] = v;
  }
  return out;
}

test('GO demo: Spectrum shape and synthetic meta', () => {
  const s = synthFromLibrary(lib, { seed: 7 });
  for (const k of ['id', 'name', 'x', 'y', 'xLabel', 'xUnit', 'yLabel', 'source', 'meta']) assert(k in s, 'has ' + k);
  assert(s.x instanceof Float64Array && s.y instanceof Float64Array, 'Float64Array x/y');
  assertEqual(s.xLabel, 'Raman shift');
  assertEqual(s.xUnit, 'cm⁻¹');
  assertEqual(s.source.format, 'synthetic');
  assert(typeof s.source.file === 'string' && s.source.file.length > 0, 'source.file');
  assertEqual(s.meta.synthetic, true);
  assertEqual(s.meta.seed, 7);
  assert(/not measured/i.test(s.meta.description), 'description says it is synthetic');
  assert(/app choices/i.test(s.meta.description), 'description separates app choices from atlas data');
  assertEqual(s.meta.laserNm, lib.referenceExcitation.nm);
});

test('GO demo: deterministic per seed, different across seeds', () => {
  const a = synthFromLibrary(lib, { seed: 3 }), b = synthFromLibrary(lib, { seed: 3 }), c = synthFromLibrary(lib, { seed: 4 });
  assertEqual(a.y.length, b.y.length);
  for (let i = 0; i < a.y.length; i++) if (a.y[i] !== b.y[i] || a.x[i] !== b.x[i]) throw new Error('differs at ' + i);
  assertEqual(JSON.stringify(a.meta.spikes), JSON.stringify(b.meta.spikes));
  let diff = 0;
  for (let i = 0; i < a.y.length; i++) if (a.y[i] !== c.y[i]) diff++;
  assert(diff > a.y.length / 2, 'another seed gives another noise realisation');
});

test('GO demo: ascending x, requested length and range', () => {
  const s = synthFromLibrary(lib, { seed: 1 });
  assertEqual(s.x.length, 1801);
  assertEqual(s.y.length, 1801);
  for (let i = 1; i < s.x.length; i++) assert(s.x[i] > s.x[i - 1], 'ascending at ' + i);
  const t = synthFromLibrary(lib, { seed: 1, n: 500, xMin: 1000, xMax: 3300 });
  assertEqual(t.x.length, 500);
  assertEqual(t.x[0], 1000);
  assertEqual(t.x[499], 3300);
  for (let i = 0; i < t.y.length; i++) assert(Number.isFinite(t.y[i]), 'finite y');
});

test('GO demo: one component per atlas band, from plot.mu / A / sig', () => {
  const s = synthFromLibrary(lib, { seed: 1, gaussianPct: 40 });
  assertEqual(s.meta.components.length, lib.bands.length);
  const maxA = Math.max(...lib.bands.map(b => b.plot.A));
  for (const b of lib.bands) {
    const c = s.meta.components.find(k => k.bandId === b.id);
    assert(c, 'component for ' + b.id);
    assertEqual(c.x0, b.plot.mu);
    assertClose(c.w, b.plot.sig * 2.3548, 1e-9, b.id + ' w');
    assertClose(c.h, b.plot.A / maxA * 4000, 1e-9, b.id + ' h');
    assertEqual(c.g, 40);
  }
});

test('GO demo: D, G and 2D maxima sit at the atlas centres once the background is removed', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const s = synthFromLibrary(lib, { seed });
    const bg = synthFromLibrary(lib, { seed, peakCounts: 0, noise: 0, spikes: 0 }).y;
    const net = withoutSpikes(minus(s.y, bg), s.meta.spikes);
    for (const [id, half, tol] of [['D', 5, 10], ['G', 5, 10], ['twoD', 10, 15]]) {
      const b = band(id), ys = smooth(net, half);
      const i = argmaxIn(s.x, ys, b.posSort - 80, b.posSort + 80);
      assert(s.x[i] > b.posSort - 75 && s.x[i] < b.posSort + 75, `${id} max not at the search edge (seed ${seed})`);
      assertClose(s.x[i], b.posSort, tol, `${id} apparent maximum (seed ${seed})`);
    }
  }
});

test('GO demo: background is smooth and positive, noise scales like shot noise', () => {
  const bg = synthFromLibrary(lib, { seed: 1, peakCounts: 0, noise: 0, spikes: 0 }).y;
  for (let i = 0; i < bg.length; i++) assert(bg[i] > 0, 'positive background');
  const flat = synthFromLibrary(lib, { seed: 1, peakCounts: 0, spikes: 0 });
  const sigma = noiseSigma(minus(flat.y, bg));
  const meanBg = bg.reduce((a, v) => a + v, 0) / bg.length;
  // Poisson-like: σ ≈ √counts. Allow a generous band for the varying background.
  assert(sigma > 0.7 * Math.sqrt(meanBg) && sigma < 1.3 * Math.sqrt(meanBg), `σ ${sigma.toFixed(1)} vs √bg ${Math.sqrt(meanBg).toFixed(1)}`);
  // noise: 0 → exactly background + the pseudo-Voigt components.
  const quiet = synthFromLibrary(lib, { seed: 1, noise: 0, spikes: 0 });
  for (let i = 0; i < quiet.x.length; i += 37) {
    const model = bg[i] + quiet.meta.components.reduce((a, c) => a + peakY(c, quiet.x[i]), 0);
    assertClose(quiet.y[i], model, 1e-6 * model, 'noise-free model at ' + quiet.x[i]);
  }
});

test('GO demo: three cosmic-ray spikes, 1, 2 and 3 points wide, where meta.spikes says', () => {
  for (const seed of [1, 2, 3, 11, 99]) {
    const s = synthFromLibrary(lib, { seed });
    const clean = synthFromLibrary(lib, { seed, spikes: 0 });
    const spikes = s.meta.spikes;
    assertEqual(spikes.length, 3, 'three spikes');
    assertEqual(spikes.map(p => p.width).sort().join(','), '1,2,3', 'widths');
    const sigma = noiseSigma(clean.y);
    const inSpike = new Set();
    for (const p of spikes) {
      assertEqual(p.end - p.start + 1, p.width, 'start/end match width');
      assertEqual(p.xStart, s.x[p.start]);
      assertEqual(p.xEnd, s.x[p.end]);
      let top = 0;
      for (let i = p.start; i <= p.end; i++) {
        inSpike.add(i);
        const excess = s.y[i] - clean.y[i];
        assert(excess > 20 * sigma, `spike point ${i} stands out (seed ${seed})`);
        top = Math.max(top, excess);
      }
      assertClose(top, p.height, 1e-6, 'recorded height');
      // A spike is narrow: the neighbours outside it are untouched.
      assertEqual(s.y[p.start - 1], clean.y[p.start - 1]);
      assertEqual(s.y[p.end + 1], clean.y[p.end + 1]);
    }
    for (let i = 0; i < s.y.length; i++) if (!inSpike.has(i)) assertEqual(s.y[i], clean.y[i], 'only spike points differ');
  }
});

test('GO demo: spikes keep the same positions when noise is switched off', () => {
  const a = synthFromLibrary(lib, { seed: 5 }), b = synthFromLibrary(lib, { seed: 5, noise: 0 });
  assertEqual(JSON.stringify(a.meta.spikes.map(p => p.start)), JSON.stringify(b.meta.spikes.map(p => p.start)));
});

test('GO demo: refuses a library without a band schematic', () => {
  assertThrows(() => synthFromLibrary({ bands: [{ id: 'x' }] }), /schematic/);
});

test('monolayer: G and 2D at the atlas positions, no D band', () => {
  const s = synthMonolayer(lib, { seed: 2 });
  const bg = synthMonolayer(lib, { seed: 2, peakCounts: 0, noise: 0 }).y;
  const net = minus(s.y, bg);
  const G = band('G'), T = band('twoD'), D = band('D');
  const iG = argmaxIn(s.x, net, G.posSort - 60, G.posSort + 60);
  const iT = argmaxIn(s.x, net, T.posSort - 60, T.posSort + 60);
  assertClose(s.x[iG], G.posSort, 3, 'G position');
  assertClose(s.x[iT], T.posSort, 3, '2D position');
  // No D: nothing in the D window rises above the noise.
  const sigma = noiseSigma(net);
  const iD = argmaxIn(s.x, smooth(net, 5), D.posSort - 60, D.posSort + 60);
  assert(smooth(net, 5)[iD] < 3 * sigma, `no D-band peak (max ${smooth(net, 5)[iD].toFixed(1)} vs σ ${sigma.toFixed(1)})`);
  assert(!s.meta.components.some(c => c.bandId === 'D' || c.bandId === 'Dp'), 'no defect bands in the model');
  assertEqual(s.meta.spikes.length, 0);
  assertEqual(s.meta.synthetic, true);
  assertEqual(s.source.format, 'synthetic');
});

test('monolayer: 2D/G height ratio and 2D FWHM follow the atlas statement', () => {
  // The criteria come from the atlas ratio card text, e.g. "FWHM ≈ 24–30 cm⁻¹, I_2D/I_G ≈ 2".
  const card = lib.ratios.flatMap(r => r.eqs).find(e => /monolayer/.test(e));
  const [, lo, hi] = /FWHM\s*≈\s*(\d+)\s*[–-]\s*(\d+)/.exec(card).map(Number);
  const ratio = Number(/I_2D\/I_G\s*≈\s*(\d+(?:\.\d+)?)/.exec(card)[1]);

  const noisy = synthMonolayer(lib, { seed: 9 });
  const bg = synthMonolayer(lib, { seed: 9, peakCounts: 0, noise: 0 }).y;
  const net = minus(noisy.y, bg);
  const G = band('G'), T = band('twoD');
  const hG = net[argmaxIn(noisy.x, net, G.posSort - 40, G.posSort + 40)];
  const hT = net[argmaxIn(noisy.x, net, T.posSort - 40, T.posSort + 40)];
  assertClose(hT / hG, ratio, 0.2, '2D/G height ratio (noisy)');

  const quiet = synthMonolayer(lib, { seed: 9, noise: 0 });
  const qn = minus(quiet.y, synthMonolayer(lib, { seed: 9, peakCounts: 0, noise: 0 }).y);
  const qG = qn[argmaxIn(quiet.x, qn, G.posSort - 40, G.posSort + 40)];
  const iT = argmaxIn(quiet.x, qn, T.posSort - 40, T.posSort + 40);
  assertClose(qn[iT] / qG, ratio, 0.05, '2D/G height ratio (noise-free)');
  // FWHM by linear interpolation of the half-maximum crossings.
  const half = qn[iT] / 2;
  let l = iT, r = iT;
  while (qn[l] > half) l--;
  while (qn[r] > half) r++;
  const xl = quiet.x[l] + (half - qn[l]) / (qn[l + 1] - qn[l]) * (quiet.x[l + 1] - quiet.x[l]);
  const xr = quiet.x[r - 1] + (half - qn[r - 1]) / (qn[r] - qn[r - 1]) * (quiet.x[r] - quiet.x[r - 1]);
  const fwhm = xr - xl;
  assert(fwhm >= lo && fwhm <= hi, `2D FWHM ${fwhm.toFixed(2)} inside the atlas ${lo}–${hi} cm⁻¹`);
  assert(/app choices/i.test(quiet.meta.description) && /G FWHM/.test(quiet.meta.description), 'G width documented as an app choice');
});

test('monolayer: deterministic per seed, ascending x', () => {
  const a = synthMonolayer(lib, { seed: 12 }), b = synthMonolayer(lib, { seed: 12 });
  for (let i = 0; i < a.y.length; i++) if (a.y[i] !== b.y[i]) throw new Error('differs at ' + i);
  for (let i = 1; i < a.x.length; i++) assert(a.x[i] > a.x[i - 1], 'ascending');
  assertEqual(a.id, b.id);
});

test('monolayer: refuses a library without G / 2D', () => {
  assertThrows(() => synthMonolayer({ bands: [band('D')] }), /G and 2D/);
});
