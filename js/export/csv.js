/* CSV export — pure string builders, no DOM.

   Output is RFC 4180: comma separators, CRLF record ends, fields quoted only
   when they must be (comma, quote, CR/LF) or when leading/trailing blanks
   would otherwise be trimmed by some readers. Numbers always use '.' as the
   decimal mark whatever the user's locale, because a CSV is an interchange
   file, not a display: a German Excel can still import it by choosing the
   separator, but a decimal comma inside an unquoted field would split it.

   Unicode labels (D′, 2D′, sp³ C–H) are written as-is. The download code
   should prepend a UTF-8 BOM so Excel on Windows picks the right encoding;
   that byte is not part of the CSV text, so it is not added here. */

import { peakArea, peakType } from '../fit/profile.js';

const EOL = '\r\n';

/** Column order of {@link peakTableCSV}. */
export const PEAK_TABLE_COLUMNS = Object.freeze([
  'label', 'kind', 'tier', 'position_cm-1', 'height', 'fwhm_cm-1', 'prominence',
  'area', 'match_score', 'delta_cm-1', 'band_id', 'band_name',
]);

/** Column order of {@link fitParamsCSV}. */
export const FIT_PARAMS_COLUMNS = Object.freeze([
  'label', 'band_id', 'centre_cm-1', 'centre_se', 'fwhm_cm-1', 'fwhm_se', 'height', 'height_se',
  'gaussian_pct', 'type', 'area', 'area_pct', 'significant', 'window',
]);

/** Column order of {@link spectrumCSV}. */
export const SPECTRUM_COLUMNS = Object.freeze(['x', 'raw', 'baseline', 'corrected', 'final', 'despiked']);

/**
 * Format a number for CSV: integers verbatim, everything else to 6 significant
 * digits with trailing zeros dropped. Non-finite values become an empty cell —
 * "NaN" or "Infinity" would turn a numeric column into text in every spreadsheet.
 * @param {number} v
 * @returns {string}
 */
export function formatNumber(v) {
  if (!Number.isFinite(v)) return '';
  if (Number.isInteger(v)) return String(v);   // String(-0) is '0', which is what we want
  return String(Number(v.toPrecision(6)));
}

/** Text for one cell, before quoting. */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v);
}

