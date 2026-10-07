/* JCAMP-DX 4.24 / 5.x reader.

   A JCAMP file is a list of labelled data records (LDRs), "##LABEL=value",
   grouped into blocks that start at ##TITLE and stop at ##END. Link files
   (##BLOCKS=n) nest one block per spectrum inside an outer block.

   Spectra come in two shapes:
     ##XYDATA=(X++(Y..Y))  — each line: an abscissa, then a run of ordinates,
       written as plain numbers (AFFN) or ASCII squeezed difference form (ASDF):
         SQZ  @ A–I a–i   a new value; the character replaces sign + first digit
         DIF  % J–R j–r   a difference from the previous value
         DUP  S–Z s       repeat count (including the original) of the previous
                          token — repeating a DIF repeats the difference
       In DIF form the last ordinate of a line is repeated as the first of the
       next line (the "Y check"); it must be verified and dropped, or every line
       adds a duplicate point.
     ##XYPOINTS / ##PEAK TABLE=(XY..XY) — explicit x, y pairs.
   Values are multiplied by ##XFACTOR / ##YFACTOR. The x axis is rebuilt from
   ##FIRSTX / ##LASTX / ##NPOINTS when the decoded count matches, because the
   per-line abscissae are rounded to the X factor's resolution. */

import { makeSpectrum, laserFromHeader } from './spectrum.js';

const SQZ = { '@': 0 };
const DIF = { '%': 0 };
const DUP = {};
'ABCDEFGHI'.split('').forEach((c, i) => { SQZ[c] = i + 1; SQZ[c.toLowerCase()] = -(i + 1); });
'JKLMNOPQR'.split('').forEach((c, i) => { DIF[c] = i + 1; DIF[c.toLowerCase()] = -(i + 1); });
'STUVWXYZ'.split('').forEach((c, i) => { DUP[c] = i + 1; });
DUP.s = 9;

// Any of these means the block is ASDF-compressed, so 'E'/'e' are SQZ digits, not exponents.
const ASDF_NON_E = /[@A-DF-Za-df-z%]/;

/**
 * Decode one line of AFFN / ASDF ordinates (SQZ, DIF, DUP, PAC, FIX in any mix).
 * The first value of an XYDATA line is the abscissa; this function does not
 * treat it specially.
 * @param {string} line data line without the ##LABEL part
 * @param {{exponents?:boolean}} [opts] exponents: treat E/e as an exponent marker
 *   (only safe when the block uses no ASDF characters)
 * @returns {{values:number[], endsInDif:boolean}} endsInDif: the last value came
 *   from a DIF token, so the next line starts with a Y-check value
 */
export function decodeAsdfLine(line, { exponents = false } = {}) {
  const values = [];
  let tokType = null, buf = '', affn = false;
  let lastType = null, lastDiff = 0;

  const flush = () => {
    if (tokType === null) return;
    const v = buf === '' || buf === '+' || buf === '-' ? NaN : Number(buf);
    if (tokType === 'abs') {
      values.push(v);
      lastType = 'abs';
    } else if (tokType === 'dif') {
      if (!values.length) throw new Error('JCAMP data: a DIF value has no preceding value.');
      values.push(values[values.length - 1] + v);
      lastType = 'dif';
      lastDiff = v;
    } else if (tokType === 'dup') {
      if (!values.length) throw new Error('JCAMP data: a DUP count has no preceding value.');
      for (let k = 1; k < v; k++) {
        const prev = values[values.length - 1];
        values.push(lastType === 'dif' ? prev + lastDiff : prev);
      }
    }
    tokType = null; buf = ''; affn = false;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '$' && line[i + 1] === '$') break;   // inline comment
    if ((c >= '0' && c <= '9') || c === '.') {
      if (tokType === null) { tokType = 'abs'; affn = true; buf = ''; }
      buf += c;
    } else if ((c === 'E' || c === 'e') && exponents && affn && tokType === 'abs' &&
      /^[+-]?\d/.test(line.slice(i + 1, i + 3))) {
      buf += 'e';
      if (line[i + 1] === '+' || line[i + 1] === '-') { buf += line[i + 1]; i++; }
    } else if (c === '+' || c === '-') {
      flush();
      tokType = 'abs'; affn = true; buf = c;
    } else if (c in SQZ) {
      flush();
      tokType = 'abs'; buf = String(SQZ[c]);
    } else if (c in DIF) {
      flush();
      tokType = 'dif'; buf = String(DIF[c]);
    } else if (c in DUP) {
      flush();
      tokType = 'dup'; buf = String(DUP[c]);
    } else if (c === '?') {
      flush();
      values.push(NaN); lastType = 'abs';
    } else {
      flush();   // space, comma, semicolon, tab or anything unknown separates values
    }
  }
  flush();
  return { values, endsInDif: lastType === 'dif' };
}

