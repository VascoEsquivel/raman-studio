// Atlas-seeded deconvolution. Spectra are synthesised from the atlas's own
// schematic curves (plot.mu / A / sig) so no band data is invented here; the
// PreparedBand objects are built exactly as match/library.js builds them for the
// reference laser (no dispersion shift, window = range ± toleranceCm).
import { test, assert, assertEqual, assertClose, assertDeepEqual, rng, gauss } from './harness.js';
import { deconvolve } from '../js/fit/deconvolve.js';
import { peakY } from '../js/fit/profile.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const FD = lib.fitDefaults;
const SIG_TO_FWHM = 2.3548;
const FIRST = lib.bands.filter(b => b.region === 'first').map(b => b.id);
const SECOND = lib.bands.filter(b => b.region === 'second').map(b => b.id);

function prepareBands() {
  const tol = lib.matchDefaults.toleranceCm;
  return lib.bands.map(b => ({
    id: b.id, label: b.label, name: b.name, order: b.region,
    center: b.posSort, shift: 0, range: [...b.match.range],
    window: [b.match.range[0] - tol, b.match.range[1] + tol], widen: 0,
    fwhmSeed: b.fit.fwhmSeed, dispersion: b.match.dispersion, band: b,
  }));
}

// GO-like spectrum: every atlas band as a pseudo-Voigt (60 % Gaussian is an
// arbitrary synthetic choice), on a sloping background, with mild noise.
// `shift` / `widen` / `amp` perturb the truth away from the atlas seeds.
function synthGO({ lo = 800, hi = 3500, seed = 1, noise = 6, shift = {}, widen = {}, amp = {} } = {}) {
  const r = rng(seed), n = Math.round(hi - lo) + 1;
  const x = Float64Array.from({ length: n }, (_, i) => lo + i);
  const truth = lib.bands.map(b => ({
    id: b.id, x0: b.plot.mu + (shift[b.id] || 0), w: b.plot.sig * SIG_TO_FWHM * (widen[b.id] || 1),
    h: 1000 * b.plot.A * (amp[b.id] ?? 1), g: 60,
  }));
  const y = Float64Array.from(x, v => {
    let s = 40 + 0.015 * (v - 800);
    for (const p of truth) s += peakY(p, v);
    return s + noise * gauss(r);
  });
  return { x, y, truth: Object.fromEntries(truth.map(p => [p.id, p])) };
}

const byId = (res, id) => res.components.find(c => c.bandId === id);
const opts = { fitDefaults: FD };

test('GO-like spectrum: D, G and 2D recovered, bounds respected, windows fit to the noise', () => {
  const prepared = prepareBands();
  const { x, y, truth } = synthGO({ seed: 3 });
  const res = deconvolve(x, y, prepared, opts);
  assertEqual(res.skipped.length, 0, 'nothing skipped');
  assertEqual(res.windows.length, 2, 'one window per order');
  assertDeepEqual([...res.windows[0].bandIds].sort(), [...FIRST].sort(), 'first-order window');
  assertDeepEqual([...res.windows[1].bandIds].sort(), [...SECOND].sort(), 'second-order window');
  assertDeepEqual(res.components.map(c => c.bandId), lib.bands.map(b => b.id), 'components in band order');
  for (const id of ['D', 'G', 'twoD']) {
    const c = byId(res, id);
    assert(Math.abs(c.x0 - truth[id].x0) < 5, `${id} centre ${c.x0.toFixed(2)} vs ${truth[id].x0}`);
    assert(c.significant, `${id} significant`);
  }
  for (const w of res.windows.filter(w => w.bandIds.every(id => FIRST.includes(id)))) {
    assert(w.stats.quality < 2, `first-order window quality ${w.stats.quality}`);
  }
  for (const c of res.components) {
    const band = prepared.find(b => b.id === c.bandId);
    assert(c.h >= 0, `${c.bandId} height ${c.h}`);
    assert(c.w >= FD.fwhmMin && c.w <= FD.fwhmMax, `${c.bandId} width ${c.w}`);
    assert(c.x0 >= band.window[0] && c.x0 <= band.window[1], `${c.bandId} centre inside its window`);
    assert(res.windows[c.windowIndex].bandIds.includes(c.bandId), `${c.bandId} windowIndex`);
    assert(c.area > 0 && Number.isFinite(c.se.h), `${c.bandId} area and σ_h`);
  }
  // Windows span the band windows ± windowPadCm.
  assertEqual(res.windows[0].lo, 1150 - 25 - FD.windowPadCm);
  assertEqual(res.windows[0].hi, 1620 + 25 + FD.windowPadCm);
  const w0 = res.windows[0];
  assertEqual(w0.residual.x.length, w0.residual.r.length);
  assertEqual(w0.baseline.mode, 'linear');
});

