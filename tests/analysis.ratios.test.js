// Ratio cards from mock fit components and mock detected peaks. All intensities
// are synthetic; band ids, card names and the Eckmann values come from the atlas
// library, and the Lₐ numbers are checked against the atlas formula by hand.
import { test, assert, assertEqual, assertClose, assertDeepEqual } from './harness.js';
import { prepareLibrary } from '../js/match/library.js';
import { matchPeaks } from '../js/match/matcher.js';
import { computeRatios } from '../js/analysis/ratios.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const p532 = prepareLibrary(lib, { laserNm: 532 });
const p633 = prepareLibrary(lib, { laserNm: 633 });
const labelOf = id => lib.bands.find(b => b.id === id).label;
const comp = (bandId, x0, w, h, area, significant = true) => ({
  bandId, label: labelOf(bandId), x0, w, h, g: 50, area,
  se: { x0: 0.5, w: 1, h: 1, g: 2 }, significant, windowIndex: 0,
});
const peak = (id, x, y, fwhm) => ({ id, index: 0, x, y, prominence: y, fwhm, leftX: x - fwhm / 2, rightX: x + fwhm / 2, snr: 20 });
const byIdx = (rs, i) => rs.find(r => r.ratioIndex === i);
// Cançado prefactor 560 / E_l⁴ worked out by hand: E(532) = 1239.841984/532 = 2.330530045 eV.
const K532 = 560 / Math.pow(1239.841984 / 532, 4);   // 18.98319 nm
const K633 = 560 / Math.pow(1239.841984 / 633, 4);   // 38.04850 nm

const fitSet = [
  comp('D', 1350, 110, 100, 6000), comp('G', 1586, 60, 80, 3000), comp('Dp', 1620, 30, 8, 300),
  comp('twoD', 2690, 70, 40, 4000), comp('DDp', 2935, 120, 20, 2500),
];

test('one RatioResult per ratioMap entry, names and titles verbatim from the atlas cards', () => {
  const rs = computeRatios(p532, { components: fitSet, laserNm: 532 });
  assertEqual(rs.length, lib.ratioMap.length);
  rs.forEach((r, i) => {
    const m = lib.ratioMap[i];
    assertEqual(r.ratioIndex, m.ratioIndex);
    assertEqual(r.name, lib.ratios[m.ratioIndex].n);
    assertEqual(r.title, lib.ratios[m.ratioIndex].t);
    assertEqual(r.num, m.num);
    assertEqual(r.den, m.den);
    assert(Array.isArray(r.missing), 'missing array');
  });
  assertEqual(rs[0].name, 'I_D / I_G');
  assertEqual(rs[1].title, 'Defect TYPE');
});

test('fit components: height and area ratios with extras', () => {
  const rs = computeRatios(p532, { components: fitSet, laserNm: 532 });
  const dg = byIdx(rs, 0);
  assertDeepEqual(dg.height, { value: 1.25, source: 'fit', numValue: 100, denValue: 80, se: null });
  assertDeepEqual(dg.area, { value: 2, numValue: 6000, denValue: 3000, se: null });
  assertEqual(dg.extras.gWidth, 60);
  assertEqual(dg.extras.gWidthSource, 'fit');
  assertDeepEqual(dg.missing, []);
  const ddp = byIdx(rs, 1);
  assertClose(ddp.height.value, 12.5, 1e-12);
  assertClose(ddp.area.value, 20, 1e-12);
  const tg = byIdx(rs, 2);
  assertClose(tg.height.value, 0.5, 1e-12);
  assertEqual(tg.extras.twoDWidth, 70);
  assertEqual(tg.extras.twoDWidthSource, 'fit');
  const apg = byIdx(rs, 3);
  assertEqual(apg.height, null, 'A_D′/A_G is area-only');
  assertClose(apg.area.value, 0.1, 1e-12);
  assertDeepEqual(apg.missing, [], 'no height complaint for an area-only card');
  const tdd = byIdx(rs, 4);
  assertClose(tdd.height.value, 2, 1e-12);
  assertClose(tdd.area.value, 1.6, 1e-12);
});

test('Cançado crystallite size Lₐ = (560/E_l⁴)·(I_D/I_G)⁻¹ checked by hand', () => {
  assertClose(K532, 18.98319, 1e-4, 'hand value of 560/E_l⁴ at 532 nm');
  const rs = computeRatios(p532, { components: fitSet, laserNm: 532 });
  const cs = byIdx(rs, 0).extras.crystalliteSize;
  assertEqual(cs.length, 2);
  assertEqual(cs[0].basis, 'height');
  assertClose(cs[0].valueNm, 15.18655, 1e-4, '18.98319 / 1.25');
  assertClose(cs[0].El, 2.330530045, 1e-8);
  assertEqual(cs[1].basis, 'area');
  assertClose(cs[1].valueNm, 9.491595, 1e-5, '18.98319 / 2');
  // Same ratios at 633 nm: smaller E_l ⇒ larger prefactor.
  const r633 = byIdx(computeRatios(p633, { components: fitSet, laserNm: 633 }), 0).extras.crystalliteSize;
  assertClose(r633[0].valueNm, K633 / 1.25, 1e-9);
  assertClose(r633[0].valueNm, 30.4388, 1e-3);
  // laserNm falls back to the prepared laser.
  const fb = byIdx(computeRatios(p633, { components: fitSet }), 0).extras.crystalliteSize;
  assertClose(fb[0].valueNm, K633 / 1.25, 1e-9);
});