/** JCAMP labels compare ignoring case, spaces, dashes, slashes and underscores. */
function normLabel(s) {
  return String(s).toUpperCase().replace(/[\s\-/_]/g, '');
}

function parseLdrs(text) {
  const entries = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const m = rawLine.match(/^\s*##([^=]*)=(.*)$/);
    if (m) {
      let value = m[2];
      const ci = value.indexOf('$$');
      if (ci >= 0) value = value.slice(0, ci);
      entries.push({ label: normLabel(m[1]), raw: m[1].trim(), value: value.trim(), lines: [] });
    } else if (entries.length) {
      entries[entries.length - 1].lines.push(rawLine);
    }
  }
  return entries;
}

function buildBlocks(entries) {
  const blocks = [];
  const stack = [];
  const open = (title, parent) => {
    const b = { title, ldrs: {}, raw: {}, data: [], parent };
    blocks.push(b);
    stack.push(b);
    return b;
  };
  for (const e of entries) {
    if (e.label === 'TITLE') { open(e.value, stack[stack.length - 1] || null); continue; }
    if (e.label === 'END') { stack.pop(); continue; }
    const cur = stack[stack.length - 1] || open('', null);
    if (e.label === 'XYDATA' || e.label === 'XYPOINTS' || e.label === 'PEAKTABLE') {
      cur.data.push({ kind: e.label, vars: e.value, lines: e.lines });
    } else if (!(e.label in cur.ldrs)) {
      const v = [e.value, ...e.lines.map(l => l.trim()).filter(Boolean)].join('\n').trim();
      cur.ldrs[e.label] = v;
      cur.raw[e.raw] = v;
    }
  }
  return blocks;
}

/** Parameters are looked up in the block, then its enclosing link block. */
function param(block, label) {
  for (let b = block; b; b = b.parent) if (label in b.ldrs) return b.ldrs[label];
  return undefined;
}

function num(block, label, dflt) {
  const v = param(block, label);
  if (v === undefined || v === '') return dflt;
  const n = Number(String(v).trim().split(/[\s,;]+/)[0]);
  return Number.isFinite(n) ? n : dflt;
}

function decodeXyData(block, d, warnings, who) {
  const xf = num(block, 'XFACTOR', 1), yf = num(block, 'YFACTOR', 1);
  const firstX = num(block, 'FIRSTX', NaN), lastX = num(block, 'LASTX', NaN);
  const nPts = num(block, 'NPOINTS', NaN), deltaXp = num(block, 'DELTAX', NaN);
  const dataLines = d.lines.map(l => { const ci = l.indexOf('$$'); return (ci >= 0 ? l.slice(0, ci) : l).trim(); }).filter(Boolean);
  const exponents = !ASDF_NON_E.test(dataLines.join(''));

  const segs = [];
  let prevDif = false, prevLast = NaN, checks = 0, badChecks = 0;
  for (const line of dataLines) {
    const { values, endsInDif } = decodeAsdfLine(line, { exponents });
    if (!values.length) continue;
    const ys = values.slice(1);
    let offset = 0;
    if (prevDif && ys.length) {
      checks++;
      if (!(Math.abs(ys[0] - prevLast) <= 1e-9 * Math.max(1, Math.abs(prevLast)))) badChecks++;
      ys.shift();
      offset = 1;
    }
    if (values.length > 1) { prevDif = endsInDif; prevLast = values[values.length - 1]; }
    segs.push({ x: values[0], ys, offset });
  }
  let count = 0;
  for (const s of segs) count += s.ys.length;
  if (!count) throw new Error(`${who}: ##XYDATA block contains no values.`);
  if (badChecks) warnings.push(`${who}: ${badChecks} of ${checks} DIF Y-check values did not match; the data may be corrupt.`);

  const y = new Float64Array(count);
  const x = new Float64Array(count);
  let k = 0;
  for (const s of segs) for (const v of s.ys) y[k++] = v * yf;

  if (Number.isFinite(firstX) && Number.isFinite(lastX) && count === nPts && nPts > 1) {
    const step = (lastX - firstX) / (nPts - 1);
    for (let i = 0; i < count; i++) x[i] = firstX + i * step;
  } else {
    if (Number.isFinite(nPts) && count !== nPts) {
      warnings.push(`${who}: ##NPOINTS says ${nPts} but ${count} values were decoded; x taken from the line abscissae.`);
    }
    let dx = Number.isFinite(deltaXp) ? deltaXp
      : Number.isFinite(firstX) && Number.isFinite(lastX) && nPts > 1 ? (lastX - firstX) / (nPts - 1) : NaN;
    if (!Number.isFinite(dx)) {
      // Estimate the step from consecutive line abscissae when the header gives none.
      const s0 = segs.find((s, i) => i + 1 < segs.length && s.ys.length);
      const i0 = segs.indexOf(s0);
      dx = s0 ? (segs[i0 + 1].x - s0.x) * xf / (s0.ys.length + s0.offset - (segs[i0 + 1].offset ? 0 : 0)) : 1;
    }
    k = 0;
    for (const s of segs) for (let j = 0; j < s.ys.length; j++) x[k++] = s.x * xf + (j + s.offset) * dx;
  }
  return { x, y };
}