test('model(x) follows the data inside windows and is NaN outside', () => {
  const { x, y } = synthGO({ seed: 4 });
  const res = deconvolve(x, y, prepareBands(), opts);
  for (const xv of [850, 1000, 2000, 2200, 3450]) assert(Number.isNaN(res.model(xv)), `NaN at ${xv}`);
  for (const xv of [1180, 1350, 1585, 2690, 2935]) {
    const i = xv - 800;
    assert(Math.abs(res.model(xv) - y[i]) < 30, `model(${xv}) = ${res.model(xv)} vs data ${y[i]}`);
  }
  const arr = res.model([1350, 2000]);
  assert(arr instanceof Float64Array && Number.isFinite(arr[0]) && Number.isNaN(arr[1]), 'array form');
});

test('a 1000–2000 cm⁻¹ spectrum fits only the first-order bands', () => {
  const { x, y } = synthGO({ lo: 1000, hi: 2000, seed: 5 });
  const res = deconvolve(x, y, prepareBands(), opts);
  assertEqual(res.windows.length, 1);
  assertDeepEqual(res.components.map(c => c.bandId), FIRST);
  assertDeepEqual(res.skipped.map(s => s.bandId).sort(), [...SECOND].sort());
  for (const s of res.skipped) assert(/outside the data/.test(s.reason), s.reason);
  assert(res.windows[0].lo >= 1000 && res.windows[0].hi <= 2000, 'window clipped to the data');
  assert(Number.isNaN(res.model(2690)), 'no model where nothing was fitted');
});

test('truth moved away from the atlas seeds is still found', () => {
  const { x, y, truth } = synthGO({ seed: 6,
    shift: { D: -7, G: 8, twoD: -9, Dp: 3 }, widen: { D: 0.8, G: 0.75, twoD: 1.2 } });
  const res = deconvolve(x, y, prepareBands(), opts);
  for (const id of ['D', 'G', 'twoD']) {
    const c = byId(res, id);
    assert(Math.abs(c.x0 - truth[id].x0) < 5, `${id} centre ${c.x0.toFixed(2)} vs ${truth[id].x0}`);
    assert(Math.abs(c.w - truth[id].w) < 0.15 * truth[id].w, `${id} width ${c.w.toFixed(1)} vs ${truth[id].w.toFixed(1)}`);
  }
  assert(res.windows[0].stats.quality < 2, `quality ${res.windows[0].stats.quality}`);
});

test('a band absent from the data comes out not significant', () => {
  // Monolayer-like: no defect bands at all.
  const { x, y } = synthGO({ seed: 7, amp: { D: 0, Dstar: 0, Dpp: 0, Dp: 0 } });
  const res = deconvolve(x, y, prepareBands(), opts);
  const D = byId(res, 'D'), G = byId(res, 'G');
  assert(!D.significant, `D h ${D.h} ± ${D.se.h}`);
  assert(G.significant, 'G still significant');
  assert(Number.isFinite(G.se.x0), 'other components keep their uncertainties');
  for (const c of res.components) assert(c.h >= 0, `${c.bandId} h ≥ 0`);
});

