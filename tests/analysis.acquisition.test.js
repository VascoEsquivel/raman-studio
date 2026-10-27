import { test, assert, assertEqual, assertClose } from './harness.js';
import { acquisition, qualityFlags } from '../js/analysis/acquisition.js';

// The key=value lines WiRE writes into the SPC log block (as parse-spc.js stores them).
const WIRE = {
  Operator: 'someone', Scan_type: 'Continuous', Exposure_time: 'Time: 10000', Accumulations: 'Accumulations: 1',
  Cosmic_ray_removal: 'Cosmic ray removal: 0', Laser: 'Laser: 532 nm edge', Grating_grooves: 'Grating: 1200 l/mm (633/780)',
  Laser_power: 'Laser_power: 10%', Slit_opening: '65µm', Version: '5.6.0.32934', Serial_number: 'X1',
};

test('WiRE header: settings read and labelled, exposure in seconds', () => {
  const a = acquisition({ header: WIRE, laserNm: 532 });
  const f = Object.fromEntries(a.fields.map(x => [x.label, x.value]));
  assertEqual(f.Laser, '532 nm edge');
  assertEqual(f.Grating, '1200 l/mm (633/780)');
  assertEqual(f.Exposure, '10 s');
  assertEqual(f.Accumulations, '1');
  assertEqual(f['Instrument cosmic-ray removal'], 'off');
  assertEqual(f['Laser power'], '10%');
  assertEqual(f.Slit, '65µm');
  assertEqual(f['Software version'], '5.6.0.32934');
  assertClose(a.exposureS, 10, 1e-12);
  assertEqual(a.accumulations, 1);
  assertEqual(a.cosmicRayRemoval, false);
  assertEqual(a.laserNm, 532);
  assert(!a.fields.some(x => /operator|serial/i.test(x.label)), 'operator and serial numbers are not surfaced');
});

test('other header forms: exposure shown verbatim, removal on, no header at all', () => {
  const a = acquisition({ header: { EXPOSURE: '2.5 s', COSMIC_RAY_REMOVAL: 'on' } });
  assertEqual(a.fields.find(x => x.label === 'Exposure').value, '2.5 s');
  assertEqual(a.exposureS, null, 'only WiRE "Time: ms" is converted');
  assertEqual(a.cosmicRayRemoval, true);
  const none = acquisition({});
  assertEqual(none.hasHeader, false);
  assertEqual(none.fields.length, 0);
  assertEqual(acquisition(null).fields.length, 0);
});

const ramp = n => ({ x: Float64Array.from({ length: n }, (_, i) => 100 + 2.5 * i), y: Float64Array.from({ length: n }, (_, i) => 200 + 50 * Math.sin(i / 9) + (i % 7)) });

test('quality: instrument cosmic-ray removal off with one accumulation is a warning', () => {
  const flags = qualityFlags(ramp(400), acquisition({ header: WIRE }));
  const f = flags.find(x => x.id === 'crr-off');
  assert(f && f.level === 'warn' && /only one accumulation/.test(f.text));
  assertEqual(flags.length, 1, 'nothing else on clean data');
  assertEqual(qualityFlags(ramp(400), acquisition({})).length, 0, 'no header, clean data: no flags');
});

test('quality: a flat-topped maximum and a flat segment are flagged', () => {
  const s = ramp(400);
  for (let i = 200; i < 205; i++) s.y[i] = 999;
  const flat = qualityFlags(s, acquisition({}));
  const top = flat.find(x => x.id === 'flat-top');
  assert(top && /5 consecutive points/.test(top.text) && /saturated/.test(top.text), 'flat top');
  const t = ramp(400);
  for (let i = 50; i < 70; i++) t.y[i] = 123;
  assert(qualityFlags(t, acquisition({})).some(x => x.id === 'flat-segment'), 'flat segment');
  const u = ramp(400); u.y[10] = 65535;
  assert(qualityFlags(u, acquisition({})).some(x => x.id === 'adc-ceiling'), '16-bit ceiling');
});
