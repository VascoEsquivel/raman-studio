// find-peaks.js must reproduce scipy.signal.find_peaks number for number. The
// reference outputs come from real SciPy (tools/make_scipy_vectors.py); the
// remaining tests pin argument handling and documented edge semantics.
import { test, assert, assertEqual, assertDeepEqual, assertThrows, fixtureText, rng, gauss } from './harness.js';
import {
  findPeaks, localMaxima1d, selectByPeakDistance, peakProminences, peakWidths,
} from '../js/detect/find-peaks.js';

const vectors = JSON.parse(await fixtureText('find_peaks_vectors.json'));
const INDEX_KEYS = new Set(['left_bases', 'right_bases', 'left_edges', 'right_edges', 'plateau_sizes']);
const REL_TOL = 1e-9;

/** Same values: integers exactly, reals within 1e-9 relative (exact at 0). */
function assertSameProperty(actual, expected, key, where) {
  assertEqual(actual.length, expected.length, `${where} ${key} length`);
  for (let i = 0; i < expected.length; i++) {
    const a = actual[i], e = expected[i];
    if (INDEX_KEYS.has(key)) {
      assertEqual(a, e, `${where} ${key}[${i}]`);
    } else if (!(Math.abs(a - e) <= REL_TOL * Math.abs(e))) {
      throw new Error(`${where} ${key}[${i}]: expected ${e}, got ${a}`);
    }
  }
}

/** SciPy keyword names → the port's option names. */
function toOpts(params) {
  const o = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'rel_height') o.relHeight = v;
    else if (k === 'plateau_size') o.plateauSize = v;
    else o[k] = v;
  }
  return o;
}

test('fixture: ≥ 25 SciPy 1.18.1 cases', () => {
  assertEqual(vectors.scipy, '1.18.1', 'generated with the SciPy version the port follows');
  assert(vectors.cases.length >= 25, `only ${vectors.cases.length} cases`);
  const fns = new Set(vectors.cases.map(c => c.fn));
  for (const fn of ['find_peaks', 'peak_prominences', 'peak_widths']) assert(fns.has(fn), fn + ' covered');
});

for (const c of vectors.cases) {
  test(`scipy ${c.fn}: ${c.name}`, () => {
    if (c.fn === 'find_peaks') {
      const res = findPeaks(c.x, toOpts(c.params));
      assertDeepEqual(res.peaks, c.peaks, 'peaks');
      assertDeepEqual(Object.keys(res.properties), Object.keys(c.properties), 'property keys (SciPy order)');
      for (const key of Object.keys(c.properties)) {
        assertSameProperty(res.properties[key], c.properties[key], key, 'properties');
      }
    } else if (c.fn === 'peak_prominences') {
      const res = peakProminences(c.x, c.params.peaks, c.params.wlen);
      for (const key of Object.keys(c.result)) assertSameProperty(res[key], c.result[key], key, 'result');
    } else if (c.fn === 'peak_widths') {
      const p = c.params;
      const res = peakWidths(c.x, p.peaks, p.rel_height, p.prominence_data || null, p.wlen);
      for (const key of Object.keys(c.result)) assertSameProperty(res[key], c.result[key], key, 'result');
    } else {
      throw new Error('unknown fixture fn ' + c.fn);
    }
  });
}

test('localMaxima1d: plateau midpoint rounds down; edge plateaus are not maxima', () => {
  const r = localMaxima1d([0, 2, 2, 0, 3, 3, 3, 3, 1, 4, 0, 5, 5]);
  assertDeepEqual(r.peaks, [1, 5, 9]);
  assertDeepEqual(r.left_edges, [1, 4, 9]);
  assertDeepEqual(r.right_edges, [2, 7, 9]);
  // A plateau that ends in a rise is a shoulder, not a maximum.
  assertDeepEqual(localMaxima1d([0, 1, 1, 2, 0]).peaks, [3]);
});

test('selectByPeakDistance: higher peaks win; equal heights keep the right-most (stable order)', () => {
  assertDeepEqual(selectByPeakDistance([2, 4, 9], [1, 3, 2], 3), [false, true, true]);
  assertDeepEqual(selectByPeakDistance([2, 4, 9], [1, 3, 2], 5), [false, true, true]);
  // 5.01 is rounded up to 6 samples, so the peak 5 samples away goes too.
  assertDeepEqual(selectByPeakDistance([2, 4, 9], [1, 3, 2], 5.01), [false, true, false]);
  assertDeepEqual(selectByPeakDistance([1, 3], [7, 7], 3), [false, true]);
});

