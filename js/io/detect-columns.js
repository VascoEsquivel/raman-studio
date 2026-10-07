/* Column detection — decide which numbers are the Raman shift axis and which
   are intensities, for any table an instrument or spreadsheet might produce.

   Evidence per candidate axis (each in 0..1, combined into a score):
     - monotonic in either direction (WiRE writes descending x), tolerating tiny
       jitter, because a wavenumber axis never doubles back;
     - roughly even spacing (CCD pixels map to nearly uniform cm⁻¹ steps);
     - values overlapping 50–4000 cm⁻¹, where Raman shifts live;
     - header words: shift / wavenumber / raman / cm-1 / #wave boost, intensity
       words count against, index / # / time words penalise.
   An integer 1..N (or 0..N−1) column is a row index: it is monotonic, even and
   mostly inside 50–4000, so without an explicit penalty it would beat the real
   axis in an "index, shift, intensity" export.

   Three layouts are considered and the most confident wins:
     columns  x in one column, one spectrum per other column (the usual export);
     rows     transposed: the first row is x, each further row a spectrum;
     long     map export (X, Y, Wave, Intensity): spectra stacked, x repeats.
   Long-map structure is checked first because a repeating axis also looks
   "almost monotonic" to the columns scorer (only a handful of resets). */

import { makeSpectrum } from './spectrum.js';

/** Mapping confidence below which the UI must show the mapping preview. */
export const CONFIDENT = 0.6;

