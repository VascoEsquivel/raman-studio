import { test, assert, assertEqual, assertClose, assertDeepEqual, fixtureText, fixtureBuffer } from './harness.js';
import { loadSheetJS, parseWorkbook, SHEETJS_URL } from '../js/io/parse-xlsx.js';

const truth = JSON.parse(await fixtureText('io_truth.json'));
const N = truth.n;
const XLSX = await loadSheetJS();

test('SheetJS is pinned to 0.20.3 and loads once', async () => {
  assert(SHEETJS_URL.includes('xlsx-0.20.3'));
  assertEqual(await loadSheetJS(), XLSX, 'cached module');
  assertEqual(XLSX.version, '0.20.3');
});

test('multi-sheet workbook: data sheets read, notes sheet ignored', async () => {
  const r = parseWorkbook(await fixtureBuffer('multi_sheet.xlsx'), XLSX, { filename: 'multi_sheet.xlsx' });
  assertEqual(r.format, 'xlsx');
  assertDeepEqual(r.sheets.map(s => s.name), ['Sheet1', 'Sheet2']);
  assertEqual(r.spectra.length, 3, 'Sheet1: 1 spectrum, Sheet2: 2');
  assert(!r.needsMapping, 'confident');
  const s1 = r.spectra.find(s => s.source.sheet === 'Sheet1');
  assertEqual(s1.x.length, N);
  assertClose(s1.y[371], truth.y[371], 1e-4);
  const b = r.spectra.filter(s => s.source.sheet === 'Sheet2')[1];
  const [sc, of] = truth.variants[2];
  assertClose(b.y[200], sc * truth.y[200] + of, 1e-3, 'decimal-comma text cells converted');
});

test('legacy .xls (BIFF8)', async () => {
  const r = parseWorkbook(await fixtureBuffer('legacy.xls'), XLSX, { filename: 'legacy.xls' });
  assertEqual(r.format, 'xls');
  assertEqual(r.spectra.length, 1);
  assertEqual(r.spectra[0].x.length, N);
  assertClose(r.spectra[0].y[0], truth.y[0], 1e-4);
});

test('a workbook with no numeric sheet fails clearly', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['just'], ['notes']]), 'Notes');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  let msg = '';
  try { parseWorkbook(buf, XLSX, { filename: 'notes.xlsx' }); } catch (e) { msg = e.message; }
  assert(/no sheet/i.test(msg), msg);
});
