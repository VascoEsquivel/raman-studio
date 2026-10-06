// "Read your spectrum" with synthetic measurements. Band ids and step texts come
// from the atlas library; the intensities and widths are made up to sit clearly
// on one side of the atlas's own thresholds (2D FWHM < 30 cm⁻¹, I_2D/I_G ≥ 2,
// I(2D) vs I(D+D′)) — no other thresholds exist to test against.
import { test, assert, assertEqual, assertDeepEqual } from './harness.js';
import { prepareLibrary } from '../js/match/library.js';
import { matchPeaks } from '../js/match/matcher.js';
import { computeRatios } from '../js/analysis/ratios.js';
import { evaluateWorkflow } from '../js/analysis/workflow.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const p532 = prepareLibrary(lib, { laserNm: 532 });
const p785 = prepareLibrary(lib, { laserNm: 785 });
const labelOf = id => lib.bands.find(b => b.id === id).label;
const comp = (bandId, x0, w, h, significant = true) => ({
  bandId, label: labelOf(bandId), x0, w, h, g: 50, area: h * w * 1.3,
  se: { x0: 0.5, w: 1, h: 1, g: 2 }, significant, windowIndex: 0,
});
const peak = (id, x, y, fwhm) => ({ id, index: 0, x, y, prominence: y, fwhm, leftX: x - fwhm / 2, rightX: x + fwhm / 2, snr: 20 });
const statuses = r => r.steps.map(s => s.status);
const has = (step, re) => step.evidence.some(e => re.test(e));

const monolayerFit = [comp('G', 1585, 14, 100), comp('twoD', 2680, 26, 250), comp('D', 1350, 30, 0.5, false)];
const goFit = [
  comp('Dstar', 1180, 100, 20), comp('D', 1350, 120, 100), comp('Dpp', 1520, 120, 25), comp('G', 1590, 80, 90),
  comp('Dp', 1620, 40, 30), comp('twoD', 2690, 150, 10), comp('DDpp', 2450, 100, 5), comp('DDp', 2935, 140, 15),
  comp('twoDp', 3230, 100, 3),
];

test('steps carry the atlas html verbatim, 0-based index', () => {
  const r = evaluateWorkflow(p532, { components: monolayerFit, noiseSigma: 1 });
  assertEqual(r.steps.length, 8);
  r.steps.forEach((s, i) => {
    assertEqual(s.index, i);
    assertEqual(s.html, lib.workflow[i]);
    assert(Array.isArray(s.evidence), 'evidence array');
  });
});

test('monolayer-like fit → step 1 match, steps 2 and 3 no', () => {
  const r = evaluateWorkflow(p532, { components: monolayerFit, noiseSigma: 1 });
  assertEqual(r.steps[0].status, 'match', JSON.stringify(r.steps[0]));
  assertEqual(r.steps[1].status, 'no');
  assertEqual(r.steps[2].status, 'no');
  assert(has(r.steps[0], /2D FWHM 26\.0 cm⁻¹ < 30 cm⁻¹ \(fit\)/), JSON.stringify(r.steps[0].evidence));
  assert(has(r.steps[0], /I_2D\/I_G = 2\.50 \(height, fit\) ≥ 2/), JSON.stringify(r.steps[0].evidence));
  assert(has(r.steps[0], /^D absent \(fit component not significant\)/), JSON.stringify(r.steps[0].evidence));
  assertDeepEqual({ stepIndex: r.summary.stepIndex, status: r.summary.status }, { stepIndex: 0, status: 'match' });
  assertEqual(r.summary.text, 'Consistent with pristine single-layer graphene (atlas step 1).');
});

test('precomputed ratios are used as given', () => {
  const ratios = computeRatios(p532, { components: monolayerFit });
  const r = evaluateWorkflow(p532, { ratios, components: monolayerFit, noiseSigma: 1 });
  assertEqual(r.steps[0].status, 'match');
});

test('a significant component not above 3σ noise counts as absent', () => {
  const comps = [comp('G', 1585, 14, 100), comp('twoD', 2680, 26, 250), comp('D', 1350, 30, 2.5, true)];
  const r = evaluateWorkflow(p532, { components: comps, noiseSigma: 1 });
  assertEqual(r.steps[0].status, 'match');
  assert(has(r.steps[0], /D absent \(fitted height not above 3σ noise\)/), JSON.stringify(r.steps[0].evidence));
  const loud = evaluateWorkflow(p532, { components: comps, noiseSigma: 0.5 });
  assertEqual(loud.steps[0].status, 'no', 'D at 5σ is present, so not pristine');
});

