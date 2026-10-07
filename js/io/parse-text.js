/* Delimited-text parsing — CSV, TSV, WiRE/LabSpec .txt exports and the
   endless variations labs produce by hand.

   Strategy: instead of trusting a declared format, try every plausible
   (delimiter, decimal) pair and keep the one that yields the longest run of
   all-numeric rows with a consistent column count. That single rule handles
   European files (';' + decimal comma), WiRE's tab exports, whitespace-aligned
   columns and metadata blocks of any length, because metadata lines simply fail
   to be numeric. The non-numeric line right above the winning run becomes the
   header; key=value / key: value lines anywhere outside it become metadata. */

import { headerKind } from './detect-columns.js';
import { laserFromHeader } from './spectrum.js';

const COMMENT_RE = /^\s*(?:#|;|%|!|\/\/|\*)/;
const COMMENT_STRIP = /^\s*(?:#+|;+|%+|!+|\/\/+|\*+)\s*/;
const NUM_DOT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const NUM_COMMA = /^[+-]?(?:\d+,?\d*|,\d+)(?:[eE][+-]?\d+)?$/;
const NON_FINITE = /^[+-]?(?:nan|inf|infinity)$/i;

const EMPTY = Symbol('empty');
const BAD = Symbol('bad');

// Order doubles as the tie-break priority: explicit delimiters beat whitespace,
// '.' decimals beat ',' when both read the same digits.
const COMBOS = [
  ['\t', '.'], ['\t', ','], [';', '.'], [';', ','], [',', '.'],
  ['|', '.'], ['|', ','], ['whitespace', '.'], ['whitespace', ','],
];

/**
 * Parse one field as a number under the given decimal convention.
 * @param {string} s trimmed field text
 * @param {'.'|','} [decimal]
 * @returns {number} NaN when the field is not a number
 */
export function parseNumber(s, decimal = '.') {
  const v = toNum(String(s).trim(), decimal);
  return typeof v === 'number' ? v : NaN;
}

function toNum(f, dec) {
  if (f === '') return EMPTY;
  if (dec === ',') {
    if (NUM_COMMA.test(f)) return +f.replace(',', '.');
  } else if (NUM_DOT.test(f)) return +f;
  if (NON_FINITE.test(f)) return /inf/i.test(f) ? (f[0] === '-' ? -Infinity : Infinity) : NaN;
  return BAD;
}

function unquote(f) {
  return f.length >= 2 && f[0] === '"' && f[f.length - 1] === '"' ? f.slice(1, -1).replace(/""/g, '"') : f;
}

/** RFC 4180-style split so quoted headers containing the delimiter stay whole. */
function splitQuoted(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '""'; i++; }
      else if (c === '"') { q = false; cur += c; }
      else cur += c;
    } else if (c === '"') { q = true; cur += c; }
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function splitFields(line, delim) {
  if (delim === 'whitespace') {
    const t = line.trim();
    return t ? t.split(/\s+/).map(unquote) : [];
  }
  const parts = line.includes('"') ? splitQuoted(line, delim) : line.split(delim);
  return parts.map(p => unquote(p.trim()));
}

/** { n, numeric } for one line under one combo; numeric = no text fields and ≥ 1 number. */
function classify(line, delim, dec) {
  const f = splitFields(line, delim);
  let nums = 0;
  for (let i = 0; i < f.length; i++) {
    const v = toNum(f[i], dec);
    if (v === BAD) return { n: f.length, numeric: false };
    if (v !== EMPTY) nums++;
  }
  return { n: f.length, numeric: nums > 0 };
}

/** Longest run of numeric rows with equal field counts over a list of line indices (-1 = gap). */
function longestRun(lines, idx, delim, dec) {
  let best = { count: 0, n: 0 }, cur = null;
  for (const i of idx) {
    if (i < 0) { cur = null; continue; }
    const r = classify(lines[i], delim, dec);
    if (!r.numeric) { cur = null; continue; }
    if (cur && cur.n === r.n) cur.count++; else cur = { n: r.n, count: 1 };
    if (cur.count > best.count) best = { n: cur.n, count: cur.count };
  }
  return best;
}

/** Rank combos: ≥ 2 columns first, then the longest run, then list priority. */
function better(a, b) {
  if (!b) return true;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
  return false;
}

/**
 * Split a "key = value" or "key: value" header line (comment markers allowed).
 * @param {string} line
 * @returns {[string, string]|null}
 */
export function parseMetaLine(line) {
  const t = String(line).replace(COMMENT_STRIP, '').trim();
  const m = t.match(/^([^=:\t]{1,80}?)\s*[=:]\s*(.*)$/);
  if (!m) return null;
  const key = m[1].trim(), value = m[2].trim();
  // "10:30" or "3.5=..." are values, not keys.
  if (!key || /^[+-]?[\d.,]+$/.test(key)) return null;
  return [key, value];
}

function addMeta(meta, key, value) {
  if (!key) return;
  if (!(key in meta.header)) meta.header[key] = value;
  if (meta.laserNm === undefined) {
    const nm = laserFromHeader(key, value);
    if (nm !== null) meta.laserNm = nm;
  }
}

const hasAxisName = fields => fields.some(f => { const k = headerKind(f); return k === 'x' || k === 'y'; });
const isNumericField = (f, dec) => typeof toNum(f, dec) === 'number';

/**
 * Parse delimited text into a Table. Auto-detects the delimiter (tab, comma,
 * semicolon, pipe, whitespace) and decimal comma, skips comment/blank lines and
 * metadata blocks, and takes the longest consistent run of numeric rows.
 * @param {string} text file contents (a leading BOM is ignored)
 * @param {{filename?:string}} [opts]
 * @returns {{headers:string[], columns:Float64Array[], nRows:number,
 *   meta:{delimiter:string, decimal:'.'|',', headerLines:string[], header:object, laserNm?:number,
 *   dataLines:[number, number]}, warnings:string[]}}
 */
export function parseDelimitedText(text, { filename = '' } = {}) {
  if (typeof text !== 'string') throw new Error('Expected the file contents as text.');
  const who = filename || 'The file';
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  if (!s.trim()) throw new Error(`${who} is empty.`);
  const lines = s.split(/\r\n|\r|\n/);
  const kind = new Uint8Array(lines.length);   // 0 blank, 1 comment, 2 candidate
  const cand = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    kind[i] = !t ? 0 : COMMENT_RE.test(t) ? 1 : 2;
    if (kind[i] === 2) cand.push(i);
  }
  if (!cand.length) throw new Error(`No numeric data found in ${filename || 'the text'} (only comments or blank lines).`);

  // Choose the combo on a sample: huge map exports would otherwise be scanned nine times.
  const sample = cand.length > 2500 ? [...cand.slice(0, 2000), -1, ...cand.slice(-300)] : cand;
  let pick = null;
  COMBOS.forEach(([delim, dec], pri) => {
    const r = longestRun(lines, sample, delim, dec);
    const key = [r.n >= 2 ? 1 : 0, r.count, -pri];
    if (r.count && better(key, pick && pick.key)) pick = { delim, dec, key };
  });
  if (!pick) {
    throw new Error(`No numeric data found in ${filename || 'the text'}: no line consists only of numbers.`);
  }
  const { delim, dec } = pick;

  // Full pass with the chosen combo. Blank and comment lines do not break a run, so a
  // comment inside the data (or between stacked spectra) keeps the block together.
  const runs = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (kind[i] !== 2) continue;
    const r = classify(lines[i], delim, dec);
    if (r.numeric && cur && cur.n === r.n) { cur.end = i; cur.count++; }
    else {
      if (cur) runs.push(cur);
      cur = r.numeric ? { start: i, end: i, n: r.n, count: 1 } : null;
    }
  }
  if (cur) runs.push(cur);
  let main = null;
  for (const r of runs) if (!main || r.count > main.count) main = r;
  if (!main || main.count < 2) {
    throw new Error(`No numeric data table found in ${filename || 'the text'}: fewer than two rows of numbers.`);
  }

  const n = main.n;
  const raw = Array.from({ length: n }, () => new Float64Array(main.count));
  let row = 0;
  for (let i = main.start; i <= main.end; i++) {
    if (kind[i] !== 2) continue;
    const f = splitFields(lines[i], delim);
    for (let j = 0; j < n; j++) {
      const v = toNum(f[j] ?? '', dec);
      raw[j][row] = typeof v === 'number' ? v : NaN;
    }
    row++;
  }
  // Trailing delimiters and spacer columns produce all-empty columns; they carry nothing.
  const keep = [];
  for (let j = 0; j < n; j++) if (raw[j].some(v => !Number.isNaN(v))) keep.push(j);

  const meta = { delimiter: delim, decimal: dec, headerLines: [], header: {}, dataLines: [main.start + 1, main.end + 1] };
  const allHeaders = new Array(n).fill('');
  let headerLine = -1;
  for (let j = main.start - 1, seen = 0; j >= 0 && seen < 12; j--) {
    if (kind[j] === 0) continue;
    seen++;
    const line = lines[j];
    if (/=/.test(line) || (parseMetaLine(line) && kind[j] === 1)) continue;
    const fields = headerFields(line, kind[j] === 1, delim, n, keep.length);
    if (fields && !fields.list.every(f => f === '' || isNumericField(f, dec))) {
      if (kind[j] === 1 && !hasAxisName(fields.list)) continue;
      if (fields.list.length === n) fields.list.forEach((f, k) => { allHeaders[k] = f; });
      else fields.list.forEach((f, k) => { allHeaders[keep[k]] = f; });
      headerLine = j;
      break;
    }
    if (kind[j] === 2) break;
  }

  for (let j = 0; j < main.start; j++) if (kind[j] !== 0) meta.headerLines.push(lines[j].trim());
  if (meta.headerLines.length > 200) meta.headerLines = meta.headerLines.slice(-200);
  for (let j = 0; j < lines.length; j++) {
    if (kind[j] === 0 || j === headerLine) continue;
    if (kind[j] === 2 && j >= main.start && j <= main.end) continue;
    const kv = parseMetaLine(lines[j]);
    if (kv) { addMeta(meta, kv[0], kv[1]); continue; }
    // "laser_wavelength;785" style: a two-field text/value line in the file's own delimiter.
    if (kind[j] === 2) {
      const f = splitFields(lines[j], delim).filter(x => x !== '');
      if (f.length === 2 && !isNumericField(f[0], dec) && /[a-z]/i.test(f[0])) addMeta(meta, f[0], f[1]);
    }
  }
  if (meta.laserNm === undefined) delete meta.laserNm;

  const warnings = [];
  for (const r of runs) {
    if (r === main || r.count < 3) continue;
    warnings.push(`Ignored ${r.count} other numeric rows at lines ${r.start + 1}–${r.end + 1} (a separate block).`);
  }
  const dropped = n - keep.length;
  if (dropped && keep.length) {
    // Not worth a warning when it is only trailing delimiters.
    const trailingOnly = keep.every((k, i) => k === i);
    if (!trailingOnly) warnings.push(`Dropped ${dropped} empty column${dropped > 1 ? 's' : ''}.`);
  }
  if (!keep.length) throw new Error(`No numeric data found in ${filename || 'the text'}.`);
  return {
    headers: keep.map(j => allHeaders[j]),
    columns: keep.map(j => raw[j]),
    nRows: main.count,
    meta,
    warnings,
  };
}

