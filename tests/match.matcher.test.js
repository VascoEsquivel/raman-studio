// Peak → band assignment. Real-library cases use graphene-go windows prepared
// for a laser; the tie-break cases use synthetic abstract bands (A, B) so the
// numbers can be chosen to tie exactly.
import { test, assert, assertEqual, assertClose, assertDeepEqual } from './harness.js';
import { prepareLibrary } from '../js/match/library.js';
import { bandConfidence, matchPeaks } from '../js/match/matcher.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const p532 = prepareLibrary(lib, { laserNm: 532 });
const p785 = prepareLibrary(lib, { laserNm: 785 });
const band = (p, id) => p.bands.find(b => b.id === id);
const peak = (id, x) => ({ id, index: 0, x, y: 100, prominence: 50, fwhm: 20, leftX: x - 10, rightX: x + 10, snr: 30 });

test('bandConfidence is 1 at the centre and e^−2 at either window edge', () => {
  const D = band(p532, 'D');                       // window [1325, 1375], centre 1350
  assertClose(bandConfidence(1350, D), 1, 1e-15);
  assertClose(bandConfidence(1375, D), Math.exp(-2), 1e-12);
  assertClose(bandConfidence(1325, D), Math.exp(-2), 1e-12);
  assertClose(bandConfidence(1337.5, D), Math.exp(-0.5), 1e-12, 'half-way → exp(−0.5)');
  assertEqual(bandConfidence(1375.01, D), 0);
  assertEqual(bandConfidence(1300, D), 0);
  assertEqual(bandConfidence(NaN, D), 0);
});

test('bandConfidence scales each side of an asymmetric window separately', () => {
  const G = band(p532, 'G');                       // window [1555, 1625], centre 1585
  assertClose(bandConfidence(1555, G), Math.exp(-2), 1e-12, 'left edge, dmax 30');
  assertClose(bandConfidence(1625, G), Math.exp(-2), 1e-12, 'right edge, dmax 40');
  assertClose(bandConfidence(1600, G), Math.exp(-2 * (15 / 40) ** 2), 1e-12);
  assertClose(bandConfidence(1570, G), Math.exp(-2 * (15 / 30) ** 2), 1e-12);
  // Zero-width window: exactly on centre or nothing.
  const pin = { center: 10, window: [10, 10] };
  assertEqual(bandConfidence(10, pin), 1);
  assertEqual(bandConfidence(10.1, pin), 0);
});

test('matchPeaks labels a typical GO peak list and keeps input order', () => {
  const peaks = [peak('p2', 1588), peak('p1', 1351), peak('p3', 2692), peak('p4', 1619), peak('p5', 2938), peak('p6', 1178)];
  const a = matchPeaks(peaks, p532);
  assertEqual(a.length, peaks.length);
  assertDeepEqual(a.map(x => x.peakId), ['p2', 'p1', 'p3', 'p4', 'p5', 'p6']);
  assertDeepEqual(a.map(x => x.bandId), ['G', 'D', 'twoD', 'Dp', 'DDp', 'Dstar']);
  assertDeepEqual(a.map(x => x.label), ['G', 'D', '2D', 'D′', 'D+D′', 'D*']);
  for (const x of a) assertEqual(x.kind, 'band');
  assertClose(a[1].delta, 1, 1e-12);
  assertClose(a[1].confidence, Math.exp(-2 * (1 / 25) ** 2), 1e-12);
  assertEqual(a[1].x, 1351);
});

test('one-to-one: two peaks near D — only the closer one gets D', () => {
  const a = matchPeaks([peak('a', 1360), peak('b', 1345)], p532);
  assertEqual(a[1].bandId, 'D', 'closer peak (higher confidence) wins');
  assert(a[0].bandId !== 'D', 'the other peak does not also get D');
  assertEqual(a[0].kind, 'unassigned');
  assertEqual(a[0].confidence, 0);
  assertEqual(a[0].delta, null);
  assert(a[0].alternatives.some(x => x.bandId === 'D' && x.confidence > 0), 'D offered as an alternative');
  assertClose(a[0].alternatives[0].confidence, Math.exp(-2 * (10 / 25) ** 2), 1e-12);
});

test('a contested peak falls back to its next-best band', () => {
  // On its own, 1600 prefers G (G: d = 15 of 40; D′ window 1595–1645: d = 20 of 25).
  const b = matchPeaks([peak('x', 1600)], p532);
  assertEqual(b[0].bandId, 'G');
  assertDeepEqual(b[0].alternatives.map(x => x.bandId), ['G', 'Dp']);
  // With a better G peak present, 1600 loses G and takes D′, its next candidate.
  const a = matchPeaks([peak('g', 1586), peak('s', 1600)], p532);
  assertEqual(a[0].bandId, 'G');
  assertEqual(a[1].bandId, 'Dp');
  assertClose(a[1].confidence, Math.exp(-2 * (20 / 25) ** 2), 1e-12);
  assertDeepEqual(a[1].alternatives.map(x => x.bandId), ['G', 'Dp'], 'every candidate listed, best first');
});