/** Quote a field when RFC 4180 requires it (or when blanks at the ends would be lost). */
function quote(s) {
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Build an RFC 4180 CSV document.
 * Rows may be arrays (values in header order) or plain objects keyed by header.
 * null / undefined / NaN / ±Infinity become empty fields; numbers are written
 * with '.' decimals to 6 significant digits unless they are integers; every
 * record, including the last, ends with CRLF.
 * @param {string[]|null} headers column names; null or [] writes no header line
 * @param {Array<Array<*>|Object<string,*>>} rows
 * @returns {string}
 */
export function toCSV(headers, rows) {
  const hs = headers ? Array.from(headers, h => (h === null || h === undefined ? '' : String(h))) : [];
  const lines = [];
  if (hs.length) lines.push(hs.map(h => quote(h)).join(','));
  for (const row of rows || []) {
    let vals;
    if (Array.isArray(row) || ArrayBuffer.isView(row)) vals = Array.from(row);
    else if (row && typeof row === 'object') vals = hs.map(h => row[h]);
    else vals = [row];
    lines.push(vals.map(v => quote(cellText(v))).join(','));
  }
  return lines.length ? lines.join(EOL) + EOL : '';
}

/** First of `keys` present on `o` with a non-null value. */
function pick(o, ...keys) {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return null;
}

/**
 * Peak table as CSV, one row per labelled peak.
 * Row fields (camelCase; the snake_case column names are accepted too):
 * `label, kind, tier, x` (or `position`/`x0`), `height` (or `h`/`y`), `fwhm` (or `w`),
 * `prominence, area, matchScore` (or `confidence`), `delta, bandId, bandName`. Missing values stay empty.
 * Columns: label, kind, tier, position_cm-1, height, fwhm_cm-1, prominence, area,
 * match_score, delta_cm-1, band_id, band_name. match_score is the matcher's position score
 * (1 at the atlas centre, ≈0.14 at the window edge): a distance measure, not a probability.
 * With `referenceCandidates`, a last column reference_candidates holds each row's
 * `referenceCandidates` text (candidates from a private reference list, not identifications).
 * @param {object[]} rows
 * @param {{referenceCandidates?:boolean}} [opts]
 * @returns {string}
 */
export function peakTableCSV(rows, { referenceCandidates = false } = {}) {
  const out = (rows || []).map(r => [
    pick(r, 'label'),
    pick(r, 'kind'),
    pick(r, 'tier'),
    pick(r, 'x', 'position', 'x0', 'position_cm-1'),
    pick(r, 'height', 'h', 'y'),
    pick(r, 'fwhm', 'w', 'fwhm_cm-1'),
    pick(r, 'prominence'),
    pick(r, 'area'),
    pick(r, 'matchScore', 'match_score', 'confidence'),
    pick(r, 'delta', 'delta_cm-1'),
    pick(r, 'bandId', 'band_id'),
    pick(r, 'bandName', 'band_name'),
  ].concat(referenceCandidates ? [pick(r, 'referenceCandidates', 'reference_candidates')] : []));
  return toCSV(referenceCandidates ? PEAK_TABLE_COLUMNS.concat(['reference_candidates']) : PEAK_TABLE_COLUMNS, out);
}

/** Standard error from a FitComponent's `se`, or null when locked / absent. */
function se(c, k) { return c.se && Number.isFinite(c.se[k]) ? c.se[k] : null; }

/**
 * Deconvolution parameters as CSV, one row per FitComponent.
 * Area comes from the component (or the WiRE pseudo-Voigt formula if absent);
 * area % is relative to the other components of the same fit window, because
 * each window is an independent fit and a percentage across windows would mix
 * first- and second-order regions. The window column is "lo-hi" in cm⁻¹ when
 * `windows` describes it, else the window index.
 * Columns: label, band_id, centre_cm-1, centre_se, fwhm_cm-1, fwhm_se, height,
 * height_se, gaussian_pct, type, area, area_pct, significant, window.
 * @param {object[]} components FitComponent[] ({ bandId, label, x0, w, h, g, area, se, significant, windowIndex })
 * @param {{lo:number, hi:number}[]} [windows] Deconvolution.windows
 * @returns {string}
 */
export function fitParamsCSV(components, windows) {
  const comps = components || [];
  const areaOf = c => (Number.isFinite(c.area) ? c.area : peakArea(c));
  const totals = new Map();
  for (const c of comps) {
    const a = areaOf(c);
    if (Number.isFinite(a)) totals.set(c.windowIndex, (totals.get(c.windowIndex) || 0) + a);
  }
  const winText = i => {
    const wnd = windows && Number.isInteger(i) ? windows[i] : null;
    if (wnd && Number.isFinite(wnd.lo) && Number.isFinite(wnd.hi)) return `${formatNumber(wnd.lo)}-${formatNumber(wnd.hi)}`;
    return Number.isFinite(i) ? i : null;
  };
  const out = comps.map(c => {
    const a = areaOf(c), tot = totals.get(c.windowIndex);
    return [
      c.label ?? null,
      c.bandId ?? null,
      c.x0, se(c, 'x0'),
      c.w, se(c, 'w'),
      c.h, se(c, 'h'),
      c.g,
      Number.isFinite(c.g) ? peakType(c) : null,
      a,
      Number.isFinite(a) && tot ? (100 * a) / tot : null,
      typeof c.significant === 'boolean' ? c.significant : null,
      winText(c.windowIndex),
    ];
  });
  return toCSV(FIT_PARAMS_COLUMNS, out);
}

/**
 * Processed spectrum as CSV: x, raw, baseline, corrected, final (Processed.y).
 * The baseline column is always present so the layout is the same for every
 * export; its cells are empty when no baseline was subtracted (baseline null).
 * With a calibration offset, a last column x_uncalibrated holds x − offset (x is calibrated).
 * @param {object} processed pipeline result ({ x, raw, baseline, corrected, y })
 * @param {{xOffsetCm?:number}} [opts]
 * @returns {string}
 */
export function spectrumCSV(processed, { xOffsetCm = 0 } = {}) {
  if (!processed || !processed.x) throw new Error('Nothing to export: the spectrum has no x values.');
  const { x, raw, baseline, corrected, y, despiked } = processed;
  const at = (arr, i) => (arr && i < arr.length ? arr[i] : null);
  const rows = new Array(x.length);
  for (let i = 0; i < x.length; i++) {
    rows[i] = [x[i], at(raw, i), at(baseline, i), at(corrected, i), at(y, i), at(despiked, i)];
    if (xOffsetCm) rows[i].push(x[i] - xOffsetCm);
  }
  return toCSV(xOffsetCm ? SPECTRUM_COLUMNS.concat(['x_uncalibrated']) : SPECTRUM_COLUMNS, rows);
}