test('atlas thresholds are strict where the atlas says so (< 30, ≥ 2)', () => {
  const at30 = evaluateWorkflow(p532, { components: [comp('G', 1585, 14, 100), comp('twoD', 2680, 30, 250), comp('D', 1350, 30, 0.5, false)] });
  assertEqual(at30.steps[0].status, 'no', 'FWHM exactly 30 is not < 30');
  const ratio2 = evaluateWorkflow(p532, { components: [comp('G', 1585, 14, 100), comp('twoD', 2680, 26, 200), comp('D', 1350, 30, 0.5, false)] });
  assertEqual(ratio2.steps[0].status, 'match', 'I_2D/I_G exactly 2 satisfies ≥ 2');
  // Sharp 2D, D absent, but a low ratio (the atlas: substrate doping lowers it) → partial, not no.
  const doped = evaluateWorkflow(p532, { components: [comp('G', 1585, 14, 100), comp('twoD', 2680, 27, 150), comp('D', 1350, 30, 0.5, false)] });
  assertEqual(doped.steps[0].status, 'partial');
  assertEqual(doped.summary.stepIndex, 0);
  assert(/^Partly consistent with pristine single-layer graphene \(atlas step 1\); not confirmed: I_2D\/I_G ≥ 2\.$/.test(doped.summary.text), doped.summary.text);
});

test('detection-only: absence needs the searched range', () => {
  const peaks = [peak('g', 1585, 100, 14), peak('t', 2680, 250, 26)];
  const assignments = matchPeaks(peaks, p532);
  // Without xRange the searched extent is the peaks' own span, which doesn't reach D.
  const unknown = evaluateWorkflow(p532, { peaks, assignments });
  assertEqual(unknown.steps[0].status, 'insufficient');
  assert(has(unknown.steps[0], /D: presence unknown/), JSON.stringify(unknown.steps[0].evidence));
  assertEqual(unknown.summary, null);
  const known = evaluateWorkflow(p532, { peaks, assignments, xRange: [1000, 3200] });
  assertEqual(known.steps[0].status, 'match', JSON.stringify(known.steps[0]));
  assert(has(known.steps[0], /D absent \(no detected peak in its window; Deconvolve to check for a hidden shoulder\)/), JSON.stringify(known.steps[0].evidence));
  assert(has(known.steps[0], /\(detected\)/), 'sources named');
});

test('bilayer-like fit → step 1 no, step 2 partial (component count is never confirmed)', () => {
  const r = evaluateWorkflow(p532, { components: [comp('G', 1582, 16, 100), comp('twoD', 2700, 52, 90), comp('D', 1350, 30, 0.5, false)], noiseSigma: 1 });
  assertEqual(r.steps[0].status, 'no');
  assertEqual(r.steps[1].status, 'partial', JSON.stringify(r.steps[1]));
  assertEqual(r.steps[2].status, 'no');
  assert(has(r.steps[1], /2D FWHM 52\.0 cm⁻¹ ≥ 30 cm⁻¹/), JSON.stringify(r.steps[1].evidence));
  assert(has(r.steps[1], /component count is not determined/), 'lineshape left to the user');
  assertEqual(r.summary.stepIndex, 1);
  assert(/few-layer AB-stacked graphene \(atlas step 2\); not confirmed: multi-component 2D/.test(r.summary.text), r.summary.text);
});

test('GO-like fit → step 3 match; computation steps report numbers', () => {
  const r = evaluateWorkflow(p532, { components: goFit, noiseSigma: 0.5 });
  assertDeepEqual(statuses(r), ['no', 'no', 'match', 'info', 'info', 'info', 'info', 'info']);
  const s3 = r.steps[2];
  assert(has(s3, /I\(2D\)\/I\(D\+D′\) = 0\.67 .*I\(D\+D′\) > I\(2D\) \(atlas ratio card 5\)/), JSON.stringify(s3.evidence));
  assert(has(s3, /I_D\/I_G = 1\.11 \(height, fit\) — the atlas gives no number for "strong D"/), JSON.stringify(s3.evidence));
  assert(has(s3, /no number for "broad"/), 'widths reported, not judged');
  assertEqual(r.summary.stepIndex, 2);
  assertEqual(r.summary.status, 'match');
  assertEqual(r.summary.text, 'Consistent with graphene oxide / highly disordered carbon (atlas step 3).');
  // Step 2 rejects GO through the atlas's order gauge, not an invented "little D" cutoff.
  assert(has(r.steps[1], /the atlas gives no number for "little".*disordered/), JSON.stringify(r.steps[1].evidence));
  // Step 4: 100 / 30 = 3.33 → nearest 3.5.
  assert(has(r.steps[3], /I_D\/I_D′ = 3\.33 \(height, fit\)/), JSON.stringify(r.steps[3].evidence));
  assert(has(r.steps[3], /Nearest atlas value 3\.5 → boundary \/ edge defects/), JSON.stringify(r.steps[3].evidence));
  // Step 5: ratio, G width and Lₐ (18.983 / 1.111 = 17.1 nm).
  assert(has(r.steps[4], /G FWHM 80\.0 cm⁻¹ \(fit\)/), JSON.stringify(r.steps[4].evidence));
  assert(has(r.steps[4], /Lₐ = 17\.1 nm from the height ratio/), JSON.stringify(r.steps[4].evidence));
  assert(has(r.steps[6], /ω\(G\) = 1590\.0 cm⁻¹/), JSON.stringify(r.steps[6].evidence));
  assert(has(r.steps[6], /ω\(2D′\) = 3230\.0 cm⁻¹/), JSON.stringify(r.steps[6].evidence));
  assert(has(r.steps[7], /No peak or fitted component in the sp³ C–H stretching region \(2850–2920 cm⁻¹\)/), JSON.stringify(r.steps[7].evidence));
  assert(has(r.steps[7], /G\* present at 2450\.0 cm⁻¹/), JSON.stringify(r.steps[7].evidence));
});

