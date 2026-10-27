/* Renishaw WiRE .wdf reader: single spectra, series and maps.

   A WDF file is a chain of blocks, each starting with a 16-byte header:
   4-byte ASCII type, uint32 uid, uint64 size (including the header), all
   little-endian. The fields read here:
     WDF1 (the 512-byte file header)
       0x3C uint32 points per spectrum      0x40 uint64 capacity
       0x48 uint64 spectra collected        0x50 uint32 accumulations
       0x54 uint32 y-list length (1 = plain spectra; more is a spectral image)
       0x58 uint32 x-list length            0x5C uint32 number of origin lists
       0x60 char[24] application name       0x78 uint16[4] application version
       0x84 uint32 measurement type (1 single, 2 series, 3 map)
       0x9C float32 laser wavenumber, cm⁻¹ (1e7 / nm)
       0xF0 char[160] title
     DATA  float32 [collected × points] after the block header
     XLST  uint32 data type, uint32 units (1 = Raman shift), float32 [x-list length]
     ORGN  uint32 count, then per list: uint32 type (high bit: primary; low
           bits 3/4/5 = spatial X/Y/Z), uint32 units (5 = µm), char[16] label,
           then [capacity] 8-byte values (float64 for spatial lists)
     WMAP  uint32 flags, uint32 unused, float32 start x,y,z, float32 step
           x,y,z, uint32 size x,y,z (the map grid)
   The operator name and instrument serial numbers in the file are not read.
   Everything else (white-light image, parameter trees) is skipped. */

import { makeSpectrum } from './spectrum.js';

const MEASUREMENT = { 1: 'single spectrum', 2: 'series', 3: 'map' };
const SPATIAL = { 3: 'x', 4: 'y', 5: 'z' };
const MAX_SPECTRA = 20000;

/**
 * Parse a WDF file.
 * @param {ArrayBuffer} buf
 * @param {{filename?:string}} [opts]
 * @returns {{format:'wdf', spectra:object[], needsMapping:false, confidence:number, warnings:string[]}}
 *   Map spectra carry meta.map = { index, x, y, z, unit, grid: { nx, ny, x0, y0, dx, dy } | null }.
 */
