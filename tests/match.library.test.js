// Library loading, validation and laser preparation. Expected shifts are worked
// out from the atlas rates (D 50, 2D 100 cm⁻¹/eV) and E = 1239.841984 / nm, so a
// change to either the formula or the library data shows up here.
import { test, assert, assertEqual, assertClose, assertDeepEqual } from './harness.js';
import { photonEnergyEV, dispersionShift } from '../js/match/dispersion.js';
import { loadLibraries, validateLibrary, prepareLibrary } from '../js/match/library.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const clone = () => JSON.parse(JSON.stringify(lib));
const E = nm => 1239.841984 / nm;
const byId = (prep, id) => prep.bands.find(b => b.id === id);

test('photonEnergyEV and dispersionShift follow the contract formulas', () => {
  assertClose(photonEnergyEV(532), 2.330530045, 1e-8);
  assertClose(photonEnergyEV(1239.841984), 1, 1e-12);
  assert(Number.isNaN(photonEnergyEV(0)) && Number.isNaN(photonEnergyEV(-5)) && Number.isNaN(photonEnergyEV(null)), 'invalid → NaN');
  assertClose(dispersionShift(50, 633, 532), 50 * (E(633) - E(532)), 1e-12);
  assertClose(dispersionShift(100, 785, 532), -75.1113505, 1e-6);
  assertEqual(dispersionShift(null, 633, 532), 0, 'unknown rate never shifts');
  assertEqual(dispersionShift(50, null, 532), 0, 'unknown laser never shifts');
  assertClose(dispersionShift(50, 532, 532), 0, 1e-15);
});

test('the real graphene-go library validates cleanly', () => {
  const v = validateLibrary(lib);
  assertDeepEqual(v.errors, []);
  assertEqual(v.ok, true);
});

test('validateLibrary rejects malformed objects with path-specific errors', () => {
  const bad = (mutate, re, label) => {
    const o = clone();
    mutate(o);
    const v = validateLibrary(o);
    assertEqual(v.ok, false, label + ' ok');
    assert(v.errors.some(e => re.test(e)), `${label}: expected an error matching ${re}, got ${JSON.stringify(v.errors)}`);
  };
  assertEqual(validateLibrary(null).ok, false);
  assertEqual(validateLibrary([1, 2]).ok, false);
  assert(/object/.test(validateLibrary('x').errors[0]), 'non-object message');
  bad(o => { delete o.bands; }, /^bands: required non-empty array/, 'missing bands');
  bad(o => { o.bands = []; }, /^bands: required non-empty array/, 'empty bands');
  bad(o => { o.schema = 'something-else'; }, /^schema: expected "raman-studio\/band-library@1"/, 'schema');
  bad(o => { delete o.name; }, /^name: required/, 'name');
  bad(o => { o.id = 'Graphene GO'; }, /^id: .*a–z/, 'id pattern');
  bad(o => { o.bands[3].match.range = [1600, 1580]; }, /^bands\[3\] \(G\)\.match\.range: lo 1600 is greater than hi 1580/, 'lo > hi');
  bad(o => { o.bands[3].match.range = [1580]; }, /bands\[3\] \(G\)\.match\.range: expected \[lo, hi\]/, 'range shape');
  bad(o => { o.bands[1].match.center = 13500; o.bands[1].match.range = [13500, 13500]; }, /bands\[1\] \(D\)\.match\.center: 13500 cm⁻¹ is outside the plausible/, 'insane centre');
  bad(o => { o.bands[3].match.center = 1700; }, /bands\[3\] \(G\)\.match\.center: 1700 lies outside match\.range/, 'centre outside range');
  bad(o => { delete o.bands[0].match.dispersion; }, /bands\[0\] \(Dstar\)\.match\.dispersion: required/, 'dispersion');
  bad(o => { o.bands[0].match.dispersion.cmPerEV = 'fast'; }, /cmPerEV: must be a number or null/, 'cmPerEV type');
  bad(o => { o.bands[2].region = 'third'; }, /bands\[2\] \(Dpp\)\.region/, 'region enum');
  bad(o => { o.bands[4].refs.push('nobody99'); }, /bands\[4\] \(Dp\)\.refs: "nobody99" is not a key in references/, 'dangling ref');
  bad(o => { o.bands[5].id = 'D'; }, /duplicate band id "D"/, 'duplicate id');
  bad(o => { o.ratioMap[0].den = 'Gx'; }, /^ratioMap\[0\]\.den: "Gx" is not a band id/, 'ratioMap band');
  bad(o => { o.ratioMap[2].ratioIndex = 9; }, /^ratioMap\[2\]\.ratioIndex: 9 but there are only 5/, 'ratioMap index');
  bad(o => { o.ratioMap[1].classify.labels.pop(); }, /ratioMap\[1\]\.classify\.labels/, 'classify labels');
  bad(o => { o.regions[0].range = [2920, 2850]; }, /^regions\[0\]\.range: lo 2920/, 'region range');
  bad(o => { o.fitDefaults.fwhmMin = 400; }, /fwhmMin 400 is greater than fwhmMax 300/, 'fit bounds');
  bad(o => { o.matchDefaults.toleranceCm = -1; }, /matchDefaults\.toleranceCm/, 'tolerance');
});