test('ties: equal confidence goes to the smaller |delta|', () => {
  const prep = { bands: [{ id: 'A', label: 'A', center: 100, window: [80, 140] }], regions: [] };
  // 90: d=10 of 20 → 0.5; 120: d=20 of 40 → 0.5 — exact tie in confidence.
  const a = matchPeaks([peak('far', 120), peak('near', 90)], prep);
  assertEqual(a[0].confidence, 0);
  assertEqual(a[1].bandId, 'A');
  assertClose(a[1].confidence, Math.exp(-0.5), 1e-15);
  assertEqual(a[0].alternatives[0].confidence, a[1].confidence, 'confidences really tie');

  const two = { bands: [{ id: 'A', label: 'A', center: 100, window: [80, 120] }, { id: 'B', label: 'B', center: 130, window: [90, 170] }], regions: [] };
  // 110: A d=10 of 20 → 0.5, B d=20 of 40 → 0.5 — the peak goes to the closer centre.
  const b = matchPeaks([peak('x', 110)], two);
  assertEqual(b[0].bandId, 'A');
  assertDeepEqual(b[0].alternatives.map(x => x.bandId), ['A', 'B']);
});

test('peaks in the sp³ C–H window are region-tagged, not band-labelled', () => {
  const a = matchPeaks([peak('ch', 2880)], p532);
  assertEqual(a[0].kind, 'region');
  assertEqual(a[0].bandId, null);
  assertEqual(a[0].label, 'sp³ C–H');
  assertEqual(a[0].regionId, 'CH-stretch');
  assertEqual(a[0].delta, null);
  assertDeepEqual(a[0].alternatives, []);
});

test('a band window beats the region tag when the band is free (785 nm widening)', () => {
  // At 785 nm the D+D′ window widens by 50·|ΔE| ≈ 37.6 cm⁻¹ and reaches 2867 cm⁻¹.
  assert(band(p785, 'DDp').window[0] < 2880, 'window reaches into the C–H region');
  const a = matchPeaks([peak('ch', 2880)], p785);
  assertEqual(a[0].kind, 'band');
  assertEqual(a[0].bandId, 'DDp');
  // …but once D+D′ is taken by a better peak, the leftover is region-tagged.
  const b = matchPeaks([peak('ch', 2880), peak('dd', 2936)], p785);
  assertEqual(b[1].bandId, 'DDp');
  assertEqual(b[0].kind, 'region');
  assert(b[0].alternatives.some(x => x.bandId === 'DDp'), 'D+D′ kept as alternative');
});

test('peaks outside every window are unassigned', () => {
  const a = matchPeaks([peak('u', 1800), { id: 'bad', x: NaN }], p532);
  assertEqual(a[0].kind, 'unassigned');
  assertEqual(a[0].label, 'unassigned');
  assertEqual(a[0].bandId, null);
  assertEqual(a[0].confidence, 0);
  assertEqual(a[0].delta, null);
  assertDeepEqual(a[0].alternatives, []);
  assertEqual(a[1].kind, 'unassigned');
  assertDeepEqual(matchPeaks([], p532), []);
});

test('dispersion-shifted windows: 2D at 785 nm matches near 2615', () => {
  const a = matchPeaks([peak('t', 2617)], p785);
  assertEqual(a[0].bandId, 'twoD');
  assertClose(a[0].delta, 2617 - band(p785, 'twoD').center, 1e-9);
  // The same position is outside the unshifted 532 nm window.
  assertEqual(matchPeaks([peak('t', 2617)], p532)[0].kind, 'unassigned');
});

test('matchPeaks is deterministic for a noisy synthetic peak list', async () => {
  const { rng, gauss } = await import('./harness.js');
  const r = rng(7);
  const centres = [1180, 1350, 1520, 1585, 1620, 2450, 2690, 2935, 3230];
  const peaks = centres.map((c, i) => peak('n' + i, c + 4 * gauss(r)));
  const a1 = matchPeaks(peaks, p532), a2 = matchPeaks(peaks, p532);
  assertDeepEqual(a1, a2);
  const ids = a1.filter(x => x.kind === 'band').map(x => x.bandId);
  assertEqual(new Set(ids).size, ids.length, 'no band used twice');
});
