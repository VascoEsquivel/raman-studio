import { test, assert, assertEqual, assertClose, assertArrayClose, assertThrows, fixtureText } from './harness.js';
import { parseJcamp } from '../js/io/parse-jcamp.js';

const truth = JSON.parse(await fixtureText('io_truth.json'));
const N = truth.n;

test('AFFN (X++(Y..Y)) matches the source data', async () => {
  const r = parseJcamp(await fixtureText('spectrum_affn.jdx'), { filename: 'a.jdx' });
  assertEqual(r.format, 'jcamp');
  assertEqual(r.spectra.length, 1);
  const sp = r.spectra[0];
  assertEqual(sp.x.length, N);
  assertClose(sp.x[0], 100, 1e-9); assertClose(sp.x[N - 1], 3400, 1e-9);
  for (const i of [0, 300, 371, 825]) assertClose(sp.y[i], truth.y[i], 0.0051, 'y[' + i + ']');
});

test('ASDF-compressed file (SQZ/DIF/DUP with Y-checks) decodes to the AFFN values', async () => {
  const a = parseJcamp(await fixtureText('spectrum_affn.jdx')).spectra[0];
  const c = parseJcamp(await fixtureText('spectrum_compressed.jdx')).spectra[0];
  assertEqual(c.x.length, a.x.length);
  assertArrayClose(c.y, a.y, 1e-9);
  assertArrayClose(c.x, a.x, 1e-9);
});

test('XYPOINTS (XY..XY), descending in the file, comes out ascending', async () => {
  const sp = parseJcamp(await fixtureText('xy_points.dx')).spectra[0];
  assertEqual(sp.x.length, N);
  assertClose(sp.x[0], 100, 1e-9);
  assertClose(sp.y[371], truth.y[371], 1e-4);
});

test('laser wavelength from ##$LASER WAVELENGTH', async () => {
  const sp = parseJcamp(await fixtureText('spectrum_affn.jdx')).spectra[0];
  assertClose(sp.meta.laserNm, 532, 1e-9);
});

// Known-answer blocks in the style of the JCAMP-DX 4.24 ASDF examples:
// the ordinates 1 2 3 3 2 1 0 −1 −2 −3 written four ways.
const head = ['##TITLE=known answer', '##JCAMP-DX=4.24', '##XUNITS=1/CM', '##YUNITS=ARBITRARY UNITS',
  '##XFACTOR=1', '##YFACTOR=1', '##FIRSTX=1000', '##LASTX=1009', '##NPOINTS=10', '##XYDATA=(X++(Y..Y))'];
const EXPECT = [1, 2, 3, 3, 2, 1, 0, -1, -2, -3];
const block = lines => [...head, ...lines, '##END='].join('\n');

test('known answer: AFFN, SQZ, DIF and DIFDUP forms agree', () => {
  for (const [form, lines] of [
    ['AFFN', ['1000 1 2 3 3 2 1 0 -1 -2 -3']],
    ['SQZ', ['1000 ABCCBA@abc']],
    ['DIF', ['1000 AJJ%jjjjjj']],
    ['DIFDUP', ['1000 AJT%jX']],
  ]) {
    const sp = parseJcamp(block(lines)).spectra[0];
    assertArrayClose(sp.y, EXPECT, 1e-12, form);
    assertArrayClose(sp.x, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009], 1e-12, form + ' x');
  }
});

test('known answer: DIF Y-check across lines is not double-counted', () => {
  const sp = parseJcamp(block(['1000 AJT%j', '1004 Bjjjjj'])).spectra[0];
  assertArrayClose(sp.y, EXPECT, 1e-12);
});

test('garbage and empty input fail clearly', () => {
  assertThrows(() => parseJcamp('', { filename: 'e.jdx' }));
  assertThrows(() => parseJcamp('##TITLE=nothing\n##END=\n', { filename: 'n.jdx' }));
});