test('prepareLibrary at the 532 nm reference: no shift, no widening', () => {
  const p = prepareLibrary(lib, { laserNm: 532 });
  assertEqual(p.library, lib);
  assertEqual(p.laserNm, 532);
  assertEqual(p.referenceNm, 532);
  assertClose(p.deltaEV, 0, 1e-15);
  assertEqual(p.toleranceCm, 25, 'default tolerance from matchDefaults');
  assertEqual(p.bands.length, 9);
  for (const b of p.bands) {
    assertClose(b.shift, 0, 1e-12, b.id + ' shift');
    assertEqual(b.widen, 0, b.id + ' widen');
    assertEqual(b.order, b.band.region, b.id + ' order');
    assertClose(b.window[0], b.band.match.range[0] - 25, 1e-9, b.id + ' window lo');
    assertClose(b.window[1], b.band.match.range[1] + 25, 1e-9, b.id + ' window hi');
    assertEqual(b.center, b.band.match.center, b.id + ' centre');
    assertEqual(b.fwhmSeed, b.band.fit.fwhmSeed, b.id + ' fwhmSeed');
  }
  assertDeepEqual(byId(p, 'D').window, [1325, 1375]);
  assertDeepEqual(byId(p, 'G').range, [1580, 1600]);
  assertEqual(byId(p, 'Dp').dispersion.widenWindow, true);
  assertEqual(byId(p, 'D').dispersion.cmPerEV, 50);
  assertEqual(p.regions.length, 1);
  assertDeepEqual(p.regions[0].range, [2850, 2920]);
  assertEqual(p.regions[0].label, 'sp³ C–H');
});

test('prepareLibrary shifts D and 2D for 633 and 785 nm', () => {
  const p633 = prepareLibrary(lib, { laserNm: 633 });
  const dE633 = E(633) - E(532);
  assertClose(p633.deltaEV, dE633, 1e-12);
  assertClose(byId(p633, 'D').center, 1350 + 50 * dE633, 1e-9);
  assertClose(byId(p633, 'D').center, 1331.4, 0.05, 'D at 633 ≈ 1331.4');
  assertClose(byId(p633, 'twoD').center, 2690 + 100 * dE633, 1e-9);
  assertClose(byId(p633, 'D').window[0], 1331.407 - 25, 0.01);

  const p785 = prepareLibrary(lib, { laserNm: 785 });
  assertClose(byId(p785, 'twoD').center, 2615, 0.5, '2D at 785 ≈ 2615');
  assertClose(byId(p785, 'twoD').shift, 100 * (E(785) - E(532)), 1e-9);
  assertClose(byId(p785, 'twoD').range[0], 2680 + byId(p785, 'twoD').shift, 1e-9);
  // Bands the atlas treats as non-dispersive must not move.
  for (const id of ['Dstar', 'Dpp', 'G']) {
    assertClose(byId(p785, id).shift, 0, 1e-12, id);
    assertClose(byId(p785, id).center, byId(p785, id).band.match.center, 1e-12, id);
  }
  // Blue-shifting laser moves D up.
  const p514 = prepareLibrary(lib, { laserNm: 514.5 });
  assert(byId(p514, 'D').center > 1350, 'D moves up at 514.5 nm');
});

