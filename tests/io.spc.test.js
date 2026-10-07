import { test, assert, assertEqual, assertClose, assertThrows, fixtureText, fixtureBuffer } from './harness.js';
import { parseSpc } from '../js/io/parse-spc.js';

const truth = JSON.parse(await fixtureText('io_truth.json'));
const N = truth.n;
const ascending = x => { for (let i = 1; i < x.length; i++) if (!(x[i] > x[i - 1])) return false; return true; };

test('evenly spaced, 32-bit integer Y with exponent, laser from the log block', async () => {
  const r = parseSpc(await fixtureBuffer('spectrum_even.spc'), { filename: 'e.spc' });
  assertEqual(r.format, 'spc');
  assertEqual(r.spectra.length, 1);
  const sp = r.spectra[0];
  assertEqual(sp.x.length, N);
  assertClose(sp.x[0], 100, 1e-9); assertClose(sp.x[N - 1], 3400, 1e-9);
  for (const i of [0, 371, 600, 825]) assertClose(sp.y[i], truth.y[i], 1e-5, 'y[' + i + ']');
  assertClose(sp.meta.laserNm, 785, 1e-9);
});

test('TXVALS: explicit float32 x array (descending) and float Y', async () => {
  const sp = parseSpc(await fixtureBuffer('spectrum_float_xy.spc')).spectra[0];
  assertEqual(sp.x.length, N);
  assert(ascending(sp.x), 'ascending after import');
  assertClose(sp.x[0], 100, 1e-3);
  assertClose(sp.y[371], truth.y[371], 1e-3 * truth.y[371]);
});

test('multi-subfile file gives one spectrum per subfile, each with its own exponent', async () => {
  const r = parseSpc(await fixtureBuffer('multi_subfile.spc'), { filename: 'm.spc' });
  assertEqual(r.spectra.length, 2);
  const [s, o] = truth.variants[1];
  assertClose(r.spectra[1].y[371], s * truth.y[371] + o, 1e-5);
  assertClose(r.spectra[0].y[371], truth.y[371], 1e-5);
  assert(r.spectra[1].name.includes('subfile 2'));
});

test('old-format, foreign and truncated files fail with clear messages', async () => {
  const buf = await fixtureBuffer('spectrum_even.spc');
  const old = buf.slice(0); new Uint8Array(old)[1] = 0x4D;
  assertThrows(() => parseSpc(old, { filename: 'old.spc' }), /old/i);
  const bad = buf.slice(0); new Uint8Array(bad)[1] = 0x20;
  assertThrows(() => parseSpc(bad), /not an SPC/i);
  assertThrows(() => parseSpc(buf.slice(0, 1000)), /truncated/i);
  assertThrows(() => parseSpc(new ArrayBuffer(100)), /too short/i);
});
