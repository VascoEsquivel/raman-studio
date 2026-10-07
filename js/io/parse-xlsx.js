/* Excel workbooks (.xlsx / .xls) via SheetJS.

   SheetJS is ~1 MB, so it is loaded from its CDN only when a spreadsheet is
   actually opened. 0.20.3 is pinned and comes from cdn.sheetjs.com: the npm
   registry's last copy (0.18.5) carries unpatched security advisories. The
   library only parses the file in the browser; nothing is sent anywhere. */

import { tableFromRows } from './parse-text.js';
import { detectColumns, tableToSpectra, CONFIDENT } from './detect-columns.js';

export const SHEETJS_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

let pending = null;

/**
 * Load SheetJS once (cached promise). Not pure: performs a dynamic import.
 * @returns {Promise<object>} the XLSX module namespace
 */
export function loadSheetJS() {
  if (!pending) {
    pending = import(SHEETJS_URL).catch(err => {
      pending = null;   // allow a retry once the connection is back
      throw new Error(`Could not load the spreadsheet reader (SheetJS) from its CDN. Check the internet connection, or export the sheet as CSV. (${err.message})`);
    });
  }
  return pending;
}

/**
 * Parse every sheet that holds numeric data.
 * @param {ArrayBuffer} buf
 * @param {object} XLSX SheetJS module (injected so tests and the app share one loader)
 * @param {{filename?:string, format?:'xlsx'|'xls'}} [opts]
 * @returns {{format:string, spectra:object[], sheets:Array<{name:string, table:object, mapping:object}>,
 *   needsMapping:boolean, confidence:number, warnings:string[]}}
 */
export function parseWorkbook(buf, XLSX, { filename = '', format } = {}) {
  const fmt = format || (/\.xls$/i.test(filename) ? 'xls' : 'xlsx');
  const who = filename || 'The workbook';
  let wb;
  try {
    wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false, dense: true });
  } catch (err) {
    throw new Error(`${who} could not be read as a spreadsheet (${err.message}).`);
  }
  const sheets = [], spectra = [], warnings = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: false, defval: null });
    const table = tableFromRows(rows);
    if (!table || table.nRows < 3) continue;     // notes, metadata or empty sheets
    const mapping = detectColumns(table);
    sheets.push({ name, table, mapping });
    if (mapping.confidence >= CONFIDENT) {
      spectra.push(...tableToSpectra(table, mapping, { file: filename, format: fmt, sheet: name, warnings }));
    }
  }
  if (!sheets.length) throw new Error(`${who} has no sheet with numeric spectrum data.`);
  const confidence = Math.min(...sheets.map(s => s.mapping.confidence));
  return { format: fmt, spectra, sheets, needsMapping: confidence < CONFIDENT, confidence, warnings };
}