test('unknown-dispersion bands get a widened (unshifted) window away from 532 nm', () => {
  for (const nm of [633, 785]) {
    const p = prepareLibrary(lib, { laserNm: nm });
    const widen = 50 * Math.abs(E(nm) - E(532));
    for (const id of ['Dp', 'DDpp', 'DDp', 'twoDp']) {
      const b = byId(p, id);
      assertClose(b.widen, widen, 1e-9, `${id} widen at ${nm}`);
      assertClose(b.shift, 0, 1e-12, `${id} not shifted`);
      assertClose(b.window[0], b.band.match.range[0] - 25 - widen, 1e-9, `${id} lo at ${nm}`);
      assertClose(b.window[1], b.band.match.range[1] + 25 + widen, 1e-9, `${id} hi at ${nm}`);
    }
    for (const id of ['D', 'G', 'twoD', 'Dstar', 'Dpp']) assertEqual(byId(p, id).widen, 0, `${id} not widened`);
  }
  assertClose(byId(prepareLibrary(lib, { laserNm: 633 }), 'Dp').widen, 18.5927, 1e-3);
  assertClose(byId(prepareLibrary(lib, { laserNm: 785 }), 'DDp').widen, 37.5557, 1e-3);
});

test('prepareLibrary options: tolerance override, default laser, invalid input', () => {
  const p = prepareLibrary(lib, { laserNm: 532, toleranceCm: 10 });
  assertEqual(p.toleranceCm, 10);
  assertDeepEqual(byId(p, 'D').window, [1340, 1360]);
  const q = prepareLibrary(lib);
  assertEqual(q.laserNm, 532, 'laser defaults to the reference excitation');
  assertClose(q.deltaEV, 0, 1e-15);
  let threw = false;
  try { prepareLibrary(lib, { laserNm: -3 }); } catch (e) { threw = /positive/.test(e.message); }
  assert(threw, 'negative laser rejected with a readable message');
  threw = false;
  try { prepareLibrary({ id: 'x' }); } catch (e) { threw = /bands/.test(e.message); }
  assert(threw, 'non-library rejected');
});

test('loadLibraries reads the real manifest with no errors', async () => {
  const { libraries, errors, defaultId } = await loadLibraries();
  assertDeepEqual(errors, []);
  assertEqual(libraries.length, 1);
  assertEqual(libraries[0].id, 'graphene-go');
  assertEqual(defaultId, 'graphene-go');
  assertEqual(libraries[0].bands.length, 9);
});

test('loadLibraries reports bad files in errors and never throws', async () => {
  // A stubbed fetch keeps the test offline and avoids 404 console noise.
  const good = clone();
  const dupe = clone();
  const broken = clone();
  broken.bands[3].match.range = [1600, 1580];
  const files = {
    'mock://libs/index.json': { libraries: [{ file: 'a.json' }, { file: 'missing.json' }, { file: 'broken.json' }, { file: 'notjson.json' }, { file: 'dupe.json', default: true }, {}] },
    'mock://libs/a.json': good,
    'mock://libs/broken.json': broken,
    'mock://libs/notjson.json': '{ nope',
    'mock://libs/dupe.json': dupe,
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const body = files[String(url)];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  try {
    const { libraries, errors, defaultId } = await loadLibraries('mock://libs/');
    assertEqual(libraries.length, 1);
    assertEqual(libraries[0].id, 'graphene-go');
    assertEqual(defaultId, 'graphene-go');
    assert(errors.some(e => /^missing\.json HTTP 404/.test(e)), 'missing file: ' + JSON.stringify(errors));
    assert(errors.some(e => /^broken\.json: bands\[3\] \(G\)\.match\.range: lo 1600/.test(e)), 'invalid file');
    assert(errors.some(e => /^notjson\.json is not valid JSON/.test(e)), 'bad JSON');
    assert(errors.some(e => /^dupe\.json: duplicate library id "graphene-go"/.test(e)), 'duplicate id');
    assert(errors.some(e => /libraries\[5\] has no file name/.test(e)), 'nameless entry');

    files['mock://libs/index.json'] = undefined;
    const none = await loadLibraries('mock://libs');
    assertEqual(none.libraries.length, 0);
    assert(/^index\.json HTTP 404/.test(none.errors[0]), 'missing manifest reported');

    globalThis.fetch = async () => { throw new TypeError('network down'); };
    const offline = await loadLibraries('mock://libs/');
    assert(/network down/.test(offline.errors[0]), 'network failure reported');
  } finally {
    globalThis.fetch = realFetch;
  }
});
