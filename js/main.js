// Raman Studio — boot and wiring.
// Data flow: file → io → Spectrum → process (pipeline) → detect → match (atlas)
// → analysis (ratios, workflow) → render. Deconvolution is an explicit step (F).

import { importFile, applyMapping } from './io/import.js';
import { runPipeline, DEFAULT_SETTINGS } from './process/pipeline.js';
import { detectPeaks, DEFAULT_DETECT } from './detect/detect.js';
import { estimateNoise } from './detect/noise.js';
import { loadLibraries, prepareLibrary } from './match/library.js';
import { matchPeaks, bandConfidence } from './match/matcher.js';
import { deconvolve } from './fit/deconvolve.js';
import { peakY } from './fit/profile.js';
import { computeRatios } from './analysis/ratios.js';
import { evaluateWorkflow } from './analysis/workflow.js';
import { acquisition, qualityFlags } from './analysis/acquisition.js';
import { mapValues, correlation, layout } from './analysis/map.js';
import { synthFromLibrary, synthMonolayer } from './sample/synth.js';
import { peakTableCSV, fitParamsCSV, spectrumCSV, toCSV } from './export/csv.js';
import { buildFigureSVG, svgToPng } from './export/image.js';
import { fillReport } from './export/report.js';
import { Plot } from './render/plot.js';
import { Minimap } from './render/minimap.js';
import { interpAt } from './render/frame.js';
import { Chain } from './ui/chain.js';
import * as panes from './ui/panels.js';
import { askMapping } from './ui/mapper.js';
import { showHelp } from './ui/help.js';
import { $, $$, esc, toast, download, store, fmt, fmtX, dismissable, plainText } from './ui/dom.js';

const clone = o => JSON.parse(JSON.stringify(o));
const OVERLAY = ['#6aa9ff', '#c58bff', '#ffb547', '#5fd3c4', '#ff7aa8', '#a6d46a', '#f0e26a'];

// ------------------------------------------------------------------ state
const S = {
  libraries: [], library: null, prepared: null,
  laserNm: 532,
  spectra: [], activeId: null, stack: 'single',
  settings: clone(DEFAULT_SETTINGS),
  detect: { ...DEFAULT_DETECT },
  toleranceCm: null,
  processed: null, procCache: new Map(),
  autoPeaks: [], manual: [], hidden: [], overrides: {},
  spikeEdits: { keep: [], zaps: [] },   // per active spectrum: despike keeps (cm⁻¹) and hand zaps ([lo, hi])
  map: { num: 'G', den: '', cmp: '', numLo: null, numHi: null, cmpLo: null, cmpHi: null },   // Map tab measures
  peaks: [], assignments: [], items: [],
  deconv: null, ratios: [], workflow: null, noiseSigma: 0,
  display: 'processed', showComponents: true, labelAllFit: false,
  selectedId: null, hoverId: null, tab: 'peaks', labelsOn: true,
};
let manualSeq = 1;
let plot, minimap, chain;

// ------------------------------------------------------------------ history
const undoStack = [], redoStack = [];
let pendingSnap = null;
const snapshot = () => JSON.stringify({
  settings: S.settings, detect: S.detect, toleranceCm: S.toleranceCm, laserNm: S.laserNm,
  libraryId: S.library && S.library.id, manual: S.manual, hidden: S.hidden, overrides: S.overrides,
  spikeEdits: S.spikeEdits,
});
function pushHistory(snap = snapshot()) {
  if (undoStack[undoStack.length - 1] === snap) return;
  undoStack.push(snap); if (undoStack.length > 100) undoStack.shift();
  redoStack.length = 0;
}
function restore(snap) {
  const o = JSON.parse(snap);
  Object.assign(S, { settings: o.settings, detect: o.detect, toleranceCm: o.toleranceCm, manual: o.manual, hidden: o.hidden, overrides: o.overrides,
    spikeEdits: o.spikeEdits || { keep: [], zaps: [] } });
  if (o.libraryId && o.libraryId !== S.library?.id) S.library = S.libraries.find(l => l.id === o.libraryId) || S.library;
  setLaser(o.laserNm, { silent: true });
  recompute('process');
}
function undo() { if (!undoStack.length) return toast('Nothing to undo'); redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return toast('Nothing to redo'); undoStack.push(snapshot()); restore(redoStack.pop()); }

// ------------------------------------------------------------------ helpers
const active = () => S.spectra.find(s => s.id === S.activeId) || null;
const tol = () => S.toleranceCm ?? S.library?.matchDefaults?.toleranceCm ?? 25;
const refText = () => {
  const r = S.library?.referenceExcitation;
  if (!r || r.nm == null) return 'an unstated excitation';
  return `${r.nm} nm${r.status === 'assumed' ? ' (assumed: the atlas does not state it)' : ''}`;
};
function busy(on, text = 'Working…') { $('#busy').hidden = !on; $('#busyText').textContent = text; }
const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const safeName = s => (s || 'spectrum').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60);

function prepare() {
  if (!S.library) { S.prepared = null; return; }
  S.prepared = prepareLibrary(S.library, { laserNm: S.laserNm, toleranceCm: tol() });
}
function gWindow() {
  const g = S.prepared && S.prepared.bands.find(b => b.id === 'G');
  return g ? g.window : null;
}

/** The other spectra of the same file (and sheet) on exactly the same x: a map
 *  or series, which despike may use as a second opinion. */
function companionsFor(sp) {
  if (!sp || !sp.source || !sp.source.file) return [];
  const n = sp.x.length, tolX = 1e-9 * Math.abs((sp.x[n - 1] - sp.x[0]) || 1);
  const sameX = o => o.x.length === n && o.x.every((v, i) => Math.abs(v - sp.x[i]) <= tolX);
  return S.spectra.filter(o => o !== sp && o.source && o.source.file === sp.source.file && o.source.sheet === sp.source.sheet && sameX(o)).map(o => o.y);
}
function pipelineFor(sp, edits = null) {
  return runPipeline(sp, S.settings, { bandWindow: gWindow(), companions: companionsFor(sp), spikeEdits: edits });
}

// ------------------------------------------------------------------ compute chain
/**
 * Recompute from a given stage downward.
 * process → detect → match → analysis. Deconvolution is invalidated whenever
 * the processed spectrum or the band windows change, because its seeds and
 * bounds depend on both.
 */
function recompute(level = 'process', { reveal = false, keepCache = false } = {}) {
  const sp = active();
  try {
    if (level === 'process' || level === 'match') prepare();
    if (sp && level === 'process') {
      S.processed = pipelineFor(sp, S.spikeEdits);
      // switching spectrum changes no setting: the other spectra's results stay valid
      if (keepCache) S.procCache.delete(sp.id); else S.procCache.clear();
      S.noiseSigma = estimateNoise(S.processed.y);
      S.deconv = null;
    }
    if (sp && (level === 'process' || level === 'detect')) {
      S.autoPeaks = detectPeaks(S.processed.x, S.processed.y, S.detect);
    }
    if (level === 'match') S.deconv = null;
    if (sp) analyse();
  } catch (err) {
    toast('Processing failed: ' + err.message, { warn: true, ms: 5000 });
  }
  if (reveal) plot.revealOnNextRender();
  renderAll();
}