// ---- model selection (fitDefaults.modelSelection: BIC over the optional bands)
const SEL = lib.fitDefaults.modelSelection;

test('model selection: optional bands the data do not support are left out, by BIC', () => {
  // D and G but no D*, D″ or D′
  const { x, y } = synthGO({ seed: 11, amp: { Dstar: 0, Dpp: 0, Dp: 0 } });
  const res = deconvolve(x, y, prepareBands(), opts);
  const w = res.windows[0];
  assertDeepEqual(w.selection.kept, [], 'no optional band kept');
  assertDeepEqual([...w.bandIds].sort(), FIRST.filter(id => !SEL.optional.includes(id)).sort(), 'fitted bands');
  for (const id of SEL.optional) {
    assert(!byId(res, id), `${id} not among the components`);
    const s = res.skipped.find(q => q.bandId === id);
    assert(s && /model selection/.test(s.reason), `${id} listed as left out (${s && s.reason})`);
  }
  assert(byId(res, 'D').significant && byId(res, 'G').significant, 'D and G significant');
  // every candidate set fitted on the same data, best first, BIC = n·ln(χ²/n) + k·ln n
  const M = w.selection.models;
  assertEqual(M.length, 1 << SEL.optional.length, 'every subset tried');
  assert(M.every(m => m.n === w.stats.n), 'same data window for every set');
  assertEqual(M[0].dBic, 0);
  for (let i = 1; i < M.length; i++) assert(M[i].bic >= M[i - 1].bic, 'sorted by BIC');
  const chi2 = w.stats.chiRed * Math.max(1, w.stats.n - w.stats.npar);
  assertClose(M[0].bic, w.stats.n * Math.log(chi2 / w.stats.n) + w.stats.npar * Math.log(w.stats.n), 1e-6, 'BIC formula');
  assertEqual(res.windows[1].selection, null, 'no optional bands in the second-order window');
});

test('model selection keeps the optional bands the data need, and only those', () => {
  const all = deconvolve(...Object.values(synthGO({ seed: 12 })).slice(0, 2), prepareBands(), opts);
  assertDeepEqual([...all.windows[0].selection.kept].sort(), [...SEL.optional].sort(), 'all three present: all kept');
  const noDp = deconvolve(...Object.values(synthGO({ seed: 12, amp: { Dp: 0 } })).slice(0, 2), prepareBands(), opts);
  assertDeepEqual([...noDp.windows[0].selection.kept].sort(), SEL.optional.filter(id => id !== 'Dp').sort(), 'D′ absent: the other two kept');
});

test('select: false fits every band, as before model selection', () => {
  const { x, y } = synthGO({ seed: 11, amp: { Dstar: 0, Dpp: 0, Dp: 0 } });
  const res = deconvolve(x, y, prepareBands(), { ...opts, select: false });
  assertDeepEqual([...res.windows[0].bandIds].sort(), [...FIRST].sort());
  assertEqual(res.windows[0].selection, null);
  assertEqual(res.skipped.length, 0);
});

test('a runner-up band set is reported only within closeCall BIC units', () => {
  for (const seed of [21, 22, 23, 24]) {
    const { x, y } = synthGO({ seed, noise: 25, amp: { Dp: 0.25, Dpp: 0.4 } });
    const s = deconvolve(x, y, prepareBands(), opts).windows[0].selection;
    if (s.runnerUp) {
      assert(s.runnerUp.dBic <= SEL.closeCall, `runner-up ΔBIC ${s.runnerUp.dBic}`);
      assertDeepEqual(s.runnerUp.kept, s.models[1].kept, 'runner-up is the second-best set');
      assert(s.runnerUp.components.some(c => c.bandId === 'G'), 'with its own components');
    } else {
      assert(s.models[1].dBic > SEL.closeCall, `no runner-up, next ΔBIC ${s.models[1].dBic}`);
    }
  }
});