const X_NAME = /raman|shift|wave\s*num|wavenumber|wave|cm\s*-\s*1|cm\^?\s*-\s*1|cm⁻¹|cm-¹|1\s*\/\s*cm|\brcm\b/i;
const Y_NAME = /intensit|\bcounts?\b|\bcps\b|signal|a\.\s*u\.?|\barb\b|absorb|transmit/i;
const INDEX_NAME = /^\s*(#|no\.?|n|nr\.?|idx)\s*$|\b(index|row|point|pt|pixel|channel|frame|time|scan)\b/i;

/**
 * Classify a column header by name alone.
 * @param {string} name header text, e.g. '#Wave' or 'Raman Shift (cm-1)'
 * @returns {'x'|'y'|'index'|null}
 */
export function headerKind(name) {
  const s = String(name || '').trim();
  if (!s) return null;
  if (INDEX_NAME.test(s) && !/raman|shift|wave/i.test(s)) return 'index';
  if (X_NAME.test(s)) return 'x';
  if (Y_NAME.test(s)) return 'y';
  return null;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const label = (i, h) => `column ${i + 1}${h && String(h).trim() ? ` “${String(h).trim()}”` : ''}`;
const cleanHeader = h => String(h || '').trim().replace(/^#+\s*/, '');

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function finiteValues(col) {
  const out = [];
  for (let i = 0; i < col.length; i++) if (Number.isFinite(col[i])) out.push(col[i]);
  return out;
}

/** Shape statistics for a sequence of finite numbers, in order. */
function axisStats(vals) {
  const n = vals.length;
  if (n < 2) return null;
  let pos = 0, neg = 0, zero = 0, integer = true;
  const absd = [];
  let min = vals[0], max = vals[0];
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (integer && !Number.isInteger(v)) integer = false;
    if (i === 0) continue;
    const d = v - vals[i - 1];
    if (d > 0) pos++; else if (d < 0) neg++; else zero++;
    if (d !== 0) absd.push(Math.abs(d));
  }
  const med = median(absd);
  const dir = pos >= neg ? 1 : -1;
  let viol = 0, inBand = 0, step1 = integer;
  for (let i = 1; i < n; i++) {
    const d = vals[i] - vals[i - 1];
    // Reversals smaller than 5 % of a typical step are rounding jitter, not a fold-back.
    if (d * dir < 0 && Math.abs(d) > 0.05 * med) viol++;
    else if (d * dir > 0 && Math.abs(d) >= med / 2 && Math.abs(d) <= med * 2) inBand++;
    if (step1 && d !== dir) step1 = false;
  }
  const first = dir > 0 ? vals[0] : vals[n - 1];
  return {
    n, dir, min, max, med,
    monoFrac: 1 - viol / (n - 1),
    zeroFrac: zero / (n - 1),
    uniform: inBand / (n - 1),
    integer,
    index: step1 && (first === 0 || first === 1),
  };
}

/** Score one sequence as a candidate wavenumber axis. */
function scoreAxis(vals, header, finiteFrac = 1) {
  const st = axisStats(vals);
  if (!st) return { score: 0, raw: 0, st: null, kind: headerKind(header), monoS: 0, rangeS: 0 };
  let monoS = clamp((st.monoFrac - 0.9) / 0.1, 0, 1);
  // Many repeated values are the signature of coordinate columns, not a spectral axis.
  if (st.zeroFrac > 0.05) monoS *= clamp(1 - (st.zeroFrac - 0.05) * 4, 0, 1);
  const span = st.max - st.min;
  const overlap = span > 0 ? Math.max(0, Math.min(st.max, 4000) - Math.max(st.min, 50)) / span : 0;
  const rangeS = overlap * clamp(span / 100, 0, 1);
  let s = 0.45 * monoS + 0.2 * st.uniform + 0.25 * rangeS + 0.1 * finiteFrac;
  const raw = s;
  const kind = headerKind(header);
  if (kind === 'x') s += 0.15;
  else if (kind === 'y') s -= 0.2;
  else if (kind === 'index') s -= 0.3;
  // An axis must be monotonic; nothing else can make up for a column that doubles back.
  if (monoS < 0.5) s = Math.min(s, 0.4);
  if (st.index) s *= 0.25;
  return { score: clamp(s, 0, 1), raw, st, kind, monoS, rangeS };
}

function describe(i, header, sc) {
  const st = sc.st;
  if (!st) return `${label(i, header)}: too few numbers`;
  const bits = [];
  if (st.index) bits.push(`integer ${st.dir > 0 ? st.min : st.max}…${st.dir > 0 ? st.max : st.min} row index`);
  else if (sc.monoS >= 0.99) bits.push(`monotonic (${st.dir > 0 ? 'ascending' : 'descending'})`);
  else if (sc.monoS > 0) bits.push('almost monotonic');
  else bits.push('not monotonic');
  if (!st.index && st.uniform >= 0.9) bits.push('evenly spaced');
  bits.push(`${fmt(st.min)}–${fmt(st.max)}${sc.rangeS >= 0.9 ? ' (Raman shift range)' : sc.rangeS > 0.2 ? ' (partly in Raman range)' : ''}`);
  if (sc.kind === 'x') bits.push('header names an axis');
  else if (sc.kind === 'y') bits.push('header names an intensity');
  else if (sc.kind === 'index') bits.push('header names an index');
  return `${label(i, header)}: ${bits.join(', ')}`;
}

function fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  return a !== 0 && (a >= 1e6 || a < 1e-3) ? v.toExponential(3) : String(+v.toFixed(3));
}

/** Margin factor: a lone clear winner keeps its score; a close runner-up halves trust. */
const marginFactor = margin => clamp(0.4 + 2 * margin, 0.4, 1);

/** Two columns carrying the same numbers (x,y,x,y exports) should not compete. */
function sameValues(a, b) {
  if (a.length !== b.length) return false;
  let scale = 0;
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) scale = Math.max(scale, Math.abs(a[i]));
  const tol = 1e-9 * (scale || 1);
  for (let i = 0; i < a.length; i++) {
    const fa = Number.isFinite(a[i]), fb = Number.isFinite(b[i]);
    if (fa !== fb) return false;
    if (fa && Math.abs(a[i] - b[i]) > tol) return false;
  }
  return true;
}