function analyse() {
  const P = S.processed;
  if (!P) return;
  // merge auto (minus hidden) and manual peaks
  const hiddenHit = p => S.hidden.some(h => Math.abs(h - p.x) <= Math.max(2, 0.4 * (p.fwhm || 0)));
  const auto = S.autoPeaks.filter(p => !hiddenHit(p)).map(p => ({ ...p, id: 'a:' + Math.round(p.x), manual: false }));
  const manual = S.manual.map(m => ({ id: m.id, x: m.x, y: interpAt(P.x, P.y, m.x), prominence: null, fwhm: null, manual: true }));
  const seen = new Set();
  S.peaks = [...auto, ...manual].filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true))).sort((a, b) => a.x - b.x);

  let asg = S.prepared ? matchPeaks(S.peaks, S.prepared) : S.peaks.map(p => ({ peakId: p.id, x: p.x, kind: 'unassigned', bandId: null, label: 'unassigned', confidence: 0, delta: null, alternatives: [] }));
  asg = asg.map(a => {
    const o = S.overrides[a.peakId];
    if (o === undefined || !S.prepared) return a;
    const pb = S.prepared.bands.find(b => b.id === o);
    if (!pb) return a;
    return { ...a, kind: 'band', bandId: pb.id, label: pb.label, confidence: bandConfidence(a.x, pb), delta: a.x - pb.center, override: true };
  });
  S.assignments = asg;
  buildItems();
  const comps = S.deconv ? S.deconv.components : [];
  try {
    S.ratios = S.prepared ? computeRatios(S.prepared, { assignments: asg, peaks: S.peaks, components: comps, laserNm: S.laserNm }) : [];
  } catch (err) { S.ratios = []; toast('Ratio calculation failed: ' + err.message, { warn: true }); }
  try {
    S.workflow = S.prepared ? evaluateWorkflow(S.prepared, {
      ratios: S.ratios, components: comps, assignments: asg, peaks: S.peaks, noiseSigma: S.noiseSigma,
      xRange: [P.x[0], P.x[P.x.length - 1]],
    }) : null;
  } catch (err) { S.workflow = null; toast('Workflow evaluation failed: ' + err.message, { warn: true }); }
}

function nearestBand(x) {
  if (!S.prepared) return null;
  let best = null;
  for (const b of S.prepared.bands) {
    const d = x < b.window[0] ? x - b.window[0] : x > b.window[1] ? x - b.window[1] : 0;
    if (!best || Math.abs(d) < Math.abs(best.dist)) best = { label: b.label, window: b.window, dist: d };
  }
  return best;
}

function buildItems() {
  const lib = S.library, prep = S.prepared;
  const bandById = id => lib && lib.bands.find(b => b.id === id);
  const pbandById = id => prep && prep.bands.find(b => b.id === id);
  const items = [];
  S.peaks.forEach((p, i) => {
    const a = S.assignments[i] || {};
    const band = a.kind === 'band' ? bandById(a.bandId) : null;
    const region = a.kind === 'region' ? (prep?.regions || []).find(r => a.label === r.label || r.id === a.regionId) || (prep?.regions || [])[0] : null;
    items.push({
      id: p.id, tier: p.manual ? 'manual' : 'detected', tierText: p.manual ? 'added by hand' : 'detected',
      kind: a.kind === 'band' ? 'detected' : a.kind === 'region' ? 'region' : 'unassigned',
      sym: band ? band.label : region ? region.label : 'unassigned',
      sub: String(Math.round(p.x)),
      name: band ? plainText(band.name) : region ? (region.name || region.label) : 'Unassigned peak',
      x: p.x, height: p.y, fwhm: p.fwhm, prominence: p.prominence, area: null,
      confidence: a.confidence ?? 0, delta: a.delta ?? null, bandId: a.bandId || null,
      band, pband: band ? pbandById(band.id) : null, region,
      alternatives: a.alternatives || [], override: !!a.override,
      nearest: a.kind === 'unassigned' ? nearestBand(p.x) : null,
      priority: (a.kind === 'band' ? 2 : 1) + Math.min(1, (p.prominence || 0) / ((S.noiseSigma || 1) * 40)),
    });
  });
  if (S.deconv) {
    for (const c of S.deconv.components) {
      const band = bandById(c.bandId);
      const pb = pbandById(c.bandId);
      items.push({
        id: 'f:' + c.bandId, tier: 'fit', tierText: 'fit-resolved', kind: 'fit',
        sym: band ? band.label : c.label, sub: Math.round(c.x0) + ' · fit',
        name: band ? plainText(band.name) : c.label,
        x: c.x0, height: c.h, fwhm: c.w, area: c.area, prominence: null,
        confidence: null, delta: pb ? c.x0 - pb.center : null, bandId: c.bandId,
        band, pband: pb, comp: c, significant: c.significant, priority: 0.5,
      });
    }
  }
  S.items = items;
  if (S.selectedId && !items.some(i => i.id === S.selectedId)) S.selectedId = null;
}

/** Items that get a label on the plot. Fit components only label bands the
 *  detector could not see (the hidden shoulders), unless "label every fitted band". */
function labeledItems() {
  const tier1Bands = new Set(S.items.filter(i => i.tier !== 'fit' && i.bandId).map(i => i.bandId));
  return S.items.filter(i => i.tier !== 'fit' || (i.significant && (S.labelAllFit || !tier1Bands.has(i.bandId))));
}

// ------------------------------------------------------------------ scene
function processedFor(sp) {
  if (sp.id === S.activeId) return S.processed;
  if (!S.procCache.has(sp.id)) {
    try { S.procCache.set(sp.id, pipelineFor(sp)); } catch { S.procCache.set(sp.id, null); }
  }
  return S.procCache.get(sp.id);
}

