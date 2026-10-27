// Si band measurement for the wavenumber offset. The synthetic band and its position
// are arbitrary test values, not a nominal Si position (the app holds none).
import { test, assert, assertClose, assertThrows, fixtureText, rng, gauss } from './harness.js';
import { measureSiPeak } from '../js/analysis/calibration.js';
import { peakY } from '../js/fit/profile.js';

const band = { x0: 519.37, w: 4.5, h: 3000, g: 30 };
function synth(dx, { noise = 5, seed = 1, slope = 0.1 } = {}) {
  const r = rng(seed), n = Math.round(300 / dx);
  const x = Float64Array.from({ length: n }, (_, i) => 380 + i * dx);
  return { x, y: Float64Array.from(x, v => 80 + slope * (v - 380) + peakY(band, v) + noise * gauss(r)) };
}

test('Si band: centre recovered on fine and coarse grids, with an uncertainty', () => {
  for (const dx of [0.5, 1.2, 2.5]) {
    const { x, y } = synth(dx, { seed: Math.round(dx * 10) });
    const m = measureSiPeak(x, y);
    assertClose(m.x0, band.x0, 0.05, `grid ${dx} cm⁻¹`);
    assert(m.se > 0 && m.se < 0.1, `σ ${m.se} at grid ${dx}`);
    assert(m.lo === 480 && m.hi === 560, 'default search window');
  }
});

test('Si band: the search window is the user’s; nothing found is an error, not a guess', () => {
  const { x, y } = synth(1);
  assertThrows(() => measureSiPeak(x, y, { lo: 700, hi: 760 }), /No data/);
  const flat = Float64Array.from(x, () => 100);
  assertThrows(() => measureSiPeak(x, flat), /No band/);
  const m = measureSiPeak(x, y, { lo: 560, hi: 480 });
  assertClose(m.x0, band.x0, 0.05, 'window ends in either order');
});

test('Si fixture: the synthetic reference is measured at its known centre', async () => {
  const truth = JSON.parse(await fixtureText('phase4_truth.json')).si;
  const rows = (await fixtureText('si_reference.csv')).trim().split('\n').slice(1).map(l => l.split(',').map(Number));
  const m = measureSiPeak(Float64Array.from(rows, r => r[0]), Float64Array.from(rows, r => r[1]));
  assertClose(m.x0, truth.x0, 0.05);
});
