// CSV builders: RFC 4180 quoting, number formatting, unicode labels and the
// fixed column orders other tools (spreadsheets, scripts) rely on.
import { test, assert, assertEqual, assertDeepEqual, assertThrows } from './harness.js';
import { toCSV, peakTableCSV, fitParamsCSV, spectrumCSV, formatNumber, PEAK_TABLE_COLUMNS } from '../js/export/csv.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();
const band = id => lib.bands.find(b => b.id === id);

/** Minimal RFC 4180 reader, used to prove the output round-trips. */
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 2; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

test('plain fields, CRLF record ends including the last record', () => {
  const s = toCSV(['a', 'b'], [[1, 2], [3, 4]]);
  assertEqual(s, 'a,b\r\n1,2\r\n3,4\r\n');
  assert(!/[^\r]\n/.test(s), 'no bare LF');
});

test('quotes fields with comma, quote, CR or LF and doubles inner quotes', () => {
  const s = toCSV(['name', 'note'], [
    ['a,b', 'say "hi"'],
    ['line1\nline2', 'cr\rhere'],
    ['crlf\r\nx', 'plain'],
  ]);
  const lines = s.split('\r\n');
  assertEqual(lines[1], '"a,b","say ""hi"""');
  assert(s.includes('"line1\nline2"'), 'LF field quoted');
  assert(s.includes('"cr\rhere"'), 'CR field quoted');
  assertDeepEqual(parseCSV(s), [
    ['name', 'note'], ['a,b', 'say "hi"'], ['line1\nline2', 'cr\rhere'], ['crlf\r\nx', 'plain'],
  ]);
});

test('header cells are quoted by the same rules', () => {
  assertEqual(toCSV(['x, cm⁻¹', 'y'], []), '"x, cm⁻¹",y\r\n');
});

test('null, undefined, NaN and Infinity become empty cells', () => {
  assertEqual(toCSV(['a', 'b', 'c', 'd', 'e'], [[null, undefined, NaN, Infinity, -Infinity]]), 'a,b,c,d,e\r\n,,,,\r\n');
});

test('numbers: integers verbatim, otherwise 6 significant digits with a dot', () => {
  assertEqual(formatNumber(1585), '1585');
  assertEqual(formatNumber(-3), '-3');
  assertEqual(formatNumber(-0), '0');
  assertEqual(formatNumber(1234.56789), '1234.57');
  assertEqual(formatNumber(0.1 + 0.2), '0.3');
  assertEqual(formatNumber(2.5), '2.5');
  assertEqual(formatNumber(0.000123456789), '0.000123457');
  assertEqual(formatNumber(123456.789), '123457');
  assertEqual(formatNumber(1 / 3), '0.333333');
  assert(!formatNumber(1234.5).includes(','), 'never a decimal comma');
  assertEqual(toCSV(null, [[1.23456789, 42, true, false]]), '1.23457,42,true,false\r\n');
});

test('object rows are read in header order; no header line when headers are null', () => {
  assertEqual(toCSV(['b', 'a'], [{ a: 1, b: 2 }]), 'b,a\r\n2,1\r\n');
  assertEqual(toCSV(null, [[1, 'x']]), '1,x\r\n');
  assertEqual(toCSV([], []), '');
});

test('fields with leading or trailing blanks are quoted so readers keep them', () => {
  assertEqual(toCSV(null, [[' a', 'b ', 'c']]), '" a","b ",c\r\n');
});

test('unicode band labels from the library survive unchanged', () => {
  const labels = ['Dp', 'twoDp', 'Dpp', 'DDp'].map(id => band(id).label);
  assertDeepEqual(labels, ['D′', '2D′', 'D″', 'D+D′']);
  const s = toCSV(['label'], labels.map(l => [l]));
  assertEqual(s, 'label\r\nD′\r\n2D′\r\nD″\r\nD+D′\r\n');
  assertDeepEqual(parseCSV(s).slice(1).map(r => r[0]), labels);
});