/** Split a candidate header line so it lines up with the data columns, or null. */
function headerFields(line, isComment, delim, n, nKept) {
  const variants = [line];
  if (isComment) variants.push(line.replace(COMMENT_STRIP, ''));
  for (const v of variants) {
    const splits = [splitFields(v, delim)];
    // Whitespace headers often contain single spaces ("Raman shift  Intensity").
    if (delim === 'whitespace') splits.push(v.trim().split(/\t+|\s{2,}/).map(unquote));
    for (const f of splits) {
      // WiRE writes "#Wave\t\t#Intensity": doubled delimiters in the header only.
      const tries = [f, f.filter(x => x !== '' && !/^(?:#+|;+|%+|!+|\/\/+|\*+)$/.test(x))];
      for (const t of tries) {
        if (t.length === n) return { list: t };
        if (t.length === nKept) return { list: t };
      }
    }
  }
  return null;
}

/**
 * Build a Table from spreadsheet-style rows (arrays of cell values: numbers,
 * strings, null). Numeric strings with decimal commas are converted. A row
 * counts as data when it has more numeric cells than text cells, so a stray
 * note beside the data does not split the block.
 * @param {Array<Array<*>>} rows e.g. SheetJS sheet_to_json(ws, { header: 1, raw: true })
 * @returns {object|null} Table, or null when the rows contain no numeric block
 */
export function tableFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  let commaCells = 0;
  const cellNum = c => {
    if (typeof c === 'number') return Number.isFinite(c) ? c : NaN;
    if (c === null || c === undefined) return EMPTY;
    if (typeof c !== 'string') return BAD;
    const t = c.trim();
    if (!t) return EMPTY;
    const d = toNum(t, '.');
    if (d !== BAD) return d;
    const k = toNum(t, ',');
    if (typeof k === 'number') { commaCells++; return k; }
    return BAD;
  };
  const kinds = rows.map(r => {
    if (!Array.isArray(r)) return 0;
    let nums = 0, texts = 0;
    for (const c of r) {
      const v = cellNum(c);
      if (v === BAD) texts++; else if (v !== EMPTY) nums++;
    }
    return !nums && !texts ? 0 : nums > texts ? 2 : 1;   // 0 empty, 1 text, 2 data
  });
  commaCells = 0;
  const runs = [];
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    if (kinds[i] === 0) continue;
    if (kinds[i] === 2) {
      if (cur) { cur.end = i; cur.count++; } else cur = { start: i, end: i, count: 1 };
    } else { if (cur) runs.push(cur); cur = null; }
  }
  if (cur) runs.push(cur);
  let main = null;
  for (const r of runs) if (!main || r.count > main.count) main = r;
  if (!main) return null;

  let width = 0;
  for (let i = main.start; i <= main.end; i++) if (kinds[i] === 2) width = Math.max(width, rows[i].length);
  const raw = Array.from({ length: width }, () => new Float64Array(main.count));
  let row = 0;
  for (let i = main.start; i <= main.end; i++) {
    if (kinds[i] !== 2) continue;
    for (let j = 0; j < width; j++) {
      const v = cellNum(rows[i][j]);
      raw[j][row] = typeof v === 'number' ? v : NaN;
    }
    row++;
  }
  const keep = [];
  for (let j = 0; j < width; j++) if (raw[j].some(v => !Number.isNaN(v))) keep.push(j);
  if (!keep.length) return null;

  const meta = { decimal: commaCells ? ',' : '.', headerLines: [], header: {}, dataRows: [main.start + 1, main.end + 1] };
  let headerRow = -1;
  for (let j = main.start - 1; j >= 0; j--) {
    if (kinds[j] === 0) continue;
    if (kinds[j] === 1) headerRow = j;
    break;
  }
  const cellText = c => (c === null || c === undefined ? '' : String(c).trim());
  const headers = keep.map(j => (headerRow >= 0 ? cellText(rows[headerRow][j]) : ''));
  for (let j = 0; j < main.start; j++) {
    if (kinds[j] !== 0) meta.headerLines.push(rows[j].map(cellText).join('\t').trim());
  }
  for (let j = 0; j < rows.length; j++) {
    if (kinds[j] === 0 || j === headerRow || (j >= main.start && j <= main.end && kinds[j] === 2)) continue;
    const cells = rows[j].map(cellText).filter(Boolean);
    if (cells.length === 2 && /[a-z]/i.test(cells[0])) { addMeta(meta, cells[0].replace(/[:=]\s*$/, ''), cells[1]); continue; }
    if (cells.length === 1) { const kv = parseMetaLine(cells[0]); if (kv) addMeta(meta, kv[0], kv[1]); }
  }
  if (meta.laserNm === undefined) delete meta.laserNm;
  const warnings = [];
  if (commaCells) warnings.push(`Converted ${commaCells} text cell${commaCells > 1 ? 's' : ''} with decimal commas to numbers.`);
  for (const r of runs) {
    if (r === main || r.count < 3) continue;
    warnings.push(`Ignored ${r.count} other numeric rows at rows ${r.start + 1}–${r.end + 1} (a separate block).`);
  }
  return { headers, columns: keep.map(j => raw[j]), nRows: main.count, meta, warnings };
}