function isConstant(vals) {
  for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[0]) return false;
  return true;
}

function detectColumnsLayout(table) {
  const { columns, headers = [], nRows } = table;
  const nc = columns.length;
  const scored = columns.map((c, i) => {
    const vals = finiteValues(c);
    return { i, vals, sc: scoreAxis(vals, headers[i], c.length ? vals.length / c.length : 0) };
  });
  if (nc === 1) {
    return {
      x: null, ys: scored[0].vals.length >= 2 ? [0] : [], layout: 'columns', confidence: 0.3,
      reasons: ['only one numeric column: no wavenumber axis, the point index would be used as x', describe(0, headers[0], scored[0].sc)],
    };
  }
  const ranked = scored.slice().sort((a, b) => (b.sc.score - a.sc.score) || (b.sc.raw - a.sc.raw) || (a.i - b.i));
  const best = ranked[0];
  const dups = new Set(scored.filter(s => s.i !== best.i && sameValues(columns[s.i], columns[best.i])).map(s => s.i));
  const rivals = ranked.filter(s => s.i !== best.i && !dups.has(s.i));
  const second = rivals.length ? rivals[0].sc.score : 0;
  const lengthF = clamp((nRows - 2) / 8, 0, 1);
  let confidence = best.sc.score * marginFactor(best.sc.score - second) * lengthF;

  const reasons = [`x = ${describe(best.i, headers[best.i], best.sc)}`];
  const ys = [];
  for (const s of scored) {
    if (s.i === best.i) continue;
    const st = s.sc.st;
    if (dups.has(s.i)) { reasons.push(`${label(s.i, headers[s.i])} repeats the x axis; not used as intensity`); continue; }
    if (!st || s.vals.length < 2) { reasons.push(`${label(s.i, headers[s.i])} has too few numbers; skipped`); continue; }
    if (st.index) { reasons.push(`${label(s.i, headers[s.i])} looks like a row index; skipped`); continue; }
    if (isConstant(s.vals)) { reasons.push(`${label(s.i, headers[s.i])} is constant; skipped`); continue; }
    if (st.monoFrac >= 0.999 && st.uniform >= 0.9 && s.sc.rangeS > 0.5 && s.sc.score >= 0.75) {
      reasons.push(`${label(s.i, headers[s.i])} also looks like a wavenumber axis; not used as intensity`);
      continue;
    }
    ys.push(s.i);
  }
  if (ys.length) reasons.push(`intensity: ${ys.map(i => label(i, headers[i])).join(', ')}`);
  else { confidence = Math.min(confidence, 0.3); reasons.push('no intensity column found'); }
  if (rivals.length && best.sc.score - second < 0.3) {
    reasons.push(`runner-up for x: ${describe(rivals[0].i, headers[rivals[0].i], rivals[0].sc)}`);
  }
  if (lengthF < 1) reasons.push(`only ${nRows} rows: too short to judge a column-wise axis`);
  return { x: best.i, ys, layout: 'columns', confidence, reasons };
}

function detectRows(table) {
  const { columns, nRows } = table;
  const nc = columns.length;
  if (nc < 8 || nRows < 2 || nRows >= nc) return null;
  const rowVals = r => finiteValues(columns.map(c => c[r]));
  const nCand = Math.min(nRows, 3);
  const cands = [];
  for (let r = 0; r < nCand; r++) {
    const vals = rowVals(r);
    cands.push({ r, vals, sc: scoreAxis(vals, '', vals.length / nc) });
  }
  cands.sort((a, b) => (b.sc.score - a.sc.score) || (a.r - b.r));
  const best = cands[0];
  const second = cands.length > 1 ? cands[1].sc.score : 0;
  let confidence = best.sc.score * marginFactor(best.sc.score - second) * clamp((nc - 2) / 8, 0, 1);
  const ys = [];
  for (let r = 0; r < nRows; r++) {
    if (r === best.r) continue;
    const vals = r < nCand ? cands.find(c => c.r === r).vals : rowVals(r);
    if (vals.length >= 2 && !isConstant(vals)) ys.push(r);
  }
  const reasons = [`rows layout: x = row ${best.r + 1}, ${describe(best.r, '', best.sc).replace(/^column \d+: /, '')}`];
  if (ys.length) reasons.push(`${ys.length} spectr${ys.length === 1 ? 'um' : 'a'} in rows ${ys.map(r => r + 1).join(', ')}`);
  else { confidence = Math.min(confidence, 0.3); reasons.push('no intensity rows found'); }
  return { x: best.r, ys, layout: 'rows', confidence, reasons };
}