test('GO-like detected peaks → step 3 partial with the unresolved bands named', () => {
  const peaks = [peak('d', 1350, 100, 110), peak('g', 1592, 90, 70), peak('t', 2690, 10, 160), peak('c', 2935, 15, 150)];
  const r = evaluateWorkflow(p532, { peaks, xRange: [800, 3400] });
  assertEqual(r.steps[0].status, 'no');
  assertEqual(r.steps[1].status, 'no');
  assert(['match', 'partial'].includes(r.steps[2].status), r.steps[2].status);
  assertEqual(r.steps[2].status, 'partial');
  assertEqual(r.summary.stepIndex, 2);
  assert(/graphene oxide \/ highly disordered carbon \(atlas step 3\); not confirmed: D′ shoulder on G; D\* present; D″ present\./.test(r.summary.text), r.summary.text);
  assertEqual(r.steps[3].status, 'insufficient', 'I_D/I_D′ needs D′');
  assert(has(r.steps[3], /D′ not resolved — run Deconvolve/), JSON.stringify(r.steps[3].evidence));
  assertEqual(r.steps[4].status, 'info');
});

test('no data → every step insufficient, no summary', () => {
  const r = evaluateWorkflow(p532, {});
  assertDeepEqual(statuses(r), Array(8).fill('insufficient'));
  assertEqual(r.summary, null);
  for (const s of r.steps) assert(s.evidence.length > 0, `step ${s.index + 1} explains what is missing`);
  assertDeepEqual(statuses(evaluateWorkflow(p532)), Array(8).fill('insufficient'));
});

test('a peak in the sp³ C–H window is called out in step 8', () => {
  const peaks = [peak('g', 1585, 100, 14), peak('t', 2680, 250, 26), peak('ch', 2880, 20, 40)];
  const r = evaluateWorkflow(p532, { peaks, xRange: [1000, 3200] });
  assertEqual(r.steps[7].status, 'info');
  assert(has(r.steps[7], /^Peak at 2880\.0 cm⁻¹ lies in the sp³ C–H stretching region \(2850–2920 cm⁻¹\)$/), JSON.stringify(r.steps[7].evidence));
  // At 785 nm the widened D+D′ window claims it — step 8 says so and asks the user to decide.
  const r785 = evaluateWorkflow(p785, { peaks, xRange: [1000, 3200] });
  assert(has(r785.steps[7], /2880\.0 cm⁻¹ .*currently labelled D\+D′; decide: phonon combination or sp³ C–H stretching/), JSON.stringify(r785.steps[7].evidence));
  // Fitted components that drift into the window count too.
  const rc = evaluateWorkflow(p785, { components: [comp('DDp', 2890, 60, 12)] });
  assert(has(rc.steps[7], /Fitted D\+D′ component at 2890\.0 cm⁻¹ lies in the sp³ C–H/), JSON.stringify(rc.steps[7].evidence));
});

test('other libraries get their steps back as info with no evidence', () => {
  const other = {
    schema: 'raman-studio/band-library@1', id: 'synthetic-test', name: 'Synthetic test library',
    bands: [{ id: 'A', label: 'A', name: 'Band A', region: 'first', posText: '~500', posSort: 500,
      match: { range: [490, 510], center: 500, dispersion: { cmPerEV: 0 } } }],
    workflow: ['First synthetic step', 'Second synthetic step'],
  };
  const prep = prepareLibrary(other);
  const r = evaluateWorkflow(prep, { peaks: [peak('a', 500, 10, 8)], noiseSigma: 1 });
  assertEqual(r.steps.length, 2);
  for (const [i, s] of r.steps.entries()) {
    assertEqual(s.status, 'info');
    assertDeepEqual(s.evidence, []);
    assertEqual(s.html, other.workflow[i]);
  }
  assertEqual(r.summary, null);
});
