/* File → ImportResult, for any supported format.

   The extension picks a parser, but content wins: instruments and colleagues
   rename files freely, so the bytes are sniffed first (zip → xlsx, OLE → xls,
   SPC version byte in a binary header, '##' → JCAMP-DX). Text is decoded by
   BOM (UTF-8, UTF-16 LE/BE), then strict UTF-8, then Windows-1252, which is
   what older instrument PCs write. */

import { parseDelimitedText } from './parse-text.js';
import { detectColumns, tableToSpectra, CONFIDENT } from './detect-columns.js';
import { parseJcamp } from './parse-jcamp.js';
import { parseSpc } from './parse-spc.js';
import { loadSheetJS, parseWorkbook } from './parse-xlsx.js';

export const SUPPORTED_EXTENSIONS = ['.csv', '.tsv', '.txt', '.dat', '.asc', '.xlsx', '.xls', '.jdx', '.dx', '.jcamp', '.spc'];

/**
 * Identify the format from content (and extension as a tie-breaker).
 * @param {Uint8Array} bytes
 * @param {string} ext lower-case extension including the dot
 * @returns {'xlsx'|'xls'|'spc'|'jcamp'|'text'}
 */
export function sniff(bytes, ext = '') {
  const b = i => bytes[i];
  if (b(0) === 0x50 && b(1) === 0x4B && b(2) === 0x03 && b(3) === 0x04) return 'xlsx';
  if (b(0) === 0xD0 && b(1) === 0xCF && b(2) === 0x11 && b(3) === 0xE0) return 'xls';
  if (bytes.length >= 512 && (b(1) === 0x4B || b(1) === 0x4C || b(1) === 0x4D)) {
    // SPC headers are full of NUL padding; a text file whose 2nd character is K/L/M is not.
    let nul = 0;
    for (let i = 0; i < 512; i++) if (bytes[i] === 0) nul++;
    if (ext === '.spc' || nul > 64) return 'spc';
  }
  if (ext === '.spc') return 'spc';
  const head = decodeText(bytes.subarray(0, Math.min(bytes.length, 4096))).replace(/^﻿/, '').trimStart();
  if (head.startsWith('##')) return 'jcamp';
  return 'text';
}

/**
 * Decode text bytes: BOM first, then strict UTF-8, then Windows-1252.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeText(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  // UTF-16 without a BOM: ASCII text with every other byte NUL
  if (bytes.length >= 8) {
    let oddNul = 0, evenNul = 0;
    const m = Math.min(bytes.length, 400) & ~1;
    for (let i = 0; i < m; i += 2) { if (bytes[i] === 0) evenNul++; if (bytes[i + 1] === 0) oddNul++; }
    if (oddNul > m * 0.4 && evenNul < m * 0.05) return new TextDecoder('utf-16le').decode(bytes);
    if (evenNul > m * 0.4 && oddNul < m * 0.05) return new TextDecoder('utf-16be').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Read a File (or any { name, arrayBuffer() }) into spectra.
 * @param {{name:string, arrayBuffer:() => Promise<ArrayBuffer>}} file
 * @returns {Promise<object>} ImportResult (docs/ARCHITECTURE.md)
 */
export async function importFile(file) {
  const name = (file && file.name) || 'file';
  const ext = ((name.match(/\.[^./\\]+$/) || [''])[0]).toLowerCase();
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (!bytes.length) throw new Error(`${name} is empty.`);
  const kind = sniff(bytes, ext);
  if (kind === 'spc') return parseSpc(buf, { filename: name });
  if (kind === 'xlsx' || kind === 'xls') {
    const XLSX = await loadSheetJS();
    return parseWorkbook(buf, XLSX, { filename: name, format: kind });
  }
  const text = decodeText(bytes);
  if (kind === 'jcamp') return parseJcamp(text, { filename: name });
  if (/[\u0000-\u0008\u000E-\u001F]/.test(text.slice(0, 2000).replace(/\u0000+$/, ''))) {
    throw new Error(`${name} looks like a binary file this app does not read. Supported: ${SUPPORTED_EXTENSIONS.join(' ')}`);
  }
  return parseTextFile(text, name, ext);
}

function parseTextFile(text, name, ext) {
  const table = parseDelimitedText(text, { filename: name });
  const format = ext === '.csv' ? 'csv' : ext === '.tsv' ? 'tsv' : 'txt';
  const mapping = detectColumns(table);
  const warnings = [...(table.warnings || [])];
  const spectra = mapping.confidence >= CONFIDENT ? tableToSpectra(table, mapping, { file: name, format, warnings }) : [];
  return { format, spectra, table, mapping, needsMapping: mapping.confidence < CONFIDENT, confidence: mapping.confidence, warnings };
}

/**
 * Spectra from a table with a user-confirmed mapping.
 * @param {object} table
 * @param {object} mapping
 * @param {{file?:string, format?:string, sheet?:string}} [info]
 * @returns {object[]} Spectrum[]
 */
export function applyMapping(table, mapping, info = {}) {
  return tableToSpectra(table, mapping, info);
}
