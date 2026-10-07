import { test, assert, assertEqual, assertClose, fixtureText, fixtureBuffer } from './harness.js';
import { importFile, applyMapping, sniff, decodeText, SUPPORTED_EXTENSIONS } from '../js/io/import.js';

const truth = JSON.parse(await fixtureText('io_truth.json'));
const N = truth.n;
const fake = (name, buf) => ({ name, arrayBuffer: async () => buf });
const fromFixture = async (fixture, as = fixture) => fake(as, await fixtureBuffer(fixture));

test('every fixture imports through importFile with the right format', async () => {
  const cases = [
    ['spectrum_comma.csv', 'csv', 1], ['spectrum_semicolon_decimal_comma.csv', 'csv', 1], ['spectrum.tsv', 'tsv', 1],
    ['wire_export.txt', 'txt', 1], ['labspec_export.txt', 'txt', 1], ['whitespace_comments.txt', 'txt', 1],
    ['multi_column.csv', 'csv', 3], ['index_first.csv', 'csv', 1], ['transposed_rows.csv', 'csv', 3],
    ['map_long.txt', 'txt', 4], ['utf16le.txt', 'txt', 1], ['multi_sheet.xlsx', 'xlsx', 3], ['legacy.xls', 'xls', 1],
    ['spectrum_affn.jdx', 'jcamp', 1], ['spectrum_compressed.jdx', 'jcamp', 1], ['xy_points.dx', 'jcamp', 1],
    ['spectrum_even.spc', 'spc', 1], ['spectrum_float_xy.spc', 'spc', 1], ['multi_subfile.spc', 'spc', 2],
  ];
  for (const [f, format, count] of cases) {
    const r = await importFile(await fromFixture(f));
    assertEqual(r.format, format, f + ' format');
    assertEqual(r.spectra.length, count, f + ' spectra');
    assert(!r.needsMapping, f + ' confident');
  }
});

test('content wins over a misleading extension', async () => {
  assertEqual((await importFile(await fromFixture('spectrum_affn.jdx', 'mystery.txt'))).format, 'jcamp');
  assertEqual((await importFile(await fromFixture('spectrum_even.spc', 'data.bin'))).format, 'spc');
  assertEqual((await importFile(await fromFixture('multi_sheet.xlsx', 'export.dat'))).format, 'xlsx');
});

test('UTF-16 LE with BOM keeps non-ASCII headers', async () => {
  const r = await importFile(await fromFixture('utf16le.txt'));
  assertEqual(r.spectra[0].x.length, N);
  assert(r.table.headers.some(h => /Intensité/.test(h)), 'header decoded: ' + r.table.headers);
  assertClose(r.spectra[0].y[371], truth.y[371], 1e-4);
});

test('Windows-1252 text decodes instead of failing', () => {
  const bytes = new Uint8Array([0x78, 0x3B, 0x49, 0x6E, 0x74, 0x65, 0x6E, 0x73, 0x69, 0x74, 0xE9]);   // "x;Intensité" in cp1252
  assertEqual(decodeText(bytes), 'x;Intensité');
});

test('ambiguous file: needs mapping, table returned, applyMapping builds spectra', async () => {
  const r = await importFile(await fromFixture('ambiguous.csv'));
  assert(r.needsMapping); assertEqual(r.spectra.length, 0);
  assert(r.table && r.mapping, 'table and best-guess mapping returned');
  const sps = applyMapping(r.table, { x: 0, ys: [1], layout: 'columns' }, { file: 'ambiguous.csv', format: 'csv' });
  assertEqual(sps.length, 1);
  assertEqual(sps[0].x.length, 40);
});

test('empty and binary junk fail with clear messages', async () => {
  let msg = '';
  try { await importFile(fake('empty.csv', new ArrayBuffer(0))); } catch (e) { msg = e.message; }
  assert(/empty/i.test(msg), msg);
  msg = '';
  const junk = new Uint8Array(300).map((_, i) => (i * 37) % 7);
  try { await importFile(fake('photo.jpg', junk.buffer)); } catch (e) { msg = e.message; }
  assert(msg.length > 0, 'binary junk rejected');
});

test('sniff and extension list', () => {
  assert(SUPPORTED_EXTENSIONS.includes('.spc') && SUPPORTED_EXTENSIONS.includes('.xlsx'));
  assertEqual(sniff(new TextEncoder().encode('##TITLE=x'), '.txt'), 'jcamp');
  assertEqual(sniff(new TextEncoder().encode('1,2\n3,4'), '.csv'), 'text');
  assertEqual(sniff(new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0, 0]), '.csv'), 'xlsx');
});