test('I_D/I_D′ is classified to the nearest atlas reference value', () => {
  const cls = h => byIdx(computeRatios(p532, { components: [comp('D', 1350, 100, 100, 1), comp('Dp', 1620, 30, h, 1)] }), 1).classify;
  assertDeepEqual(cls(8), { nearest: 13, label: 'sp³ defects', value: 12.5 });
  const v = cls(15);                                   // 6.67
  assertEqual(v.nearest, 7);
  assertEqual(v.label, 'vacancy-type defects');
  assertEqual(cls(25).nearest, 3.5);                   // 4.0
  assertEqual(cls(25).label, 'boundary / edge defects');
  assertEqual(cls(100 / 10.5).nearest, 13, '10.5 is nearer 13 than 7');
  assertEqual(cls(1000).nearest, 3.5, '0.1 → 3.5');
});

test('detected peaks only: heights from peak.y, no areas, D′ missing', () => {
  const peaks = [peak('a', 1352, 50, 90), peak('b', 1590, 40, 55), peak('c', 2690, 10, 120)];
  const assignments = matchPeaks(peaks, p532);
  for (const rs of [computeRatios(p532, { assignments, peaks, laserNm: 532 }), computeRatios(p532, { peaks, laserNm: 532 })]) {
    const dg = byIdx(rs, 0);
    assertDeepEqual(dg.height, { value: 1.25, source: 'detected', numValue: 50, denValue: 40, se: null });
    assertEqual(dg.area, null);
    assert(dg.missing.includes('Areas need a fit — run Deconvolve'), JSON.stringify(dg.missing));
    assertEqual(dg.extras.crystalliteSize.length, 1, 'height basis only');
    assertClose(dg.extras.crystalliteSize[0].valueNm, K532 / 1.25, 1e-9);
    assertEqual(dg.extras.gWidth, 55);
    assertEqual(dg.extras.gWidthSource, 'detected');
    const ddp = byIdx(rs, 1);
    assertEqual(ddp.height, null);
    assertEqual(ddp.classify, null);
    assert(ddp.missing.includes('D′ not resolved — run Deconvolve'), JSON.stringify(ddp.missing));
    assert(!ddp.missing.some(m => /^D not/.test(m)), 'D itself is not blamed');
    const tg = byIdx(rs, 2);
    assertClose(tg.height.value, 0.25, 1e-12);
    assertEqual(tg.extras.twoDWidth, 120);
    const apg = byIdx(rs, 3);
    assertDeepEqual(apg.missing, ['Areas need a fit — run Deconvolve']);
    const tdd = byIdx(rs, 4);
    assertEqual(tdd.height, null);
    assert(tdd.missing.includes('D+D′ not resolved — run Deconvolve'), JSON.stringify(tdd.missing));
  }
});

test('significant fit wins over detection; insignificant components are not used', () => {
  const peaks = [peak('a', 1352, 50, 90), peak('b', 1590, 40, 55)];
  const both = byIdx(computeRatios(p532, { peaks, components: fitSet }), 0);
  assertEqual(both.height.source, 'fit');
  assertClose(both.height.value, 1.25, 1e-12);

  // Fit run, D′ came out insignificant and was not detected either.
  const comps = [comp('D', 1350, 110, 100, 6000), comp('G', 1586, 60, 80, 3000), comp('Dp', 1620, 30, 0.4, 10, false)];
  const rs = computeRatios(p532, { components: comps });
  const ddp = byIdx(rs, 1);
  assertEqual(ddp.height, null);
  assertEqual(ddp.area, null);
  assert(ddp.missing.includes('D′ fit component not significant'), JSON.stringify(ddp.missing));
  const apg = byIdx(rs, 3);
  assert(apg.missing.includes('D′ fit component not significant'), JSON.stringify(apg.missing));
  // Fit run but 2D was outside the fitted range.
  assert(byIdx(rs, 2).missing.includes('2D not in the fitted range'), JSON.stringify(byIdx(rs, 2).missing));
});

test('a ratio never mixes fitted and detected heights', () => {
  // G's fit is insignificant, so heights fall back to detection for both bands.
  const peaks = [peak('a', 1352, 50, 90), peak('b', 1590, 40, 55)];
  const comps = [comp('D', 1350, 110, 100, 6000), comp('G', 1586, 60, 80, 3000, false)];
  const dg = byIdx(computeRatios(p532, { peaks, components: comps }), 0);
  assertDeepEqual(dg.height, { value: 1.25, source: 'detected', numValue: 50, denValue: 40, se: null });
  assertEqual(dg.area, null);
  assert(dg.missing.includes('G fit component not significant'), JSON.stringify(dg.missing));
  assertEqual(dg.extras.gWidthSource, 'detected', 'G width from detection since its fit is not significant');
});

test('missing laser and empty inputs are reported, not thrown', () => {
  const noLaser = { ...p532, laserNm: null };
  const dg = byIdx(computeRatios(noLaser, { components: fitSet }), 0);
  assertEqual(dg.extras.crystalliteSize, undefined);
  assert(dg.missing.includes('Lₐ needs the laser wavelength'), JSON.stringify(dg.missing));

  const empty = computeRatios(p532, {});
  assertEqual(empty.length, 5);
  for (const r of empty) {
    assertEqual(r.height, null);
    assertEqual(r.area, null);
    assert(r.missing.length > 0, 'explains why');
  }
  assert(byIdx(empty, 0).missing.includes('G FWHM not available'), JSON.stringify(byIdx(empty, 0).missing));
  assertDeepEqual(computeRatios({ library: { id: 'x', bands: [] }, bands: [] }, {}), []);
  assertDeepEqual(computeRatios(null, {}), []);
});