/** Indices where x jumps back by more than half its range: block boundaries in a map export. */
function resetPoints(col, dir, range) {
  const out = [];
  for (let i = 1; i < col.length; i++) {
    const d = col[i] - col[i - 1];
    if (d * dir < 0 && Math.abs(d) > 0.5 * range) out.push(i);
  }
  return out;
}

function dominantDir(col, range) {
  let pos = 0, neg = 0;
  for (let i = 1; i < col.length; i++) {
    const d = col[i] - col[i - 1];
    if (Math.abs(d) >= 0.5 * range) continue;
    if (d > 0) pos++; else if (d < 0) neg++;
  }
  return pos >= neg ? 1 : -1;
}

function detectLong(table) {
  const { columns, headers = [], nRows } = table;
  const nc = columns.length;
  if (nRows < 6 || nc < 2) return null;
  let best = null;
  for (let c = 0; c < nc; c++) {
    const col = columns[c];
    if (col.some(v => !Number.isFinite(v))) continue;   // map exports are dense
    let min = Infinity, max = -Infinity;
    for (const v of col) { if (v < min) min = v; if (v > max) max = v; }
    const range = max - min;
    if (!(range > 0)) continue;
    const dir = dominantDir(col, range);
    const resets = resetPoints(col, dir, range);
    if (!resets.length) continue;
    const starts = [0, ...resets];
    const lengths = starts.map((s, k) => (k + 1 < starts.length ? starts[k + 1] : nRows) - s);
    if (Math.min(...lengths) < 3) continue;
    // Each block must itself be a clean axis.
    let viol = 0, steps = 0;
    const absd = [];
    for (let k = 0; k < starts.length; k++) {
      for (let i = starts[k] + 1; i < starts[k] + lengths[k]; i++) absd.push(Math.abs(col[i] - col[i - 1]));
    }
    const med = median(absd.filter(d => d > 0));
    for (let k = 0; k < starts.length; k++) {
      for (let i = starts[k] + 1; i < starts[k] + lengths[k]; i++) {
        const d = col[i] - col[i - 1];
        steps++;
        if (d * dir < 0 && Math.abs(d) > 0.05 * med) viol++;
      }
    }
    if (!steps || 1 - viol / steps < 0.98) continue;
    const P = lengths[0];
    const equal = lengths.every(l => l === P);
    let repeat = false;
    if (equal) {
      let dev = 0;
      for (let i = P; i < nRows; i++) dev = Math.max(dev, Math.abs(col[i] - col[i % P]));
      repeat = dev <= 0.5 * med;
    }
    const sc = scoreAxis(Array.from(col.subarray ? col.subarray(0, P) : col.slice(0, P)), headers[c]);
    const s = sc.score * (equal ? 1 : 0.85) * (repeat ? 1 : 0.9);
    if (!best || s > best.s) best = { c, s, sc, starts, lengths, equal, repeat, P };
  }
  if (!best || best.s < 0.3) return null;

  const { c: cx, starts, lengths } = best;
  const groupBy = [], ys = [], reasons = [];
  for (let c = 0; c < nc; c++) {
    if (c === cx) continue;
    const col = columns[c];
    let constWithin = true, varies = false;
    for (let k = 0; k < starts.length && constWithin; k++) {
      const v0 = col[starts[k]];
      for (let i = starts[k] + 1; i < starts[k] + lengths[k]; i++) {
        if (!Object.is(col[i], v0)) { constWithin = false; break; }
      }
      if (k > 0 && !Object.is(v0, col[starts[0]])) varies = true;
    }
    if (constWithin) {
      if (varies) groupBy.push(c);
      continue;
    }
    const vals = finiteValues(col);
    const st = axisStats(vals);
    if (!st || st.index) continue;
    ys.push(c);
  }
  if (!ys.length) return null;
  reasons.push(`long (map) layout: ${starts.length} spectra of ${best.equal ? best.P : 'varying numbers of'} points stacked in rows`);
  reasons.push(`x = ${label(cx, headers[cx])}, which restarts every block${best.repeat ? ' with identical values' : ''}`);
  if (groupBy.length) reasons.push(`spectra identified by ${groupBy.map(g => label(g, headers[g])).join(', ')}`);
  reasons.push(`intensity: ${ys.map(i => label(i, headers[i])).join(', ')}`);
  const confidence = clamp(best.s * (groupBy.length ? 1 : 0.9), 0, 1);
  return { x: cx, ys, layout: 'long', groupBy, confidence, reasons };
}