function buildScene() {
  const P = S.processed;
  const n = P.x.length;
  const disp = S.display;
  const panels = [];
  const raw = [{ x: P.x, y: P.raw, color: '--ink-2', width: 1.1, primary: true }];
  if (P.baseline) raw.push({ x: P.x, y: P.baseline, color: '--baseline', width: 1.3, dash: [6, 4], noCeiling: true });
  const normed = P.steps && P.steps.normalize;
  const yLabel = normed ? 'Normalized intensity' : (P.steps && P.steps.baseline ? 'Intensity (baseline-corrected)' : 'Intensity');

  const spikes = [];
  const runs = groupSpikes(P);

  if (disp === 'both') {
    panels.push({ id: 'raw', weight: 0.7, tag: 'Raw · baseline', exportTag: 'Raw', traces: raw, yLabel: '' });
    for (const r of runs) spikes.push({ panelId: 'raw', x: r.x, yTop: r.yTop, yBottom: r.yBottom });
  }

  const labels = [];
  const visibleItems = S.labelsOn ? labeledItems() : [];
  if (disp === 'raw') {
    for (const it of visibleItems) if (it.tier !== 'fit') labels.push(labelFor(it, interpAt(P.x, P.raw, it.x)));
    panels.push({ id: 'main', weight: 1, tag: 'Raw · baseline', exportTag: '', traces: raw, labels, yLabel: 'Intensity (raw)', headroom: labels.length ? 0.34 : 0.08 });
    for (const r of runs) spikes.push({ panelId: 'main', x: r.x, yTop: r.yTop, yBottom: r.yBottom });
  } else {
    const traces = [];
    // other spectra (overlay / stacked)
    let offStep = 0;
    const others = S.stack === 'single' ? [] : S.spectra.filter(s => s.id !== S.activeId);
    if (S.stack === 'stacked' && others.length) {
      let mx = rangeOf(P.y);
      for (const o of others) { const q = processedFor(o); if (q) mx = Math.max(mx, rangeOf(q.y)); }
      offStep = mx * 1.08;
    }
    others.forEach((o, i) => {
      const q = processedFor(o);
      if (!q) return;
      traces.push({ x: q.x, y: q.y, color: OVERLAY[i % OVERLAY.length], width: 1, alpha: 0.7, offset: offStep * (i + 1), z: -1, noCeiling: S.stack === 'overlay' });
    });
    traces.push({ x: P.x, y: P.y, color: '--laser', width: 1.6, glow: true, primary: true, fill: { alpha: 0.07, to: 0 }, z: 2 });
    if (S.deconv) {
      const xs = P.x;
      if (S.showComponents) {
        for (const c of S.deconv.components) {
          if (!c.significant) continue;
          const w = S.deconv.windows[c.windowIndex];
          const y = new Float64Array(n);
          for (let i = 0; i < n; i++) {
            const x = xs[i];
            y[i] = (x < w.lo || x > w.hi) ? NaN : baseAt(w.baseline, x) + peakY(c, x);
          }
          traces.push({ x: xs, y, color: '--fit', width: 1, alpha: 0.85, dash: [4, 3], noCeiling: true, noScale: true, z: 3 });
        }
      }
      const env = new Float64Array(n);
      for (let i = 0; i < n; i++) env[i] = S.deconv.model(xs[i]);
      traces.push({ x: xs, y: env, color: '--fit-env', width: 1.1, alpha: 0.75, noScale: true, z: 4 });
    }
    for (const it of visibleItems) {
      const y = it.tier === 'fit' ? S.deconv.model(it.x) : interpAt(P.x, P.y, it.x);
      labels.push(labelFor(it, y));
    }
    panels.push({
      id: 'main', weight: 1, tag: S.deconv ? 'Processed · fit' : 'Processed', exportTag: '', traces, labels, yLabel,
      headroom: labels.length ? 0.34 : 0.08,
    });
    const nf = P.normFactor || 1;
    for (const r of runs) {
      const yb = interpAt(P.x, P.y, r.x);
      spikes.push({ panelId: 'main', x: r.x, yBottom: yb, yTop: yb + (r.yTop - r.yBottom) / nf });
    }
    if (S.deconv) {
      const rt = [];
      for (const w of S.deconv.windows) if (w.residual) rt.push({ x: w.residual.x, y: w.residual.r, color: '--ink-3', width: 0.9, primary: rt.length === 0 });
      if (rt.length) panels.push({ id: 'resid', weight: 0.2, tag: 'Residual', exportTag: 'Residual', symmetric: true, zeroLine: true, traces: rt });
    }
  }

  // highlighted band window (hovered or selected label)
  const focusId = S.hoverId || S.selectedId;
  const focus = focusId && S.items.find(i => i.id === focusId);
  const bandWindows = focus && focus.pband ? [{ lo: focus.pband.window[0], hi: focus.pband.window[1], label: focus.pband.label + ' window' }] : [];

  const spacing = (P.x[n - 1] - P.x[0]) / Math.max(1, n - 1);
  return {
    panels, domain: [P.x[0], P.x[n - 1]], minSpan: Math.max(5, spacing * 8),
    xLabel: 'Raman shift (cm⁻¹)', bandWindows, spikes, showLabels: S.labelsOn,
    bottomPad: 30,   // room for the minimap strip under the axis
  };
}

function labelFor(it, y) {
  return { id: it.id, x: it.x, y, sym: it.sym, sub: it.sub, kind: it.kind === 'detected' ? 'detected' : it.kind, priority: it.priority };
}
function baseAt(b, x) {
  if (!b || b.mode === 'none') return 0;
  const u = (x - b.xMin) / ((b.xMax - b.xMin) || 1);
  if (b.mode === 'const') return b.c0;
  if (b.mode === 'linear') return b.c0 + b.c1 * u;
  return b.c0 + b.c1 * u + b.c2 * u * u;
}
function rangeOf(y) { let lo = Infinity, hi = -Infinity; for (const v of y) if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } return isFinite(hi - lo) ? hi - lo : 1; }

/** Group removed points into spike runs with their original peak height. */
function groupSpikes(P) {
  const rem = (P.removed || []).slice().sort((a, b) => a.index - b.index);
  const runs = [];
  for (const r of rem) {
    const last = runs[runs.length - 1];
    if (last && r.index - last.end <= 1) {
      last.end = r.index; last.xs.push(r.x);
      if (r.y > last.yTop) { last.yTop = r.y; last.yBottom = r.replacedY; }
    } else runs.push({ start: r.index, end: r.index, xs: [r.x], yTop: r.y, yBottom: r.replacedY });
  }
  return runs.map(r => ({ x: r.xs.reduce((a, b) => a + b, 0) / r.xs.length, yTop: r.yTop, yBottom: r.yBottom }));
}

// ------------------------------------------------------------------ render
function viewModel() {
  const lib = S.library;
  return {
    hasData: !!S.processed, library: lib, prepared: S.prepared, laserNm: S.laserNm,
    items: S.items, selectedId: S.selectedId, ratios: S.ratios, workflow: S.workflow,
    deconv: S.deconv, toleranceCm: tol(), refText: refText(),
    showComponents: S.showComponents, labelAllFit: S.labelAllFit,
    fitBounds: lib ? `bounded to ${lib.fitDefaults?.fwhmMin ?? '—'}–${lib.fitDefaults?.fwhmMax ?? '—'} cm⁻¹` : '',
    data: dataModel(),
    map: S.tab === 'map' ? mapModel() : null,
  };
}

/** What the Data pane shows: acquisition settings, quality flags, spike removal. */
function dataModel() {
  const sp = active(), P = S.processed;
  if (!sp || !P) return null;
  const acq = acquisition(sp.meta);
  return {
    name: sp.name, source: sp.source || {}, points: P.x.length, x0: P.x[0], x1: P.x[P.x.length - 1],
    acq, flags: qualityFlags({ x: sp.x, y: sp.y }, acq),
    despikeOn: !!(P.steps && P.steps.despike), despike: S.settings.despike, info: P.despikeInfo,
    spikes: P.spikes || [], suspects: P.suspects || [], restored: P.restored || [], edits: S.spikeEdits,
    setSize: companionsFor(sp).length,
  };
}

/** The spectra of the active spectrum's map (same file and sheet, with stage coordinates), in map order. */
function mapSet(sp) {
  if (!sp || !sp.meta || !sp.meta.map || !sp.source) return [];
  return S.spectra.filter(o => o.meta && o.meta.map && o.source && o.source.file === sp.source.file && o.source.sheet === sp.source.sheet)
    .sort((a, b) => a.meta.map.index - b.meta.map.index);
}

/** What the Map pane draws: band (or ratio) heights per map point on the despiked spectra. */
function mapModel() {
  const sp = active(), set = mapSet(sp);
  if (set.length < 2) return { available: false };
  const bands = S.prepared ? S.prepared.bands.map(b => ({ id: b.id, label: b.label, window: b.window })) : [];
  const m = S.map;
  if (m.num !== 'range' && !bands.some(b => b.id === m.num) && bands.length) m.num = (bands.find(b => b.id === 'G') || bands[0]).id;
  const win = (sel, lo, hi) => {
    if (sel === 'range') return Number.isFinite(lo) && Number.isFinite(hi) && lo !== hi ? { lo, hi } : null;
    const b = bands.find(q => q.id === sel);
    return b ? { lo: b.window[0], hi: b.window[1] } : null;
  };
  const name = (sel, lo, hi) => (sel === 'range' ? `${fmtX(Math.min(lo, hi))}–${fmtX(Math.max(lo, hi))} cm⁻¹` : (bands.find(b => b.id === sel) || {}).label || sel);
  const data = set.map(o => { const q = processedFor(o); return q ? { x: q.x, y: q.despiked } : { x: o.x, y: o.y }; });
  const nw = win(m.num, m.numLo, m.numHi), dw = m.den ? win(m.den) : null;
  const values = nw ? mapValues(data, nw, dw) : new Float64Array(set.length).fill(NaN);
  const label = nw ? name(m.num, m.numLo, m.numHi) + (dw ? ' / ' + name(m.den) : '') : 'choose a band';
  let cmp = null;
  const cw = m.cmp ? win(m.cmp, m.cmpLo, m.cmpHi) : null;
  if (cw && nw) {
    const cv = mapValues(data, cw);
    cmp = { values: cv, label: name(m.cmp, m.cmpLo, m.cmpHi), ...correlation(values, cv) };
  }
  const points = set.map(o => ({ id: o.id, index: o.meta.map.index, x: o.meta.map.x, y: o.meta.map.y }));
  return {
    available: true, lay: layout(points), points, values, cmp, label, unit: set[0].meta.map.unit || '',
    dark: document.documentElement.dataset.theme !== 'light', activeId: sp.id, bands, sel: m, den: !!dw,
    ranges: { num: { show: m.num === 'range', lo: m.numLo, hi: m.numHi }, cmp: { show: m.cmp === 'range', lo: m.cmpLo, hi: m.cmpHi } },
    setDespike: S.settings.despike.on && S.settings.despike.useSet && set.length >= 5,
  };
}