test('peakTableCSV: column order and values', () => {
  const D = band('D'), Dp = band('Dp');
  const s = peakTableCSV([
    { label: D.label, kind: 'band', tier: 1, x: 1351.234567, height: 812.5, fwhm: 101.25, prominence: 640,
      area: null, confidence: 0.98765, delta: 1.234567, bandId: D.id, bandName: D.name },
    { label: Dp.label, kind: 'band', tier: 2, x0: 1619.5, h: 210, w: 40.123456, prominence: NaN,
      area: 12345.678, confidence: 0.5, delta: -0.5, band_id: Dp.id, band_name: Dp.name },
    { label: 'unassigned', kind: 'unassigned', tier: 1, x: 1450, height: 50, fwhm: 12, prominence: 30,
      confidence: 0, delta: null, bandId: null, bandName: null },
  ]);
  const rows = parseCSV(s);
  assertDeepEqual(rows[0], ['label', 'kind', 'tier', 'position_cm-1', 'height', 'fwhm_cm-1', 'prominence',
    'area', 'match_score', 'delta_cm-1', 'band_id', 'band_name']);
  assertDeepEqual(rows[0], [...PEAK_TABLE_COLUMNS]);
  assertDeepEqual(rows[1], ['D', 'band', '1', '1351.23', '812.5', '101.25', '640', '', '0.98765', '1.23457', 'D', D.name]);
  assertDeepEqual(rows[2], ['D′', 'band', '2', '1619.5', '210', '40.1235', '', '12345.7', '0.5', '-0.5', 'Dp', Dp.name]);
  assertDeepEqual(rows[3], ['unassigned', 'unassigned', '1', '1450', '50', '12', '30', '', '0', '', '', '']);
  assertEqual(rows.length, 4);
});

test('fitParamsCSV: columns, ± se, type, area % per window, window range', () => {
  const comps = [
    { bandId: 'D', label: 'D', x0: 1350.123456, w: 100, h: 1000, g: 50, area: 130761.2,
      se: { x0: 0.5, w: 1.25, h: 10, g: 2 }, significant: true, windowIndex: 0 },
    { bandId: 'G', label: 'G', x0: 1585, w: 70, h: 900, g: 100, area: undefined,
      se: { x0: null, w: null, h: null, g: null }, significant: true, windowIndex: 0 },
    { bandId: 'twoDp', label: '2D′', x0: 3230, w: 108, h: 5, g: 0, area: 848.23,
      se: { x0: 3, w: 9, h: 4, g: 1 }, significant: false, windowIndex: 1 },
  ];
  const windows = [{ lo: 1000, hi: 1800 }, { lo: 2300, hi: 3400 }];
  const rows = parseCSV(fitParamsCSV(comps, windows));
  assertDeepEqual(rows[0], ['label', 'band_id', 'centre_cm-1', 'centre_se', 'fwhm_cm-1', 'fwhm_se', 'height',
    'height_se', 'gaussian_pct', 'type', 'area', 'area_pct', 'significant', 'window']);
  const gArea = 900 * 70 * Math.sqrt(Math.PI / (4 * Math.LN2));   // all-Gaussian WiRE area
  const tot = 130761.2 + gArea;
  assertDeepEqual(rows[1], ['D', 'D', '1350.12', '0.5', '100', '1.25', '1000', '10', '50', 'Mixed',
    '130761', formatNumber(100 * 130761.2 / tot), 'true', '1000-1800']);
  assertDeepEqual(rows[2], ['G', 'G', '1585', '', '70', '', '900', '', '100', 'Gaussian',
    formatNumber(gArea), formatNumber(100 * gArea / tot), 'true', '1000-1800']);
  assertDeepEqual(rows[3], ['2D′', 'twoDp', '3230', '3', '108', '9', '5', '4', '0', 'Lorentzian',
    '848.23', '100', 'false', '2300-3400']);
});

test('fitParamsCSV: missing windows fall back to the window index', () => {
  const rows = parseCSV(fitParamsCSV([{ bandId: 'G', label: 'G', x0: 1585, w: 70, h: 1, g: 50, area: 1, se: null, significant: true, windowIndex: 0 }]));
  assertEqual(rows[1][13], '0');
  assertEqual(rows[1][3], '', 'no se');
});

test('spectrumCSV: x, raw, baseline, corrected, final, despiked in that order', () => {
  const x = Float64Array.from([100, 101.5, 103]);
  const processed = {
    x, raw: Float64Array.from([10, 20.123456789, 30]),
    baseline: Float64Array.from([1, 2, 3]),
    corrected: Float64Array.from([9, 18.123456789, 27]),
    y: Float64Array.from([0.333333333, 0.67, 1]),
    despiked: Float64Array.from([10, 20.123456789, 30]),
  };
  assertEqual(spectrumCSV(processed),
    'x,raw,baseline,corrected,final,despiked\r\n100,10,1,9,0.333333,10\r\n101.5,20.1235,2,18.1235,0.67,20.1235\r\n103,30,3,27,1,30\r\n');
});

test('spectrumCSV: baseline column kept but empty when no baseline was used', () => {
  const processed = { x: [1, 2], raw: [5, 6], baseline: null, corrected: [5, 6], y: [NaN, 1] };
  assertEqual(spectrumCSV(processed), 'x,raw,baseline,corrected,final,despiked\r\n1,5,,5,,\r\n2,6,,6,1,\r\n');
});

test('spectrumCSV: refuses input without x', () => {
  assertThrows(() => spectrumCSV(null), /no x/);
  assertThrows(() => spectrumCSV({}), /no x/);
});