export function parseWdf(buf, { filename = '' } = {}) {
  const who = filename || 'The WDF file';
  if (!buf || buf.byteLength < 512) throw new Error(`${who} is too short to be a WDF file.`);
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'WDF1') throw new Error(`${who} is not a Renishaw WDF file.`);
  const u64 = o => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;
  const str = (o, len) => { let s = ''; for (let i = 0; i < len; i++) { const c = dv.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); };

  // block index
  const blocks = new Map();
  for (let off = 0; off + 16 <= buf.byteLength;) {
    const size = u64(off + 8);
    if (size < 16 || off + size > buf.byteLength) break;
    const t = tag(off);
    if (!blocks.has(t)) blocks.set(t, off);
    off += size;
  }

  const points = dv.getUint32(0x3C, true), capacity = u64(0x40), count = u64(0x48);
  const accum = dv.getUint32(0x50, true), ylen = dv.getUint32(0x54, true), xlen = dv.getUint32(0x58, true);
  const app = str(0x60, 24), version = [0, 1, 2, 3].map(i => dv.getUint16(0x78 + 2 * i, true));
  const mtype = dv.getUint32(0x84, true), laserWn = dv.getFloat32(0x9C, true), title = str(0xF0, 160);
  const warnings = [];

  if (ylen > 1) throw new Error(`${who} is a spectral image (${ylen} rows per spectrum), which is not supported.`);
  if (!points || points !== xlen) throw new Error(`${who} has an inconsistent header (${points} points, x list of ${xlen}).`);
  if (!count) throw new Error(`${who} holds no collected spectra.`);
  if (count > MAX_SPECTRA) throw new Error(`${who} holds ${count} spectra; the app reads at most ${MAX_SPECTRA}.`);
  const dataOff = blocks.get('DATA'), xOff = blocks.get('XLST');
  if (dataOff == null || xOff == null) throw new Error(`${who} is missing its ${dataOff == null ? 'DATA' : 'XLST'} block.`);
  if (dataOff + 16 + 4 * points * count > buf.byteLength) throw new Error(`${who} is truncated (the data block is shorter than ${count} × ${points} values).`);

  const xUnits = dv.getUint32(xOff + 20, true);
  if (xUnits !== 1) warnings.push(`${who}: the x axis is not in Raman shift (WiRE unit code ${xUnits}); the app treats it as cm⁻¹.`);
  const x = new Float64Array(xlen);
  for (let i = 0; i < xlen; i++) x[i] = dv.getFloat32(xOff + 24 + 4 * i, true);

  // spatial origins (maps)
  const coords = {};
  let unit = '';
  const oOff = blocks.get('ORGN');
  if (oOff != null) {
    const n = dv.getUint32(oOff + 16, true);
    let p = oOff + 20;
    for (let k = 0; k < n && p + 24 + 8 * capacity <= buf.byteLength; k++) {
      const type = dv.getUint32(p, true) & 0x7FFFFFFF, units = dv.getUint32(p + 4, true);
      const label = str(p + 8, 16).toLowerCase();
      const axis = SPATIAL[type] || (['x', 'y', 'z'].includes(label) ? label : null);
      if (axis) {
        coords[axis] = Float64Array.from({ length: count }, (_, i) => dv.getFloat64(p + 24 + 8 * i, true));
        if (units === 5) unit = 'µm';
      }
      p += 24 + 8 * capacity;
    }
  }
  let grid = null;
  const mOff = blocks.get('WMAP');
  if (mOff != null && mOff + 64 <= buf.byteLength) {
    const nx = dv.getUint32(mOff + 48, true), ny = dv.getUint32(mOff + 52, true);
    if (nx >= 1 && ny >= 1 && nx * ny <= MAX_SPECTRA) {
      grid = { nx, ny, x0: dv.getFloat32(mOff + 24, true), y0: dv.getFloat32(mOff + 28, true),
        dx: dv.getFloat32(mOff + 36, true), dy: dv.getFloat32(mOff + 40, true) };
    }
  }
  const isMap = mtype === 3 && coords.x && coords.y;

  const laserNm = laserWn > 1000 && laserWn < 40000 ? 1e7 / laserWn : null;
  const header = {};
  if (laserNm) header.Laser = `${laserNm.toFixed(1)} nm`;
  if (accum) header.Accumulations = String(accum);
  if (app) header.Software = `${app} ${version.join('.')}`;
  header.Measurement = MEASUREMENT[mtype] ? `${MEASUREMENT[mtype]}${count > 1 ? `, ${count} spectra` : ''}` : `type ${mtype}`;
  if (isMap && grid) header.Map = `${grid.nx} × ${grid.ny} points, ${fmtStep(grid.dx)} × ${fmtStep(grid.dy)} ${unit || 'units'} steps`;
  if (title) header.Title = title;
  const meta = { header, ...(laserNm ? { laserNm } : {}), wdf: { measurement: mtype, capacity, count } };

  const spectra = [];
  let sharedX = null;
  for (let s = 0; s < count; s++) {
    const y = new Float64Array(points);
    const base = dataOff + 16 + 4 * points * s;
    for (let i = 0; i < points; i++) y[i] = dv.getFloat32(base + 4 * i, true);
    const where = isMap ? ` (${fmtStep(coords.x[s])}, ${fmtStep(coords.y[s])}${unit ? ' ' + unit : ''})` : '';
    const sp = makeSpectrum({
      x, y,
      name: count > 1 ? `${filename || 'WDF'} · #${s + 1}${where}` : (filename || 'WDF spectrum'),
      source: { file: filename, format: 'wdf', column: count > 1 ? `#${s + 1}` : undefined },
      meta: isMap
        ? { ...meta, map: { index: s, x: coords.x[s], y: coords.y[s], z: coords.z ? coords.z[s] : null, unit, grid } }
        : { ...meta, ...(count > 1 ? { series: { index: s } } : {}) },
    });
    // every spectrum of a file shares one axis: keep one copy
    if (sharedX && sharedX.length === sp.x.length && sharedX.every((v, i) => v === sp.x[i])) sp.x = sharedX;
    else if (!sharedX) sharedX = sp.x;
    spectra.push(sp);
  }
  if (count > 5000) warnings.push(`${who}: ${count} spectra loaded; processing them all may be slow.`);
  return { format: 'wdf', spectra, needsMapping: false, confidence: 1, warnings };
}

function fmtStep(v) { return Number.isInteger(v) ? String(v) : String(+v.toFixed(2)); }