function renderAll() {
  const sp = active(), P = S.processed;
  const has = !!(sp && P);
  $('#dropzone').hidden = has;
  $('#chain').hidden = !has;
  $('#deck').hidden = !has;
  $('#viewModes').hidden = !has;
  $('#readout').hidden = !has;
  $('#minimapHost').hidden = !has;
  $('#spectrumSwitch').hidden = !S.spectra.length;
  $('#stackModes').hidden = S.spectra.length < 2;
  if (has) {
    plot.setScene(buildScene());
    plot.setSelected(S.selectedId);
    minimap.setData(P.x, P.y);
    minimap.setView(plot.view);
  } else {
    plot.scene = null; plot.requestRender();
  }
  // spectrum chip
  if (sp) {
    $('#spectrumName').textContent = sp.name;
    $('#spectrumCount').textContent = S.spectra.length > 1 ? `${S.spectra.findIndex(s => s.id === sp.id) + 1}/${S.spectra.length}` : '';
  }
  // chain
  const lib = S.library;
  chain.update({
    settings: S.settings, detect: S.detect, toleranceCm: tol(),
    libraries: S.libraries, libraryId: lib?.id, libraryShort: lib ? (lib.id === 'graphene-go' ? 'graphene/GO atlas' : lib.name) : '—',
    refText: refText(),
    stats: P ? { points: P.x.length, x0: P.x[0], x1: P.x[P.x.length - 1], source: sp?.source?.format, spikes: (P.spikes || []).length, suspects: (P.suspects || []).length, peaks: S.peaks.length } : {},
    despikeInfo: P ? P.despikeInfo : null, setSize: sp ? companionsFor(sp).length : 0,
    canDeconvolve: has && !!S.prepared,
    deconvText: S.deconv ? `${S.deconv.components.filter(c => c.significant).length} bands · q ${S.deconv.windows.map(w => isFinite(w.stats?.quality) ? w.stats.quality.toFixed(2) : '—').join(' / ')}` : 'nine-band fit · F',
  });
  // segmented controls
  for (const b of $$('[data-display]')) b.setAttribute('aria-checked', String(b.dataset.display === S.display));
  for (const b of $$('[data-stack]')) b.setAttribute('aria-checked', String(b.dataset.stack === S.stack));
  renderDeck();
  renderCaption();
}

function renderDeck() {
  if (S.tab === 'map' && mapSet(active()).length < 2) S.tab = 'peaks';
  const vm = viewModel();
  for (const t of $$('.deck-tabs [data-tab]')) {
    t.setAttribute('aria-selected', String(t.dataset.tab === S.tab));
    if (t.dataset.tab === 'peaks') t.innerHTML = `Peaks${S.peaks.length ? `<span class="badge">${S.peaks.length}</span>` : ''}`;
    if (t.dataset.tab === 'map') t.hidden = mapSet(active()).length < 2;
    if (t.dataset.tab === 'data') {
      const d = vm.data, warn = d ? d.flags.filter(f => f.level === 'warn').length + d.suspects.length : 0;
      t.innerHTML = `Data${warn ? `<span class="badge warn" title="quality warnings and features to check">${warn}</span>` : ''}`;
    }
  }
  for (const p of $$('.pane')) p.hidden = p.dataset.pane !== S.tab;
  const target = { peaks: '#panePeaks', ratios: '#paneRatios', read: '#paneRead', fit: '#paneFit', band: '#paneBand', data: '#paneData', map: '#paneMap' }[S.tab];
  const fn = { peaks: panes.renderPeaks, ratios: panes.renderRatios, read: panes.renderRead, fit: panes.renderFit, band: panes.renderBand, data: panes.renderData, map: panes.renderMap }[S.tab];
  try { fn($(target), vm); } catch (err) { $(target).innerHTML = `<div class="empty">Could not render this panel: ${esc(err.message)}</div>`; }
}

function renderCaption() {
  const cap = $('#caption');
  const on = document.documentElement.classList.contains('present');
  const it = S.items.find(i => i.id === S.selectedId);
  cap.hidden = !(on && it);
  if (on && it) cap.innerHTML = panes.captionHTML(it, viewModel());
}

