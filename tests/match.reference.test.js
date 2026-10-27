// Private reference lists: validation, candidates for a peak, and the per-material
// summary. Every material and position here is made up.
import { test, assert, assertEqual, assertClose, assertDeepEqual, assertThrows, fixtureText } from './harness.js';
import { parseReferenceList, candidatesAt, materialSummary, safeUrl, REFERENCE_SCHEMA } from '../js/match/reference.js';

const LIST = {
  schema: REFERENCE_SCHEMA, id: 't', name: 'Test list', toleranceCm: 10,
  materials: [
    { name: 'Alpha', role: 'one', bands: [500, 600, 700], source: { url: 'https://example.org/alpha', text: 'Source' } },
    { name: 'Beta', role: 'two', bands: [505], source: { url: 'javascript:alert(1)' } },
    { name: 'Gamma', bands: [900, 950] },
  ],
};

test('reference list: a valid list is read; only web links survive as sources', () => {
  const L = parseReferenceList(JSON.stringify(LIST));
  assertEqual(L.name, 'Test list'); assertEqual(L.toleranceCm, 10); assertEqual(L.materials.length, 3);
  assertEqual(L.materials[0].source.url, 'https://example.org/alpha');
  assertEqual(L.materials[1].source, null, 'a javascript: link is dropped');
  assertEqual(L.materials[2].source, null);
  assertEqual(safeUrl('http://a.b/c'), 'http://a.b/c'); assertEqual(safeUrl('ftp://a'), null); assertEqual(safeUrl('https://a b'), null);
});

test('reference list: files that are not usable lists are refused with a reason', () => {
  assertThrows(() => parseReferenceList('{not json'), /not valid JSON/);
  assertThrows(() => parseReferenceList({ ...LIST, schema: 'other' }), /Not a reference list/);
  assertThrows(() => parseReferenceList({ ...LIST, toleranceCm: 0 }), /toleranceCm/);
  assertThrows(() => parseReferenceList({ ...LIST, toleranceCm: 500 }), /toleranceCm/);
  assertThrows(() => parseReferenceList({ ...LIST, materials: [] }), /no materials/);
  assertThrows(() => parseReferenceList({ ...LIST, materials: [{ name: 'x', bands: [] }] }), /at least one band/);
});

test('candidates: every listed band within the tolerance, nearest first, delta = peak − band', () => {
  const L = parseReferenceList(LIST);
  const c = candidatesAt(503, L);
  assertDeepEqual(c.map(q => q.material), ['Beta', 'Alpha']);
  assertClose(c[0].delta, -2, 1e-12); assertClose(c[1].delta, 3, 1e-12);
  assertEqual(candidatesAt(511, L).length, 1, '511: Alpha 500 is 11 away, Beta 505 is 6');
  assertEqual(candidatesAt(800, L).length, 0);
  L.toleranceCm = 1; assertEqual(candidatesAt(503, L).length, 0, 'tolerance applies');
});

test('material summary: most matched bands first, each band matched to its nearest peak', () => {
  const L = parseReferenceList(LIST);
  const s = materialSummary([498, 503, 606, 951, 2000], L);
  assertDeepEqual(s.map(m => m.name), ['Alpha', 'Beta', 'Gamma']);
  assertEqual(s[0].matched.length, 2); assertEqual(s[0].total, 3);
  assertEqual(s[0].matched[0].x, 498, '500 takes the nearer of 498 and 503');
  assertEqual(materialSummary([], L).length, 0);
});

test('the synthetic reference fixture is a valid list', async () => {
  const L = parseReferenceList(await fixtureText('reference_list.json'));
  assertEqual(L.materials.length, 3);
  assert(L.materials.every(m => m.name.startsWith('Synthetic')), 'made-up materials only');
});
