import { test, assert, assertEqual, assertClose, assertDeepEqual, fixtureText } from './harness.js';
import { parseDelimitedText } from '../js/io/parse-text.js';
import { detectColumns, tableToSpectra, CONFIDENT } from '../js/io/detect-columns.js';

const truth = JSON.parse(await fixtureText('io_truth.json'));
const N = truth.n;
async function load(name) {
  const t = parseDelimitedText(await fixtureText(name), { filename: name });
  return { t, m: detectColumns(t) };
}
const ascending = x => { for (let i = 1; i < x.length; i++) if (!(x[i] > x[i - 1])) return false; return true; };

test('two-column file: x = column 0, confident', async () => {
  const { t, m } = await load('spectrum_comma.csv');
  assertEqual(m.layout, 'columns'); assertEqual(m.x, 0); assertDeepEqual(m.ys, [1]);
  assert(m.confidence >= CONFIDENT, 'confident');
  const [sp] = tableToSpectra(t, m, { file: 'spectrum_comma.csv', format: 'csv' });
  assertEqual(sp.x.length, N);
  let best = 0; for (let i = 1; i < N; i++) if (sp.y[i] > sp.y[best]) best = i;
  assert(Math.abs(sp.x[best] - 1585) <= 4, 'tallest point near 1585');
});

test('an integer index column never wins over the Raman shift', async () => {
  const { m } = await load('index_first.csv');
  assertEqual(m.x, 1); assertDeepEqual(m.ys, [2]);
  assert(m.confidence >= CONFIDENT);
});

test('several intensity columns become several spectra', async () => {
  const { t, m } = await load('multi_column.csv');
  assertEqual(m.x, 0); assertDeepEqual(m.ys, [1, 2, 3]);
  const sps = tableToSpectra(t, m, { file: 'multi_column.csv', format: 'csv' });
  assertEqual(sps.length, 3);
  const [s, o] = truth.variants[1];
  assertClose(sps[1].y[200], s * truth.y[200] + o, 1e-3);
  assert(sps.every(sp => sp.yLabel && sp.yLabel !== ''), 'labels from headers');
});

test('descending x (WiRE) comes out ascending', async () => {
  const { t, m } = await load('wire_export.txt');
  const [sp] = tableToSpectra(t, m, { file: 'w.txt', format: 'txt' });
  assert(ascending(sp.x)); assertClose(sp.x[0], 100, 1e-9);
  assertClose(sp.y[0], truth.y[0], 1e-5);
});

test('transposed table (first row is x) is detected as rows', async () => {
  const { t, m } = await load('transposed_rows.csv');
  assertEqual(m.layout, 'rows');
  const sps = tableToSpectra(t, m, { file: 't.csv', format: 'csv' });
  assertEqual(sps.length, 3);
  assertEqual(sps[0].x.length, Math.ceil(N / truth.transposedStep));
  assert(ascending(sps[0].x));
});

test('long map export (X, Y, Wave, Intensity) gives one spectrum per map point', async () => {
  const { t, m } = await load('map_long.txt');
  assertEqual(m.layout, 'long');
  const sps = tableToSpectra(t, m, { file: 'map.txt', format: 'txt' });
  assertEqual(sps.length, 4);
  assertEqual(sps[0].x.length, Math.ceil(N / truth.mapStep));
  assert(sps.every(sp => ascending(sp.x)));
  const k = sps[3].x.length - 1;
  assertClose(sps[3].y[k], truth.mapScale[3] * truth.y[(sps[3].x.length - 1) * truth.mapStep], 1e-3);
});

test('two non-monotonic columns are not trusted: needs mapping', async () => {
  const { m } = await load('ambiguous.csv');
  assert(m.confidence < CONFIDENT, 'confidence ' + m.confidence);
  assert(Array.isArray(m.reasons) && m.reasons.length, 'reasons given');
});

test('empty table → zero confidence, no throw', () => {
  const m = detectColumns({ headers: [], columns: [], nRows: 0 });
  assertEqual(m.confidence, 0);
});