// ------------------------------------------------------------------ selection
function select(id, { openBand = false } = {}) {
  S.selectedId = id;
  if (id && openBand) S.tab = 'band';
  plot.setSelected(id);
  plot.setScene(buildScene());
  renderDeck();
  renderCaption();
  if (id && openBand && window.matchMedia('(max-width: 1100px)').matches && !document.documentElement.classList.contains('present')) {
    $('#deck').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
function cycle(dir) {
  const list = (S.labelsOn ? labeledItems() : S.items).slice().sort((a, b) => a.x - b.x);
  if (!list.length) return;
  const i = list.findIndex(x => x.id === S.selectedId);
  const next = list[(i + dir + list.length) % list.length] || list[0];
  select(next.id, { openBand: S.tab === 'band' || document.documentElement.classList.contains('present') });
  const v = plot.view;
  if (v && (next.x < v.x0 || next.x > v.x1)) { const half = (v.x1 - v.x0) / 2; plot.setView(next.x - half, next.x + half); }
}

function deleteSelected() {
  const it = S.items.find(i => i.id === S.selectedId);
  if (!it) return toast('Select a peak first');
  if (it.tier === 'fit') return toast('Fit components come from the model. Clear or re-run the fit instead');
  pushHistory();
  if (it.tier === 'manual') S.manual = S.manual.filter(m => m.id !== it.id);
  else S.hidden.push(it.x);
  S.selectedId = null;
  recompute('peaks');
  toast(`Removed ${it.sym} at ${fmtX(it.x)} cm⁻¹ · Ctrl Z to undo`);
}

function addManualPeak(x) {
  const P = S.processed;
  if (!P) return;
  pushHistory();
  // snap to the local maximum within ±4 cm⁻¹ so a sloppy double-click lands on the apex
  let best = x, by = -Infinity;
  for (let i = 0; i < P.x.length; i++) if (Math.abs(P.x[i] - x) <= 4 && P.y[i] > by) { by = P.y[i]; best = P.x[i]; }
  const id = 'm:' + manualSeq++;
  S.manual.push({ id, x: best });
  S.selectedId = id;
  recompute('peaks');
}

function nudgeSelected(dx) {
  const it = S.items.find(i => i.id === S.selectedId);
  if (!it || it.tier === 'fit') return false;
  pushHistory();
  if (it.tier === 'manual') {
    const m = S.manual.find(q => q.id === it.id); if (m) m.x += dx;
  } else {
    S.hidden.push(it.x);
    const id = 'm:' + manualSeq++;
    S.manual.push({ id, x: it.x + dx });
    S.selectedId = id;
  }
  recompute('peaks');
  return true;
}

// ------------------------------------------------------------------ spike edits
/** keep / unkeep an automatic removal, zap a range by hand, or undo a zap. */
function spikeAction(act, d) {
  const P = S.processed;
  if (!P) return;
  const ed = S.spikeEdits;
  const lo = Math.min(+d.lo, +d.hi), hi = Math.max(+d.lo, +d.hi);
  if (!isFinite(lo) || !isFinite(hi)) return;
  if (act === 'zap' && !P.x.some(v => v >= lo && v <= hi)) return toast('No data points in that range', { warn: true });
  pushHistory();
  if (act === 'keep') ed.keep.push((lo + hi) / 2);
  else if (act === 'unkeep') ed.keep = ed.keep.filter(k => !(k >= lo - 1e-9 && k <= hi + 1e-9));
  else if (act === 'zap') ed.zaps.push([lo, hi]);
  else if (act === 'unzap') ed.zaps = ed.zaps.filter(z => !(Math.abs(z[0] - lo) < 1e-9 && Math.abs(z[1] - hi) < 1e-9));
  else return;
  S.deconv = null;
  recompute('process');
  const what = { keep: 'Kept', unkeep: 'Removed again', zap: 'Zapped', unzap: 'Zap undone' }[act];
  toast(`${what} ${fmtX(lo)}–${fmtX(hi)} cm⁻¹ · Ctrl Z to undo`);
}

// ------------------------------------------------------------------ deconvolution
async function runDeconvolution() {
  if (!S.processed || !S.prepared) return;
  busy(true, 'Fitting the nine-band model…');
  await nextFrame();
  try {
    const t0 = performance.now();
    S.deconv = deconvolve(S.processed.x, S.processed.y, S.prepared.bands, { fitDefaults: S.library.fitDefaults });
    analyse();
    const q = S.deconv.windows.map(w => isFinite(w.stats?.quality) ? w.stats.quality.toFixed(2) : '—').join(' / ');
    toast(`Deconvolved ${S.deconv.components.filter(c => c.significant).length} bands · quality ${q}× noise · ${Math.round(performance.now() - t0)} ms`);
    S.tab = S.tab === 'band' ? 'band' : 'fit';
    plot.revealOnNextRender();
  } catch (err) {
    toast('Deconvolution failed: ' + err.message, { warn: true, ms: 5000 });
  } finally {
    busy(false);
    renderAll();
  }
}

// ------------------------------------------------------------------ loading
async function loadFiles(files) {
  files = [...files];
  if (!files.length) return;
  const added = [];
  for (const f of files) {
    busy(true, `Reading ${f.name}…`);
    await nextFrame();
    try {
      const res = await importFile(f);
      for (const w of res.warnings || []) toast(w, { warn: true, ms: 4000 });
      const groups = res.sheets && res.sheets.length ? res.sheets.map(s => ({ ...s, file: f.name, format: res.format, confidence: s.mapping?.confidence ?? res.confidence }))
        : res.table ? [{ name: null, table: res.table, mapping: res.mapping, file: f.name, format: res.format, confidence: res.confidence }] : [];
      if (!groups.length) {
        added.push(...res.spectra);
        continue;
      }
      for (const g of groups) {
        let mapping = g.mapping;
        const conf = g.confidence ?? mapping?.confidence ?? 0;
        const info = { file: g.file, format: g.format, sheet: g.name || undefined };
        let spectra = [];
        if (!mapping || conf < 0.6 || mapping.x == null && mapping.layout === 'columns') {
          busy(false);
          mapping = await askMapping($('#mapDialog'), { name: g.file + (g.name ? ' · ' + g.name : ''), table: g.table, mapping, confidence: conf });
          if (!mapping) continue;
        }
        spectra = applyMapping(g.table, mapping, info);
        for (const s of spectra) { s._table = g.table; s._mapping = mapping; s._info = info; }
        added.push(...spectra);
      }
    } catch (err) {
      toast(`${f.name}: ${err.message}`, { warn: true, ms: 6000 });
    }
  }
  busy(false);
  if (!added.length) return;
  addSpectra(added);
}

function addSpectra(list) {
  S.spectra.push(...list);
  setActive(list[0].id, { reveal: true, resetView: true });
  if (list.length > 1) toast(`Loaded ${list.length} spectra · switch between them from the name chip`);
}

function setActive(id, { reveal = true, resetView = true } = {}) {
  S.activeId = id;
  S.manual = []; S.hidden = []; S.overrides = {}; S.spikeEdits = { keep: [], zaps: [] }; S.selectedId = null; S.deconv = null;
  undoStack.length = 0; redoStack.length = 0;
  const sp = active();
  if (sp && sp.meta && isFinite(sp.meta.laserNm)) {
    const near = [532, 633, 785].find(nm => Math.abs(nm - sp.meta.laserNm) < 6);
    if (near && near !== S.laserNm) { setLaser(near, { silent: true }); toast(`Laser set to ${near} nm from the file header`); }
  }
  recompute('process', { reveal, keepCache: true });
  if (resetView) { plot.resetView(); minimap.setView(plot.view); }
}

function loadSample(kind) {
  if (!S.library) return toast('Band library not loaded yet', { warn: true });
  try {
    // ratio 2.5: inside the atlas monolayer range, clear of the ≥ 2 threshold (see synth.js)
    // GO demo: atlas positions and widths; heights follow the atlas's GO description
    // (step 3 + ratio card 5) rather than its illustrative schematic, which by card 5
    // reads as a more graphitic sample. See meta.description.
    const GO_HEIGHTS = { D: 0.9, G: 0.85, Dp: 0.3, Dstar: 0.18, Dpp: 0.26, twoD: 0.12, DDp: 0.17, DDpp: 0.05, twoDp: 0.05 };
    const sp = kind === 'mono' ? synthMonolayer(S.library, { seed: 11, ratio: 2.5 }) : synthFromLibrary(S.library, { seed: 7, relHeights: GO_HEIGHTS });
    addSpectra([sp]);
  } catch (err) { toast('Could not build the sample: ' + err.message, { warn: true }); }
}

// ------------------------------------------------------------------ laser / theme / presentation
function setLaser(nm, { silent = false } = {}) {
  nm = +nm;
  if (![532, 633, 785].includes(nm)) return;
  S.laserNm = nm;
  document.documentElement.dataset.laser = String(nm);
  for (const k of $$('.laser-key')) k.setAttribute('aria-checked', String(+k.dataset.nm === nm));
  store.set('rs.laser', nm);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = document.documentElement.dataset.theme === 'light' ? '#efeae0' : '#07090c';
  if (!silent) {
    pushHistory();
    const hadFit = !!S.deconv;
    recompute('match', { reveal: true });
    if (hadFit) toast(`Band windows shifted for ${nm} nm: fit cleared, press F to re-fit`);
  }
}
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set('rs.theme', t);
  plot && plot.requestRender();
  minimap && minimap.render();
  if (S.tab === 'map' && S.processed) renderDeck();   // the colour ramp flips with the theme
}
async function togglePresent(force) {
  const root = document.documentElement;
  const on = force != null ? force : !root.classList.contains('present');
  root.classList.toggle('present', on);
  $('#bPresent').setAttribute('aria-pressed', String(on));
  try {
    if (on && !document.fullscreenElement && root.requestFullscreen) await root.requestFullscreen();
    if (!on && document.fullscreenElement) await document.exitFullscreen();
  } catch { /* fullscreen refused: presentation styling still applies */ }
  if (on && !S.selectedId) { const first = labeledItems().sort((a, b) => a.x - b.x)[0]; if (first) S.selectedId = first.id; }
  plot.requestRender();
  renderCaption();
}

// ------------------------------------------------------------------ export
function exportLegend() {
  const L = [{ text: 'spectrum (processed)', color: '--laser' }, { text: 'atlas match (detected)', color: '--laser', box: true }];
  if (S.deconv) { L.push({ text: 'fit-resolved band', color: '--fit', box: true, dash: true }); L.push({ text: 'fit envelope', color: '--fit-env' }); }
  if (S.items.some(i => i.kind === 'unassigned')) L.push({ text: 'unassigned', color: '--unassigned', box: true });
  return L;
}
function figureCaption() {
  const sp = active();
  return `λex ${S.laserNm} nm · ${S.library ? S.library.name : ''} · ${sp ? sp.name : ''} · Raman Studio ${new Date().toISOString().slice(0, 10)}`;
}
async function doExport(kind) {
  const sp = active();
  if (!sp || !S.processed) { if (kind !== 'openproject') return toast('Load a spectrum first'); }
  const base = safeName(sp && sp.name);
  try {
    switch (kind) {
      case 'png': case 'svg': {
        busy(true, 'Rendering figure…'); await nextFrame();
        const svg = await buildFigureSVG(buildScene(), plot.view, { width: 1400, height: 780, laserNm: S.laserNm, title: sp.name, caption: figureCaption(), legend: exportLegend() });
        if (kind === 'svg') download(new Blob([svg], { type: 'image/svg+xml' }), base + '_raman.svg');
        else download(await svgToPng(svg, 3), base + '_raman.png');
        break;
      }
      case 'peaks': download(new Blob([peakTableCSV(csvRows())], { type: 'text/csv' }), base + '_peaks.csv'); break;
      case 'fit':
        if (!S.deconv) return toast('Run Deconvolve (F) first');
        download(new Blob([fitParamsCSV(S.deconv.components.map(c => ({ ...c, label: (S.library.bands.find(b => b.id === c.bandId) || {}).label || c.label })), S.deconv.windows)], { type: 'text/csv' }), base + '_fit.csv');
        break;
      case 'spectrum': download(new Blob([spectrumCSV(S.processed)], { type: 'text/csv' }), base + '_processed.csv'); break;
      case 'report': await printReport(); break;
      case 'project': saveProject(); break;
      case 'openproject': $('#projectInput').click(); break;
    }
  } catch (err) {
    toast('Export failed: ' + err.message, { warn: true, ms: 5000 });
  } finally { busy(false); }
}
function exportMapCSV() {
  const mm = mapModel();
  if (!mm.available) return;
  const head = ['point', `x_${mm.unit || 'um'}`, `y_${mm.unit || 'um'}`, mm.label].concat(mm.cmp ? [mm.cmp.label] : []);
  const rows = mm.points.map((p, k) => [p.index + 1, p.x, p.y, mm.values[k]].concat(mm.cmp ? [mm.cmp.values[k]] : []));
  download(new Blob([toCSV(head, rows)], { type: 'text/csv' }), safeName(active().source.file || 'map') + '_map.csv');
}
function csvRows() {
  return S.items.map(it => ({
    label: it.sym, kind: it.kind, tier: it.tier, x: it.x, height: it.height, fwhm: it.fwhm, prominence: it.prominence,
    area: it.area, matchScore: it.tier === 'fit' ? null : it.confidence, delta: it.delta, bandId: it.bandId,
    bandName: it.band ? plainText(it.band.name) : it.kind === 'region' ? it.region?.name : '',
  }));
}
function settingsText() {
  const s = S.settings;
  return [
    s.despike.on ? despikeText() : 'no despike',
    s.baseline.on ? (s.baseline.method === 'als' ? `ALS baseline λ=${fmt(s.baseline.lambda, 2)} p=${s.baseline.p}` : `${s.baseline.method} baseline`) : 'no baseline',
    s.smooth.on ? `SG ${s.smooth.window}/${s.smooth.order}` : 'no smoothing',
    s.normalize.on ? `normalized (${s.normalize.mode})` : 'not normalized',
    `detection sensitivity ${Math.round(S.detect.sensitivity * 100)}%`, `match tolerance ±${tol()} cm⁻¹`,
  ].join(', ');
}
function despikeText() {
  const s = S.settings.despike, P = S.processed, info = P && P.despikeInfo;
  const parts = [`despike (removed only where no band ≥ ${info ? fmt(info.minBandCm, 3) : '—'} cm⁻¹ wide${s.minBandCm ? '' : ' [auto]'} fits; candidates z>${s.threshold}, ≤ ${s.maxWidth} pts${info && info.companions ? `; compared with ${info.companions} spectra of the file` : ''})`];
  if (P && P.spikes) {
    const by = k => P.spikes.filter(e => e.kind === k);
    const list = a => a.map(e => Math.round(e.xStart) === Math.round(e.xEnd) ? `${Math.round(e.xStart)}` : `${Math.round(e.xStart)}–${Math.round(e.xEnd)}`).join(', ');
    const c = by('cosmic'), a = by('artifact'), m = by('manual');
    parts.push(`${c.length} cosmic ray${c.length === 1 ? '' : 's'} removed${c.length ? ` at ${list(c)} cm⁻¹` : ''}`);
    if (a.length) parts.push(`${a.length} detector artifact${a.length === 1 ? '' : 's'} masked at ${list(a)} cm⁻¹`);
    if (m.length) parts.push(`zapped by hand: ${list(m)} cm⁻¹`);
    const kept = (P.restored || []).filter(e => e.kind === 'kept');
    if (kept.length) parts.push(`kept by hand: ${list(kept)} cm⁻¹`);
  }
  return parts.join('; ');
}
/** Acquisition settings and quality warnings, one line each, for the report. */
function acqSummary() {
  const d = dataModel();
  if (!d) return {};
  const acqText = d.acq.fields.map(f => `${f.label.toLowerCase()} ${f.value}`).join(', ');
  const qualityText = d.flags.map(f => f.text).join(' ');
  return { acqText, qualityText };
}
async function printReport() {
  const sp = active();
  busy(true, 'Preparing report…'); await nextFrame();
  const prevDisplay = S.display;
  S.display = 'processed';
  const svg = await buildFigureSVG(buildScene(), plot.view, { width: 1100, height: 470, laserNm: S.laserNm, legend: exportLegend() });
  S.display = prevDisplay;
  fillReport($('#report'), {
    svg, spectrumName: sp.name, laserNm: S.laserNm, refText: refText(), library: S.library,
    items: S.items.slice().sort((a, b) => a.x - b.x), ratios: S.ratios, workflow: S.workflow, deconv: S.deconv,
    settingsText: settingsText(), dateText: new Date().toLocaleString(), ...acqSummary(),
  });
  busy(false);
  await nextFrame();
  window.print();
}
function saveProject() {
  const sp = active();
  if (!sp) return toast('Nothing to save yet');
  const o = {
    app: 'raman-studio', version: 1, savedAt: new Date().toISOString(),
    laserNm: S.laserNm, libraryId: S.library?.id, settings: S.settings, detect: S.detect, toleranceCm: S.toleranceCm,
    display: S.display, stack: S.stack, activeIndex: S.spectra.findIndex(s => s.id === S.activeId),
    manual: S.manual, hidden: S.hidden, overrides: S.overrides, spikeEdits: S.spikeEdits, ranDeconvolution: !!S.deconv,
    spectra: S.spectra.map(s => ({ name: s.name, x: Array.from(s.x), y: Array.from(s.y), xLabel: s.xLabel, xUnit: s.xUnit, yLabel: s.yLabel, source: s.source, meta: s.meta })),
  };
  download(new Blob([JSON.stringify(o)], { type: 'application/json' }), safeName(sp.name) + '.raman-studio.json');
}
async function openProject(file) {
  try {
    const o = JSON.parse(await file.text());
    if (o.app !== 'raman-studio') throw new Error('not a Raman Studio project');
    const spectra = o.spectra.map((s, i) => ({ ...s, id: 'proj' + Date.now().toString(36) + i, x: Float64Array.from(s.x), y: Float64Array.from(s.y) }));
    S.spectra = spectra;
    S.settings = Object.assign(clone(DEFAULT_SETTINGS), o.settings || {});
    S.detect = Object.assign({ ...DEFAULT_DETECT }, o.detect || {});
    S.toleranceCm = o.toleranceCm ?? null;
    S.display = o.display || 'processed'; S.stack = o.stack || 'single';
    if (o.libraryId) S.library = S.libraries.find(l => l.id === o.libraryId) || S.library;
    setLaser(o.laserNm || 532, { silent: true });
    setActive(spectra[Math.max(0, o.activeIndex || 0)].id, { reveal: true });
    S.manual = o.manual || []; S.hidden = o.hidden || []; S.overrides = o.overrides || {};
    S.spikeEdits = o.spikeEdits || { keep: [], zaps: [] };
    manualSeq = 1 + S.manual.reduce((m, q) => Math.max(m, +String(q.id).split(':')[1] || 0), 0);
    recompute('peaks');
    if (o.ranDeconvolution) await runDeconvolution();
    toast('Project loaded');
  } catch (err) { toast('Could not open project: ' + err.message, { warn: true }); }
}

// ------------------------------------------------------------------ settings from the chain
function setByPath(path, value) {
  const [head, key] = path.split('.');
  if (head === 'detect') { S.detect[key] = value; return 'detect'; }
  if (head === 'match') { S.toleranceCm = value; return 'match'; }
  if (head === 'libraryId') { S.library = S.libraries.find(l => l.id === value) || S.library; return 'match'; }
  if (S.settings[head]) {
    S.settings[head][key] = value;
    if (head === 'smooth' && key === 'window' && value % 2 === 0) S.settings.smooth.window = value + 1;
    return 'process';
  }
  return null;
}
let liveRaf = 0, liveLevel = null;
function scheduleRecompute(level) {
  const rank = { process: 3, match: 2, detect: 1 };
  if (!liveLevel || rank[level] > rank[liveLevel]) liveLevel = level;
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => { const l = liveLevel; liveRaf = 0; liveLevel = null; recompute(l); });
}

