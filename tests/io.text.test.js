import { test, assert, assertEqual, assertClose, assertThrows, fixtureText } from './harness.js';
import { parseDelimitedText } from '../js/io/parse-text.js';

const truth = JSON.parse(await fixtureText('io_truth.json'));
const N = truth.n;

async function table(name) { return parseDelimitedText(await fixtureText(name), { filename: name }); }

test('comma CSV with header: delimiter, decimal, size and values', async () => {
  const t = await table('spectrum_comma.csv');
  assertEqual(t.meta.decimal, '.');
  assert(t.meta.delimiter === ',' || /comma/i.test(t.meta.delimiter), 'comma delimiter: ' + t.meta.delimiter);
  assertEqual(t.nRows, N);
  assertEqual(t.columns.length, 2);
  assertEqual(t.headers[0], 'Raman Shift (cm-1)');
  assertClose(t.columns[0][0], 100, 1e-9);
  assertClose(t.columns[1][100], truth.y[100], 1e-4);
});

test('semicolon CSV with decimal commas', async () => {
  const t = await table('spectrum_semicolon_decimal_comma.csv');
  assertEqual(t.meta.decimal, ',');
  assert(t.meta.delimiter === ';' || /semi/i.test(t.meta.delimiter), 'semicolon delimiter');
  assertEqual(t.nRows, N);
  assertClose(t.columns[0][N - 1], 3400, 1e-9);
  assertClose(t.columns[1][371], truth.y[371], 1e-4);
});

test('TSV', async () => {
  const t = await table('spectrum.tsv');
  assertEqual(t.nRows, N);
  assertClose(t.columns[1][N - 1], truth.y[N - 1], 1e-4);
});

test('Renishaw WiRE export: doubled-tab header, descending x, CRLF', async () => {
  const t = await table('wire_export.txt');
  assertEqual(t.nRows, N);
  assertEqual(t.columns.length, 2);
  assertClose(t.columns[0][0], 3400, 1e-9);
  assertClose(t.columns[0][N - 1], 100, 1e-9);
});

test('Horiba LabSpec export: header block, laser line in meta', async () => {
  const t = await table('labspec_export.txt');
  assertEqual(t.nRows, N);
  assertClose(t.meta.laserNm, 532.17, 1e-9);
  assert(t.meta.header && Object.keys(t.meta.header).length >= 5, 'header key/values parsed');
});

test('whitespace delimited, comments (one inside the data), scientific notation', async () => {
  const t = await table('whitespace_comments.txt');
  assertEqual(t.nRows, N);
  assertClose(t.columns[1][N - 1], truth.y[N - 1], 1e-3);
});

test('multi-column and transposed tables keep every column', async () => {
  assertEqual((await table('multi_column.csv')).columns.length, 4);
  const tr = await table('transposed_rows.csv');
  assertEqual(tr.nRows, 4);
  assertEqual(tr.columns.length, Math.ceil(N / truth.transposedStep));
});

test('empty and non-numeric input fail with a clear message', () => {
  assertThrows(() => parseDelimitedText('', { filename: 'x.csv' }), /empty/i);
  assertThrows(() => parseDelimitedText('   \n\n  ', { filename: 'x.csv' }), /empty/i);
  assertThrows(() => parseDelimitedText('hello world\nno numbers here\njust text\n', { filename: 'x.txt' }));
});