function decodePairs(block, d, who) {
  const xf = num(block, 'XFACTOR', 1), yf = num(block, 'YFACTOR', 1);
  const vars = (d.vars.match(/\(([A-Z]+)\.\./i) || [])[1] || 'XY';
  const group = Math.max(2, vars.length);
  const vals = [];
  for (const line of d.lines) {
    const t = line.trim();
    if (!t) continue;
    vals.push(...decodeAsdfLine(t, { exponents: true }).values);
  }
  const n = Math.floor(vals.length / group);
  if (!n) throw new Error(`${who}: ##${d.kind === 'PEAKTABLE' ? 'PEAK TABLE' : 'XYPOINTS'} contains no pairs.`);
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = vals[i * group] * xf; y[i] = vals[i * group + 1] * yf; }
  return { x, y };
}

function unitWarning(xUnits, who) {
  const u = normLabel(xUnits || '');
  if (!u || /^(1\/?CM|CM\^?1|CM\^?\-?1|WAVENUMBERS?|RAMANSHIFT|CM1)$/.test(u.replace('-', ''))) return null;
  if (/NANOMET|^NM$/.test(u)) {
    return `${who}: x axis is in nanometres; it needs the laser wavelength to be converted to Raman shift (cm⁻¹).`;
  }
  return `${who}: unexpected x units "${xUnits}"; values are shown as if they were cm⁻¹.`;
}

/**
 * Parse a JCAMP-DX file into an ImportResult (one spectrum per data block).
 * @param {string} text file contents
 * @param {{filename?:string}} [opts]
 * @returns {{format:'jcamp', spectra:object[], needsMapping:boolean, confidence:number, warnings:string[]}}
 */
export function parseJcamp(text, { filename = '' } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${filename || 'The file'} is empty.`);
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const entries = parseLdrs(s);
  if (!entries.length) throw new Error(`${filename || 'The file'} is not JCAMP-DX: no ##LABEL= records found.`);
  const blocks = buildBlocks(entries);
  const dataBlocks = blocks.filter(b => b.data.length);
  const warnings = [];
  if (!dataBlocks.length) {
    const nt = blocks.some(b => 'NTUPLES' in b.ldrs);
    throw new Error(`No ##XYDATA, ##XYPOINTS or ##PEAK TABLE found in ${filename || 'the JCAMP file'}` +
      (nt ? ' (##NTUPLES data is not supported).' : '.'));
  }
  const spectra = [];
  dataBlocks.forEach((b, k) => {
    const title = (b.title || '').trim();
    const who = dataBlocks.length > 1 ? `block ${k + 1}${title ? ` “${title}”` : ''}` : (filename || title || 'JCAMP');
    // XYDATA is the real spectrum; a peak table in the same block is a derived summary.
    const d = b.data.find(e => e.kind === 'XYDATA') || b.data.find(e => e.kind === 'XYPOINTS') || b.data[0];
    let xy;
    if (d.kind === 'XYDATA' && /\+\+/.test(d.vars)) xy = decodeXyData(b, d, warnings, who);
    else xy = decodePairs(b, d, who);
    if (d.kind === 'PEAKTABLE') warnings.push(`${who}: only a peak table is present; it is shown as a stick spectrum.`);

    const xUnits = param(b, 'XUNITS') || '';
    const uw = unitWarning(xUnits, who);
    if (uw) warnings.push(uw);
    const meta = { title, xUnits, yUnits: param(b, 'YUNITS') || '' };
    const dt = param(b, 'DATATYPE');
    if (dt) meta.dataType = dt;
    meta.header = {};
    for (let bb = b; bb; bb = bb.parent) {
      for (const [key, v] of Object.entries(bb.raw)) if (!(key in meta.header)) meta.header[key] = v;
    }
    for (const [key, v] of Object.entries(meta.header)) {
      const nm = laserFromHeader(key.replace(/^[$.]+/, ''), v);
      if (nm !== null) { meta.laserNm = nm; break; }
    }
    const name = dataBlocks.length > 1
      ? [filename, title || `block ${k + 1}`].filter(Boolean).join(' · ')
      : (filename || title || 'JCAMP spectrum');
    spectra.push(makeSpectrum({
      x: xy.x, y: xy.y, name, meta,
      yLabel: meta.yUnits || 'Intensity',
      source: { file: filename, format: 'jcamp', column: dataBlocks.length > 1 ? k : undefined },
    }));
  });
  for (const sp of spectra) if (sp.source.column === undefined) delete sp.source.column;
  return { format: 'jcamp', spectra, needsMapping: false, confidence: 1, warnings };
}