/**
 * Decide which table columns (or rows) are the wavenumber axis and which are intensities.
 * Always returns a best guess; `confidence < CONFIDENT` means the user should confirm it.
 * For layout 'rows', `x` and `ys` are row indices rather than column indices.
 * @param {{headers:string[], columns:Float64Array[], nRows:number}} table
 * @returns {{x:number|null, ys:number[], layout:'columns'|'rows'|'long', groupBy?:number[],
 *   confidence:number, reasons:string[]}}
 */
export function detectColumns(table) {
  const columns = (table && table.columns) || [];
  const nRows = (table && table.nRows) || (columns[0] ? columns[0].length : 0);
  if (!columns.length || !nRows) {
    return { x: null, ys: [], layout: 'columns', confidence: 0, reasons: ['no numeric data'] };
  }
  const t = { ...table, columns, nRows, headers: (table && table.headers) || [] };
  const long = detectLong(t);
  // A visibly repeating axis is decisive: the columns scorer would otherwise see an
  // "almost monotonic" Wave column and stack every map spectrum into one trace.
  if (long && long.confidence >= CONFIDENT) return long;
  const cands = [detectColumnsLayout(t)];
  const rows = detectRows(t);
  if (rows) cands.push(rows);
  if (long) cands.push(long);
  cands.sort((a, b) => b.confidence - a.confidence);
  const out = cands[0];
  out.confidence = Math.round(out.confidence * 1000) / 1000;
  return out;
}

function baseMeta(table) {
  const m = (table && table.meta) || {};
  const meta = {};
  if (Number.isFinite(m.laserNm)) meta.laserNm = m.laserNm;
  if (m.header && Object.keys(m.header).length) meta.header = m.header;
  return meta;
}

function safeSpectrum(args, warnings, what) {
  try {
    return makeSpectrum(args);
  } catch (err) {
    if (warnings) warnings.push(`${what}: ${err.message}`);
    return null;
  }
}

/**
 * Turn a table plus a mapping into spectra (one per intensity column, row or map block).
 * @param {{headers:string[], columns:Float64Array[], nRows:number, meta?:object}} table
 * @param {{x:number|null, ys:number[], layout:'columns'|'rows'|'long', groupBy?:number[]}} mapping
 * @param {{file?:string, format?:string, sheet?:string, warnings?:string[]}} [info]
 *   `warnings`, when given, collects spectra that had to be skipped.
 * @returns {object[]} Spectrum[]
 */