// ------------------------------------------------------------------ wiring
function wire() {
  plot = new Plot($('#plotHost'), {
    onHover: h => {
      if (!h) { $('#roX').textContent = '—'; $('#roY').textContent = '—'; $('#roBand').textContent = ''; return; }
      $('#roX').textContent = fmtX(h.x);
      $('#roY').textContent = isFinite(h.y) ? fmt(h.y, 5) : '—';
      let best = null;
      if (S.prepared) for (const b of S.prepared.bands) { const c = bandConfidence(h.x, b); if (c > 0 && (!best || c > best.c)) best = { b, c }; }
      const reg = S.prepared && (S.prepared.regions || []).find(r => h.x >= r.range[0] && h.x <= r.range[1]);
      $('#roBand').textContent = best ? `in ${best.b.label} window` : reg ? `${reg.label} region` : '';
    },
    onLabel: id => select(id, { openBand: true }),
    onLabelHover: id => {
      S.hoverId = id;
      // re-rendering mid-reveal would cut the scan animation short
      if (plot.scene && !plot.reveal) plot.setScene(buildScene());
    },
    onDblClick: x => addManualPeak(x),
    onBackground: () => { if (S.selectedId) select(null); },
    onView: v => minimap.setView(v),
  });
  minimap = new Minimap($('#minimapHost'), { onView: (a, b) => plot.setView(a, b) });
  chain = new Chain($('#chain'), {
    onToggle: (step, on) => { pushHistory(); S.settings[step].on = on; recompute('process'); },
    onSetting: (path, value, commit) => {
      if (!commit && !pendingSnap) pendingSnap = snapshot();
      if (commit) { pushHistory(pendingSnap || snapshot()); pendingSnap = null; }
      const level = setByPath(path, value);
      if (level) scheduleRecompute(level);
    },
    onDeconvolve: () => runDeconvolution(),
  });

  // laser keys
  for (const k of $$('.laser-key')) k.addEventListener('click', () => setLaser(+k.dataset.nm));
  // tools
  $('#bOpen').onclick = () => $('#fileInput').click();
  $('#dzOpen').onclick = () => $('#fileInput').click();
  $('#dzSampleGO').onclick = () => loadSample('go');
  $('#dzSampleMono').onclick = () => loadSample('mono');
  $('#fileInput').onchange = e => { loadFiles(e.target.files); e.target.value = ''; };
  $('#projectInput').onchange = e => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };
  $('#bTheme').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  $('#bPresent').onclick = () => togglePresent();
  $('#bHelp').onclick = () => showHelp($('#helpDialog'));
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.documentElement.classList.contains('present')) togglePresent(false); });

  // export menu
  const exportBtn = $('#bExport'), exportMenu = $('#exportMenu');
  exportBtn.onclick = () => {
    if (!exportMenu.hidden) return;
    exportMenu.hidden = false; exportBtn.setAttribute('aria-expanded', 'true');
    dismissable(exportMenu, () => { exportMenu.hidden = true; exportBtn.setAttribute('aria-expanded', 'false'); }, [exportBtn]);
  };
  exportMenu.addEventListener('click', e => {
    const b = e.target.closest('[data-export]'); if (!b) return;
    exportMenu.hidden = true; exportBtn.setAttribute('aria-expanded', 'false');
    doExport(b.dataset.export);
  });

  // spectrum switcher
  const chip = $('#spectrumChip'), menu = $('#spectrumMenu');
  chip.onclick = () => {
    if (!menu.hidden) return;
    menu.innerHTML = S.spectra.map(s => `<button role="option" data-sp="${esc(s.id)}" aria-selected="${s.id === S.activeId}"><span>${esc(s.name)}</span><span class="sub">${s.x.length} pts</span></button>`).join('') +
      '<hr>' + (active()?._table ? '<button data-act="remap">Remap columns…</button>' : '') +
      '<button data-act="add">Add file…</button>' + (S.spectra.length > 1 ? '<button data-act="remove">Remove this spectrum</button>' : '') +
      '<button data-act="clear">Close all</button>';
    menu.hidden = false; chip.setAttribute('aria-expanded', 'true');
    dismissable(menu, () => { menu.hidden = true; chip.setAttribute('aria-expanded', 'false'); }, [chip]);
  };
  menu.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    menu.hidden = true; chip.setAttribute('aria-expanded', 'false');
    if (b.dataset.sp) { if (b.dataset.sp !== S.activeId) setActive(b.dataset.sp, { reveal: true }); return; }
    const sp = active();
    if (b.dataset.act === 'add') $('#fileInput').click();
    if (b.dataset.act === 'remove' && sp) { S.spectra = S.spectra.filter(s => s.id !== sp.id); setActive(S.spectra[0].id); }
    if (b.dataset.act === 'clear') { S.spectra = []; S.activeId = null; S.processed = null; S.items = []; S.peaks = []; S.deconv = null; renderAll(); }
    if (b.dataset.act === 'remap' && sp && sp._table) {
      const mapping = await askMapping($('#mapDialog'), { name: sp.source?.file || sp.name, table: sp._table, mapping: sp._mapping, confidence: sp._mapping?.confidence });
      if (!mapping) return;
      const fresh = applyMapping(sp._table, mapping, sp._info);
      for (const s of fresh) { s._table = sp._table; s._mapping = mapping; s._info = sp._info; }
      S.spectra = S.spectra.filter(s => s._table !== sp._table);
      addSpectra(fresh);
    }
  });

  // view modes
  for (const b of $$('[data-display]')) b.onclick = () => { S.display = b.dataset.display; renderAll(); };
  for (const b of $$('[data-stack]')) b.onclick = () => { S.stack = b.dataset.stack; renderAll(); };

  // deck
  for (const t of $$('.deck-tabs [data-tab]')) t.onclick = async () => {
    S.tab = t.dataset.tab;
    if (S.tab === 'map') {
      // the first map needs every spectrum of it processed (despiked): show that it is working
      const todo = mapSet(active()).filter(o => o.id !== S.activeId && !S.procCache.has(o.id));
      if (todo.length > 8) { busy(true, `Processing ${todo.length + 1} map spectra…`); await nextFrame(); }
      try { for (const o of todo) processedFor(o); } finally { busy(false); }
    }
    renderDeck();
  };
  $('#deck').addEventListener('click', e => {
    const sk = e.target.closest('[data-spike]');
    if (sk) { e.stopPropagation(); spikeAction(sk.dataset.spike, sk.dataset); return; }
    const del = e.target.closest('[data-delete]');
    if (del) { e.stopPropagation(); S.selectedId = del.dataset.delete; deleteSelected(); return; }
    const re = e.target.closest('[data-reassign]');
    if (re) {
      pushHistory();
      if (re.dataset.band) S.overrides[re.dataset.reassign] = re.dataset.band; else delete S.overrides[re.dataset.reassign];
      recompute('peaks'); return;
    }
    const cell = e.target.closest('[data-mapcell]');
    if (cell) { if (cell.dataset.mapcell !== S.activeId) setActive(cell.dataset.mapcell, { reveal: false, resetView: false }); return; }
    const act = e.target.closest('[data-action]');
    if (act) {
      if (act.dataset.action === 'deconvolve') runDeconvolution();
      if (act.dataset.action === 'clearfit') { S.deconv = null; analyse(); renderAll(); }
      if (act.dataset.action === 'mapcsv') exportMapCSV();
      return;
    }
    const sel = e.target.closest('[data-select]');
    if (sel && !e.target.closest('a')) {
      const id = sel.dataset.select;
      select(S.selectedId === id && S.tab !== 'band' ? null : id, { openBand: false });
    }
  });
  $('#deck').addEventListener('submit', e => {
    const f = e.target.closest('[data-zapform]'); if (!f) return;
    e.preventDefault();
    const lo = parseFloat(f.elements.lo.value), hi = parseFloat(f.elements.hi.value);
    if (!isFinite(lo) || !isFinite(hi)) return toast('Enter both ends of the range in cm⁻¹', { warn: true });
    spikeAction('zap', { lo, hi });
  });
  $('#deck').addEventListener('dblclick', e => { const sel = e.target.closest('[data-select]'); if (sel) select(sel.dataset.select, { openBand: true }); });
  $('#deck').addEventListener('change', e => {
    const ms = e.target.closest('[data-mapsel]');
    if (ms) {
      const key = ms.dataset.mapsel;
      S.map[key] = ms.value;
      // a new custom range starts from the part of the spectrum on screen
      if (ms.value === 'range' && !Number.isFinite(S.map[key + 'Lo']) && plot.view) { S.map[key + 'Lo'] = +plot.view.x0.toFixed(1); S.map[key + 'Hi'] = +plot.view.x1.toFixed(1); }
      renderDeck(); return;
    }
    const mr = e.target.closest('[data-maprange]');
    if (mr) {
      const key = mr.dataset.maprange.replace(/lo$/, 'Lo').replace(/hi$/, 'Hi');
      S.map[key] = parseFloat(mr.value);
      renderDeck(); return;
    }
    const o = e.target.closest('[data-opt]'); if (!o) return;
    S[o.dataset.opt] = o.checked; renderAll();
  });
  $('#deck').addEventListener('pointerover', e => {
    const c = e.target.closest('[data-tip]'), ro = $('#mapReadout');
    if (c && ro) ro.textContent = c.dataset.tip;
  });

  // drag & drop anywhere
  let depth = 0;
  const veil = $('#dropVeil');
  window.addEventListener('dragenter', e => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; e.preventDefault(); depth++; veil.hidden = false; });
  window.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) veil.hidden = true; });
  window.addEventListener('drop', e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); depth = 0; veil.hidden = true;
    const files = [...e.dataTransfer.files];
    const proj = files.find(f => /\.raman-studio\.json$/i.test(f.name));
    if (proj) openProject(proj); else loadFiles(files);
  });

  // keyboard
  const typing = el => !!(el && typeof el.matches === 'function' && el.matches('input:not([type=range]):not([type=checkbox]), select, textarea, [contenteditable]'));
  document.addEventListener('keydown', e => {
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); return redo(); }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); return saveProject(); }
    if (mod || e.altKey || typing(e.target)) return;
    const present = document.documentElement.classList.contains('present');
    const has = !!S.processed;
    switch (e.key) {
      case 'o': case 'O': $('#fileInput').click(); break;
      case '1': setLaser(532); break;
      case '2': setLaser(633); break;
      case '3': setLaser(785); break;
      case 'd': case 'D': if (has) { recompute('detect', { reveal: true }); } break;
      case 'f': case 'F': if (has) runDeconvolution(); break;
      case 'b': case 'B': if (has) { S.display = S.display === 'raw' ? 'processed' : 'raw'; renderAll(); } break;
      case 'c': case 'C': if (has) { S.display = S.display === 'both' ? 'processed' : 'both'; renderAll(); } break;
      case 'r': case 'R': case '0': plot.resetView(); break;
      case '+': case '=': plot.zoomBy(0.7); break;
      case '-': case '_': plot.zoomBy(1 / 0.7); break;
      case 'p': case 'P': togglePresent(); break;
      case 't': case 'T': setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'); break;
      case '?': showHelp($('#helpDialog')); break;
      case '[': cycle(-1); break;
      case ']': cycle(1); break;
      case 'Enter': if (S.selectedId) select(S.selectedId, { openBand: true }); else return; break;
      case 'Escape':
        if (present) { togglePresent(false); break; }
        chain.close();
        if (S.selectedId) select(null);
        break;
      case 'Delete': case 'Backspace': if (has) deleteSelected(); break;
      case 'ArrowLeft': case 'ArrowRight': {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        if (present || !S.selectedId) { cycle(dir); break; }
        if (!nudgeSelected(dir * (e.shiftKey ? 10 : 1))) cycle(dir);
        break;
      }
      default: return;
    }
    e.preventDefault();
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  const theme = store.get('rs.theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  wire();
  setLaser(store.get('rs.laser') || 532, { silent: true });
  try {
    const { libraries, errors } = await loadLibraries();
    S.libraries = libraries;
    S.library = libraries.find(l => l.id === 'graphene-go') || libraries[0] || null;
    for (const e of errors || []) toast('Library problem: ' + e, { warn: true, ms: 6000 });
    if (!S.library) toast('No band library could be loaded', { warn: true, ms: 6000 });
  } catch (err) {
    toast('Could not load band libraries: ' + err.message, { warn: true, ms: 6000 });
  }
  prepare();
  renderAll();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => plot.requestRender());
  // ?sample=go|mono deep link, handy for demos and the README screenshot
  const q = new URLSearchParams(location.search);
  if (q.get('sample')) loadSample(q.get('sample') === 'mono' ? 'mono' : 'go');
}

boot();
