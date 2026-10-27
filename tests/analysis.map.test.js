import { test, assert, assertEqual, assertClose, fixtureText, fixtureBuffer } from './harness.js';
import { bandHeight, mapValues, correlation, layout, rampColor, RAMP } from '../js/analysis/map.js';
import { parseWdf } from '../js/io/parse-wdf.js';

const lor = (x, c, w, h) => h / (1 + 4 * ((x - c) / w) ** 2);
const X = Float64Array.from({ length: 600 }, (_, i) => 1000 + i);

test('band height: above a straight line across the window, whatever the slope under it', () => {
  for (const slope of [0, 0.5, -2]) {
    const y = Float64Array.from(X, x => 300 + slope * (x - 1000) + lor(x, 1300, 12, 800));
    assertClose(bandHeight(X, y, 1240, 1360), 800, 800 * 0.06, `slope ${slope}`);   // the window edges sit on the band's tails
  }
  const flat = Float64Array.from(X, () => 50);
  assertClose(bandHeight(X, flat, 1100, 1200), 0, 1e-12, 'no band: zero');
  assert(Number.isNaN(bandHeight(X, flat, 1100.5, 1105.5)), 'fewer than 7 points: NaN');
  assertClose(bandHeight(X, Float64Array.from(X, x => lor(x, 1300, 12, 800)), 1360, 1240), bandHeight(X, Float64Array.from(X, x => lor(x, 1300, 12, 800)), 1240, 1360), 1e-12, 'window ends in either order');
});

test('map values: heights per spectrum, ratios empty where the denominator is absent', () => {
  const sp = [1, 2, 3].map(k => ({ x: X, y: Float64Array.from(X, x => 100 + lor(x, 1300, 12, 100 * k) + lor(x, 1500, 12, k === 3 ? 0 : 50)) }));
  const a = mapValues(sp, { lo: 1250, hi: 1350 });
  assert(a[0] < a[1] && a[1] < a[2], 'heights follow the band');
  const r = mapValues(sp, { lo: 1250, hi: 1350 }, { lo: 1450, hi: 1550 });
  assertClose(r[1] / r[0], 2, 0.05);
  assert(Number.isNaN(r[2]), 'no denominator band: NaN, not infinity');
});

test('correlation: perfect, inverse, too few points, constant map', () => {
  assertClose(correlation([1, 2, 3, 4], [2, 4, 6, 8]).r, 1, 1e-12);
  assertClose(correlation([1, 2, 3, 4], [8, 6, 4, 2]).r, -1, 1e-12);
  const c = correlation([1, NaN, 3, 4, 5], [1, 7, 3, NaN, 5]);
  assertEqual(c.n, 3, 'pairs with a NaN are skipped');
  assert(Number.isNaN(correlation([1, 2], [1, 2]).r), 'two points');
  assert(Number.isNaN(correlation([3, 3, 3], [1, 2, 3]).r), 'constant map');
});

test('layout: grid cells from stage coordinates, holes allowed', () => {
  const pts = [[0, 0], [5, 0], [10, 0], [0, 4], [10, 4]].map(([x, y]) => ({ x, y }));
  const L = layout(pts);
  assertEqual(L.nx, 3); assertEqual(L.ny, 2);
  assertEqual(L.dx, 5); assertEqual(L.dy, 4);
  assertEqual(JSON.stringify(L.cell), JSON.stringify([[0, 0], [1, 0], [2, 0], [0, 1], [2, 1]]));
  const jitter = layout([{ x: 0, y: 0 }, { x: 5 + 1e-9, y: 0 }, { x: 5, y: 3 }, { x: 0, y: 3 }]);
  assertEqual(jitter.nx, 2, 'float noise does not create extra columns');
});

test('colour ramp: one hue light to dark; low recedes into the surface in both themes', () => {
  assertEqual(rampColor(0, false), RAMP[0]); assertEqual(rampColor(1, false), RAMP[RAMP.length - 1]);
  assertEqual(rampColor(0, true), RAMP[RAMP.length - 1]); assertEqual(rampColor(1, true), RAMP[0]);
  assertEqual(rampColor(NaN, false), null);
  const lum = h => { const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  let prev = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) { const L = lum(rampColor(t, false)); assert(L < prev, `monotonic at ${t.toFixed(2)}`); prev = L; }
});

test('WDF map fixture: D and G rise together, 2D falls (r = +1 and −1)', async () => {
  const wt = JSON.parse(await fixtureText('wdf_truth.json'));
  const sp = parseWdf(await fixtureBuffer('map_small.wdf')).spectra;
  const D = mapValues(sp, { lo: 1290, hi: 1410 }), G = mapValues(sp, { lo: 1545, hi: 1625 }), T = mapValues(sp, { lo: 2600, hi: 2780 });
  assertClose(correlation(D, G).r, 1, 1e-4);
  assertClose(correlation(G, T).r, -1, 1e-4);
  const L = layout(sp.map(s => s.meta.map));
  assertEqual(L.nx, wt.nx); assertEqual(L.ny, wt.ny);
});
