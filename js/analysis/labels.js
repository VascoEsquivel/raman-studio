/* Reviewer labels: a labelled dataset for later method work (machine learning needs
   expert labels the lab does not have yet: cosmic-ray masks and band assignments).

   A label records what a reviewer confirmed for one spectrum, as a snapshot taken
   when they save it: which points the cosmic-ray filter removed after their keeps
   and zaps, and which band each peak was assigned to after their overrides and
   hand-added peaks. Later changes to the settings do not alter a saved label. The
   dataset export is self-contained (raw x and y included) and is written only to
   the user's own machine. */

export const LABELS_SCHEMA = 'raman-studio/labels@1';
export const QUALITY = ['good', 'usable', 'reject'];

/**
 * Snapshot of the current, reviewed state of one spectrum.
 * @param {object} processed runPipeline result for the spectrum (with the reviewer's spike edits)
 * @param {object[]} items peak label items (detected and hand-added; fit-resolved ones are ignored)
 * @param {{keep:number[], zaps:number[][]}} spikeEdits
 * @returns {{removedIndices:number[], cosmicRays:object[], kept:number[], zaps:number[][],
 *   peaks:Array<{x:number, height:?number, fwhm:?number, label:string, bandId:?string,
 *   kind:string, origin:'auto'|'manual', override:boolean}>}}
 */
export function labelSnapshot(processed, items, spikeEdits) {
  const removed = [];
  const r = processed && processed.removed;
  if (r) for (let i = 0; i < r.length; i++) if (r[i]) removed.push(i);
  const num = v => (Number.isFinite(v) ? v : null);
  return {
    removedIndices: removed,
    cosmicRays: (processed && processed.spikes || []).map(e => ({ xStart: e.xStart, xEnd: e.xEnd, start: e.start, end: e.end, kind: e.kind, height: num(e.height) })),
    kept: [...(spikeEdits && spikeEdits.keep || [])],
    zaps: (spikeEdits && spikeEdits.zaps || []).map(z => [z[0], z[1]]),
    peaks: (items || []).filter(it => it.tier !== 'fit').map(it => ({
      x: it.x, height: num(it.height), fwhm: num(it.fwhm), label: it.sym, bandId: it.bandId || null,
      kind: it.kind, origin: it.tier === 'manual' ? 'manual' : 'auto', override: !!it.override,
    })).sort((a, b) => a.x - b.x),
  };
}

/**
 * The labelled dataset: every labelled spectrum with its raw data and its label.
 * @param {Array<{spectrum:object, label:object}>} entries spectrum = { name, source, meta, x, y }
 * @param {{exportedAt:string, app?:object, library?:object, laserNm?:number, calibration?:object|null}} ctx
 * @returns {object} JSON-ready dataset (schema raman-studio/labels@1)
 */
export function labelDataset(entries, ctx = {}) {
  return {
    schema: LABELS_SCHEMA,
    exportedAt: ctx.exportedAt,
    app: ctx.app || { name: 'Raman Studio' },
    library: ctx.library || null,
    laserNm: ctx.laserNm ?? null,
    calibration: ctx.calibration || null,
    note: 'Reviewer labels. removedIndices index the raw x/y arrays; positions are cm⁻¹ on the axis the spectrum was processed on (calibrated when calibration.offsetCm is set; x here is as read from the file).',
    spectra: entries.map(({ spectrum: sp, label: lb }) => ({
      name: sp.name,
      source: sp.source || null,
      map: sp.meta && sp.meta.map ? { index: sp.meta.map.index, x: sp.meta.map.x, y: sp.meta.map.y, unit: sp.meta.map.unit } : null,
      x: Array.from(sp.x), y: Array.from(sp.y),
      quality: lb.quality, note: lb.note || '', reviewer: lb.reviewer || '', labelledAt: lb.savedAt,
      checked: { cosmicRays: !!(lb.checked && lb.checked.cosmicRays), bands: !!(lb.checked && lb.checked.bands) },
      settings: lb.settings || null,
      calibrationOffsetCm: lb.calibrationOffsetCm ?? 0,
      ...lb.snapshot,
    })),
  };
}
