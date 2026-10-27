// Reviewer labels: the snapshot of a reviewed spectrum and the exported dataset.
import { test, assert, assertEqual, assertDeepEqual } from './harness.js';
import { labelSnapshot, labelDataset, LABELS_SCHEMA, QUALITY } from '../js/analysis/labels.js';

const processed = {
  x: Float64Array.of(100, 101, 102, 103, 104, 105),
  removed: Uint8Array.of(0, 0, 1, 1, 0, 0),
  spikes: [{ start: 2, end: 3, xStart: 102, xEnd: 103, kind: 'cosmic', height: 512 }],
};
const items = [
  { id: 'a:104', tier: 'detected', kind: 'unassigned', sym: 'unassigned', x: 104, height: 50, fwhm: 2, bandId: null },
  { id: 'a:101', tier: 'detected', kind: 'detected', sym: 'D', x: 101, height: 80, fwhm: 3, bandId: 'D', override: true },
  { id: 'm:1', tier: 'manual', kind: 'detected', sym: 'G', x: 105, height: 20, fwhm: NaN, bandId: 'G' },
  { id: 'f:G', tier: 'fit', kind: 'fit', sym: 'G', x: 105.2, bandId: 'G' },
];

test('label snapshot: removed points, events, edits and peak assignments as reviewed', () => {
  const s = labelSnapshot(processed, items, { keep: [150], zaps: [[120, 121]] });
  assertDeepEqual(s.removedIndices, [2, 3]);
  assertEqual(s.cosmicRays.length, 1); assertEqual(s.cosmicRays[0].kind, 'cosmic');
  assertDeepEqual(s.kept, [150]); assertDeepEqual(s.zaps, [[120, 121]]);
  assertDeepEqual(s.peaks.map(p => p.x), [101, 104, 105], 'detected and hand-added, sorted; fit components left out');
  assertEqual(s.peaks[0].override, true); assertEqual(s.peaks[2].origin, 'manual');
  assertEqual(s.peaks[2].fwhm, null, 'non-finite numbers become null');
});

test('label dataset: self-contained, one entry per labelled spectrum', () => {
  const label = { quality: 'good', note: 'n', reviewer: 'r', savedAt: '2026-10-27T00:00:00Z', checked: { cosmicRays: true, bands: false },
    calibrationOffsetCm: 0.5, settings: { despike: { on: true } }, snapshot: labelSnapshot(processed, items, { keep: [], zaps: [] }) };
  const sp = { name: 'map · #1', source: { file: 'map.wdf' }, meta: { map: { index: 0, x: 1, y: 2, unit: 'µm' } }, x: processed.x, y: Float64Array.of(1, 2, 900, 800, 3, 4) };
  const ds = labelDataset([{ spectrum: sp, label }], { exportedAt: 'now', laserNm: 532 });
  assertEqual(ds.schema, LABELS_SCHEMA);
  assertEqual(ds.spectra.length, 1);
  const e = ds.spectra[0];
  assert(Array.isArray(e.x) && e.x.length === 6 && e.y[2] === 900, 'raw data included as plain arrays');
  assertDeepEqual(e.map, { index: 0, x: 1, y: 2, unit: 'µm' });
  assertDeepEqual(e.removedIndices, [2, 3]);
  assertEqual(e.quality, 'good'); assertDeepEqual(e.checked, { cosmicRays: true, bands: false });
  assertEqual(e.calibrationOffsetCm, 0.5);
  assert(JSON.parse(JSON.stringify(ds)).spectra[0].peaks.length === 3, 'serialises cleanly');
  assertDeepEqual(QUALITY, ['good', 'usable', 'reject']);
});