export function tableToSpectra(table, mapping, { file = '', format = '', sheet, warnings } = {}) {
  if (!table || !mapping) return [];
  const { columns = [], headers = [] } = table;
  const nRows = table.nRows || (columns[0] ? columns[0].length : 0);
  const meta = baseMeta(table);
  const ys = (mapping.ys || []).filter(i => Number.isInteger(i));
  const src = extra => {
    const s = { file, format, ...extra };
    if (sheet !== undefined && sheet !== null && sheet !== '') s.sheet = sheet;
    return s;
  };
  const nameOf = (...parts) => [file, sheet, ...parts].filter(p => p !== undefined && p !== null && p !== '').join(' · ') || 'Spectrum';
  const out = [];

  if (mapping.layout === 'rows') {
    const nc = columns.length;
    const xr = mapping.x;
    const x = new Float64Array(nc);
    for (let j = 0; j < nc; j++) x[j] = xr === null || xr === undefined ? j : columns[j][xr];
    for (const r of ys) {
      if (r < 0 || r >= nRows) continue;
      const y = new Float64Array(nc);
      for (let j = 0; j < nc; j++) y[j] = columns[j][r];
      const sp = safeSpectrum({
        x, y, yLabel: 'Intensity', meta: { ...meta },
        name: nameOf(ys.length > 1 ? `row ${r + 1}` : null),
        source: src({ column: `row ${r + 1}` }),
      }, warnings, `row ${r + 1}`);
      if (sp) out.push(sp);
    }
    return out;
  }

  const xIdx = mapping.x;
  const xcol = xIdx === null || xIdx === undefined
    ? Float64Array.from({ length: nRows }, (_, i) => i)
    : columns[xIdx];
  if (!xcol) throw new Error(`Column ${xIdx + 1} does not exist in this table.`);

  if (mapping.layout === 'long') {
    const groupBy = (mapping.groupBy || []).filter(g => columns[g]);
    let min = Infinity, max = -Infinity;
    for (const v of xcol) if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    const range = max - min;
    const dir = dominantDir(xcol, range);
    const breaks = new Set(range > 0 ? resetPoints(xcol, dir, range) : []);
    const starts = [0];
    for (let i = 1; i < nRows; i++) {
      if (breaks.has(i) || groupBy.some(g => !Object.is(columns[g][i], columns[g][i - 1]))) starts.push(i);
    }
    starts.forEach((s, k) => {
      const e = k + 1 < starts.length ? starts[k + 1] : nRows;
      const coords = {};
      for (const g of groupBy) coords[cleanHeader(headers[g]) || `column ${g + 1}`] = columns[g][s];
      const coordText = Object.entries(coords).map(([kk, v]) => `${kk}=${fmt(v)}`).join(', ') || `spectrum ${k + 1}`;
      for (const yi of ys) {
        if (!columns[yi]) continue;
        const yl = cleanHeader(headers[yi]);
        const sp = safeSpectrum({
          x: xcol.subarray(s, e), y: columns[yi].subarray(s, e), yLabel: yl || 'Intensity',
          meta: { ...meta, coords },
          name: nameOf(coordText, ys.length > 1 ? (yl || `column ${yi + 1}`) : null),
          source: src({ column: headers[yi] && String(headers[yi]).trim() ? headers[yi] : yi }),
        }, warnings, coordText);
        if (sp) out.push(sp);
      }
    });
    return out;
  }

  for (const yi of ys) {
    if (!columns[yi]) continue;
    const yl = cleanHeader(headers[yi]);
    const sp = safeSpectrum({
      x: xcol, y: columns[yi], yLabel: yl || 'Intensity', meta: { ...meta },
      name: nameOf(ys.length > 1 ? (yl || `column ${yi + 1}`) : null),
      source: src({ column: headers[yi] && String(headers[yi]).trim() ? headers[yi] : yi }),
    }, warnings, label(yi, headers[yi]));
    if (sp) out.push(sp);
  }
  return out;
}
