// Guards the atlas-derived library against accidental edits. The full field-by-
// field comparison with the atlas source is tools/verify_atlas.py; these tests
// pin the facts the app depends on and the atlas corrections.
import { test, assert, assertEqual, assertDeepEqual } from './harness.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const manifest = await (await fetch(new URL('../data/libraries/index.json', import.meta.url))).json();
const band = id => lib.bands.find(b => b.id === id);

test('manifest lists the graphene-go library', () => {
  assert(Array.isArray(manifest.libraries), 'libraries array');
  assert(manifest.libraries.some(l => l.file === 'graphene-go.json'), 'graphene-go.json listed');
});

test('nine atlas bands in atlas order', () => {
  assertDeepEqual(lib.bands.map(b => b.id),
    ['Dstar', 'D', 'Dpp', 'G', 'Dp', 'twoD', 'DDpp', 'DDp', 'twoDp']);
  assertDeepEqual(lib.bands.map(b => b.label),
    ['D*', 'D', 'D″', 'G', 'D′', '2D', 'G*', 'D+D′', '2D′']);
});

test('G* sits at ~2450 cm⁻¹ (atlas correction kept)', () => {
  const g = band('DDpp');
  assertEqual(g.label, 'G*');
  assertEqual(g.posText, '~2450 cm⁻¹');
  assertEqual(g.posSort, 2450);
  assertDeepEqual(g.match.range, [2450, 2450]);
  assert(/2450/.test(g.correction), 'correction note retained');
});

test('2850–2920 cm⁻¹ is a non-lattice sp³ C–H region, not a band', () => {
  const r = lib.regions.find(x => x.id === 'CH-stretch');
  assertDeepEqual(r.range, [2850, 2920]);
  assertEqual(r.kind, 'non-lattice');
  assert(!lib.bands.some(b => b.match.center >= 2850 && b.match.center <= 2920), 'no band centred in the C–H window');
});

test('atlas positions and ranges are unrounded copies', () => {
  const expect = { Dstar: [1180, [1150, 1200]], D: [1350, [1350, 1350]], Dpp: [1520, [1500, 1550]],
    G: [1585, [1580, 1600]], Dp: [1620, [1620, 1620]], twoD: [2690, [2680, 2700]],
    DDpp: [2450, [2450, 2450]], DDp: [2935, [2930, 2950]], twoDp: [3230, [3220, 3245]] };
  for (const [id, [c, r]] of Object.entries(expect)) {
    assertEqual(band(id).posSort, c, id + ' posSort');
    assertEqual(band(id).match.center, c, id + ' match.center');
    assertDeepEqual(band(id).match.range, r, id + ' range');
  }
});

test('only D and 2D carry atlas-stated dispersion rates', () => {
  assertEqual(band('D').match.dispersion.cmPerEV, 50);
  assertEqual(band('twoD').match.dispersion.cmPerEV, 100);
  for (const id of ['Dp', 'DDpp', 'DDp', 'twoDp']) {
    assertEqual(band(id).match.dispersion.cmPerEV, null, id);
    assertEqual(band(id).match.dispersion.widenWindow, true, id);
  }
  for (const id of ['Dstar', 'Dpp', 'G']) assertEqual(band(id).match.dispersion.cmPerEV, 0, id);
});

test('every band reference resolves to a reference entry', () => {
  for (const b of lib.bands) for (const k of b.refs) assert(lib.references[k], `${b.id} → ${k}`);
  for (const r of lib.ratios) for (const k of r.refs) assert(lib.references[k], `ratio ${r.n} → ${k}`);
});

test('ratio cards, workflow and reference counts match the atlas', () => {
  assertEqual(lib.ratios.length, 5);
  assertEqual(lib.workflow.length, 8);
  assertEqual(Object.keys(lib.references).length, 13);
  assertEqual(lib.ratioMap.length, 5);
});

test('reference excitation is the assumed 532 nm', () => {
  assertEqual(lib.referenceExcitation.nm, 532);
  assertEqual(lib.referenceExcitation.status, 'assumed');
});
