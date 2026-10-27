import { test, assert, assertEqual, assertClose, assertThrows, fixtureText, fixtureBuffer } from './harness.js';
import { parseWdf } from '../js/io/parse-wdf.js';
import { importFile, sniff } from '../js/io/import.js';

const io = JSON.parse(await fixtureText('io_truth.json'));
const wt = JSON.parse(await fixtureText('wdf_truth.json'));
const lor = (x, c, h, g) => h / (1 + ((x - c) / g) ** 2);
const yOf = (x, dg, two) => {
  const [d, g, t] = io.peaks;
  return 50 + 0.08 * (x - 100) + dg * (lor(x, d.center, d.height, d.hwhm) + lor(x, g.center, g.height, g.hwhm)) + two * lor(x, t.center, t.height, t.hwhm);
};

test('map: every spectrum, ascending x, values, coordinates and grid', async () => {
  const r = parseWdf(await fixtureBuffer('map_small.wdf'), { filename: 'm.wdf' });
  assertEqual(r.format, 'wdf');
  assertEqual(r.spectra.length, wt.nx * wt.ny);
  assertEqual(r.warnings.length, 0);
  r.spectra.forEach((s, k) => {
    assertEqual(s.x.length, io.n, 'points');
    assertClose(s.x[0], io.x0, 1e-3, 'ascending from the first x');
    assertClose(s.x[s.x.length - 1], io.x0 + io.dx * (io.n - 1), 1e-3);
    for (const i of [0, 312, 371, 647, io.n - 1]) assertClose(s.y[i], yOf(s.x[i], wt.dgScale[k], wt.twoDScale[k]), 2e-3 * Math.abs(s.y[i]) + 1e-3, `y[${i}] of #${k + 1}`);
    const m = s.meta.map;
    assertEqual(m.index, k);
    assertClose(m.x, wt.coords[k][0], 1e-9); assertClose(m.y, wt.coords[k][1], 1e-9);
    assertEqual(m.unit, 'µm');
    assertEqual(m.grid.nx, wt.nx); assertEqual(m.grid.ny, wt.ny);
    assertClose(m.grid.dx, wt.dx, 1e-6); assertClose(m.grid.dy, wt.dy, 1e-6);
    assertEqual(s.source.format, 'wdf'); assertEqual(s.source.column, `#${k + 1}`);
    assert(s.name.includes(`#${k + 1}`) && s.name.includes('µm'), s.name);
  });
  assert(r.spectra.every(s => s.x === r.spectra[0].x), 'one shared x axis');
  assertEqual(new Set(r.spectra.map(s => s.id)).size, r.spectra.length, 'unique ids');
});

test('header: laser, accumulations, software, measurement and map grid; no operator name', async () => {
  const r = parseWdf(await fixtureBuffer('map_small.wdf'), { filename: 'm.wdf' });
  const m = r.spectra[0].meta;
  assertClose(m.laserNm, wt.laserNm, 0.01);
  assertEqual(m.header.Laser, '532.0 nm');
  assertEqual(m.header.Accumulations, String(wt.accumulations));
  assertEqual(m.header.Software, 'WiRE 5.6.0.1');
  assertEqual(m.header.Measurement, `map, ${wt.nx * wt.ny} spectra`);
  assertEqual(m.header.Map, `${wt.nx} × ${wt.ny} points, ${wt.dx} × ${wt.dy} µm steps`);
  assert(!JSON.stringify(r).includes('dummy'), 'the operator field is never read');
});

test('single spectrum: no map metadata, measurement says so', async () => {
  const r = parseWdf(await fixtureBuffer('single.wdf'), { filename: 's.wdf' });
  assertEqual(r.spectra.length, 1);
  const s = r.spectra[0];
  assertEqual(s.name, 's.wdf');
  assertEqual(s.meta.map, undefined);
  assertEqual(s.meta.header.Measurement, 'single spectrum');
  for (const i of [0, 371, io.n - 1]) assertClose(s.y[i], io.y[i], 2e-3 * Math.abs(io.y[i]));
});

test('import: WDF is recognised by content, whatever the extension', async () => {
  const buf = await fixtureBuffer('map_small.wdf');
  assertEqual(sniff(new Uint8Array(buf), '.dat'), 'wdf');
  const r = await importFile({ name: 'renamed.dat', arrayBuffer: async () => buf });
  assertEqual(r.format, 'wdf');
  assertEqual(r.spectra.length, wt.nx * wt.ny);
});

test('bad files fail with a clear message', async () => {
  const good = await fixtureBuffer('map_small.wdf');
  assertThrows(() => parseWdf(new ArrayBuffer(100)), /too short/);
  const notWdf = good.slice(0); new Uint8Array(notWdf)[0] = 0x58;
  assertThrows(() => parseWdf(notWdf), /not a Renishaw WDF/);
  assertThrows(() => parseWdf(good.slice(0, 2000), { filename: 't.wdf' }), /truncated|missing/);
  const image = good.slice(0); new DataView(image).setUint32(0x54, 4, true);
  assertThrows(() => parseWdf(image), /spectral image/);
});