test('findPeaks: real-valued properties are Float64Array, indices plain arrays', () => {
  const r = rng(3);
  const x = Array.from({ length: 200 }, () => gauss(r));
  const res = findPeaks(x, { height: [null, null], threshold: [null, null], prominence: [null, null],
    width: [null, null], plateauSize: [null, null] });
  assert(Array.isArray(res.peaks), 'peaks array');
  for (const k of ['peak_heights', 'left_thresholds', 'right_thresholds', 'prominences', 'widths',
    'width_heights', 'left_ips', 'right_ips']) {
    assert(res.properties[k] instanceof Float64Array, k + ' Float64Array');
    assertEqual(res.properties[k].length, res.peaks.length, k + ' length');
  }
  for (const k of INDEX_KEYS) assert(Array.isArray(res.properties[k]), k + ' array');
  assertDeepEqual(findPeaks(new Float64Array(x)).peaks, findPeaks(x).peaks, 'typed array = plain array');
});

test('findPeaks: unrequested properties are absent and input is not modified', () => {
  const x = [0, 1, 0, 3, 0, 2, 0];
  const copy = x.slice();
  const res = findPeaks(x, { distance: 3 });
  assertDeepEqual(res.peaks, [3]);
  assertDeepEqual(Object.keys(res.properties), []);
  assertDeepEqual(x, copy);
});

test('findPeaks: per-sample borders (Float64Array) are reduced to the peaks', () => {
  const x = [0, 5, 0, 5, 0, 5, 0];
  const lo = new Float64Array([0, 6, 0, 4, 0, 4, 0]);
  assertDeepEqual(findPeaks(x, { height: lo }).peaks, [3, 5]);
  assertDeepEqual(findPeaks(x, { height: [lo, new Float64Array(7).fill(4.5)] }).peaks, []);
  assertThrows(() => findPeaks(x, { height: [new Float64Array(3), null] }), /lower interval border must match x/);
  assertThrows(() => findPeaks(x, { prominence: [null, [1, 2, 3]] }), /upper interval border must match x/);
});

test('findPeaks: SciPy argument errors', () => {
  assertThrows(() => findPeaks([0, 1, 0], { distance: 0.5 }), /distance/);
  assertThrows(() => findPeaks([0, 1, 0], { prominence: 0, wlen: 1 }), /wlen/);
  assertThrows(() => findPeaks([0, 1, 0], { width: 0, relHeight: -0.1 }), /rel_height/);
  assertThrows(() => peakProminences([0, 1, 0], [3]), /not a valid index/);
  assertThrows(() => peakProminences([0, 1, 0], [1.5]), /cast/);
  assertThrows(() => peakWidths([0, 1, 0, 1, 0], [1], 0.5, { prominences: [1], left_bases: [2], right_bases: [3] }),
    /invalid for peak 1/);
  assertThrows(() => peakWidths([0, 1, 0], [1], 0.5, [[1, 1], [0], [2]]), /same shape/);
});

test('findPeaks: zero-width / zero-prominence peaks are reported as warnings, not thrown', () => {
  const res = findPeaks([0, 2, 0, 1, 0], { width: [null, null], relHeight: 0 });
  assertDeepEqual(Array.from(res.properties.widths), [0, 0]);
  assert(res.warnings.some(w => /width of 0/.test(w)), 'width warning');
  const pr = peakProminences([0, 1, 2], [0]);
  assertEqual(pr.prominences[0], 0);
  assert(pr.warnings.some(w => /prominence of 0/.test(w)), 'prominence warning');
});

test('peakWidths accepts SciPy-style [prominences, left_bases, right_bases] triples', () => {
  const x = [0, 1, 3, 1, 0, 2, 5, 2, 0];
  const pd = peakProminences(x, [2, 6]);
  const a = peakWidths(x, [2, 6], 0.5, pd);
  const b = peakWidths(x, [2, 6], 0.5, [pd.prominences, pd.left_bases, pd.right_bases]);
  const c = peakWidths(x, [2, 6]);
  assertDeepEqual(Array.from(a.widths), Array.from(b.widths));
  assertDeepEqual(Array.from(a.widths), Array.from(c.widths));
  assertEqual(a.left_ips[0], 1.25);
  assertEqual(a.left_ips[1], 5 + 0.5 / 3);
});
