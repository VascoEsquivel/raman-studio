/* Thermo / Galactic SPC reader (new format). Experimental.

   Layout (Galactic "SPC file format", spc.h); all fields little-endian for
   fversn 0x4B, big-endian for 0x4C:
     main header, 512 bytes
       0 ftflgs  (0x01 TSPREC 16-bit Y · 0x04 TMULTI · 0x40 TXYXYS · 0x80 TXVALS)
       1 fversn  (0x4B new LSB · 0x4C new MSB · 0x4D old format)
       3 fexp    Y exponent, int8; -128 (0x80) means IEEE float Y
       4 fnpts   uint32 points (per subfile)
       8 ffirst  float64 first x      16 flast float64 last x
      24 fnsub   uint32 subfiles      28 fxtype x units (1 cm⁻¹, 3 nm, 13 Raman shift)
      88 fcmnt   char[130] memo      248 flogoff uint32 log block offset
     then the x array (float32[fnpts]) if TXVALS and not TXYXYS; then each subfile:
       32-byte subheader (1 subexp int8, 16 subnpts uint32) · own x array (float32)
       if TXYXYS · y as float32 (exponent -128) or int32 (int16 with TSPREC)
       scaled y = int · 2^(exp − 32)  (2^(exp − 16) for int16).
     log block at flogoff: 64-byte header (8 logtxto uint32) then "key=value"
     text lines at flogoff + logtxto.
   Evenly spaced files (no TXVALS) span ffirst … flast. */

import { makeSpectrum, laserFromHeader } from './spectrum.js';

const TSPREC = 0x01, TMULTI = 0x04, TXYXYS = 0x40, TXVALS = 0x80;

/**
 * Parse an SPC file.
 * @param {ArrayBuffer} buf
 * @param {{filename?:string}} [opts]
 * @returns {{format:'spc', spectra:object[], needsMapping:false, confidence:number, warnings:string[]}}
 */
export function parseSpc(buf, { filename = '' } = {}) {
  const who = filename || 'The SPC file';
  if (!buf || buf.byteLength < 512) throw new Error(`${who} is too short to be an SPC file.`);
  const dv = new DataView(buf);
  const ftflgs = dv.getUint8(0), fversn = dv.getUint8(1);
  if (fversn === 0x4D) throw new Error(`${who} uses the old (pre-1996) SPC format, which is not supported. Re-export it as new-format SPC, CSV or JCAMP-DX.`);
  if (fversn !== 0x4B && fversn !== 0x4C) throw new Error(`${who} is not an SPC file (version byte 0x${fversn.toString(16)}).`);
  const le = fversn === 0x4B;
  const fexp = dv.getInt8(3), fnpts = dv.getUint32(4, le);
  const ffirst = dv.getFloat64(8, le), flast = dv.getFloat64(16, le);
  const fnsub = dv.getUint32(24, le), fxtype = dv.getUint8(28), flogoff = dv.getUint32(248, le);
  const memo = ascii(dv, 88, 130);
  const warnings = [];
  const need = (off, bytes) => {
    if (off + bytes > buf.byteLength) throw new Error(`${who} is truncated (needs ${off + bytes} bytes, has ${buf.byteLength}).`);
  };
  const f32 = (off, n) => { need(off, 4 * n); const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = dv.getFloat32(off + 4 * i, le); return a; };

  const xyxys = !!(ftflgs & TXYXYS), xvals = !!(ftflgs & TXVALS), multi = !!(ftflgs & TMULTI);
  if (!xyxys && (fnpts < 1 || fnpts > 50e6)) throw new Error(`${who} declares ${fnpts} points.`);
  let off = 512;
  let sharedX = null;
  if (!xyxys) {
    if (xvals) { sharedX = f32(off, fnpts); off += 4 * fnpts; }
    else {
      sharedX = new Float64Array(fnpts);
      for (let i = 0; i < fnpts; i++) sharedX[i] = fnpts === 1 ? ffirst : ffirst + (flast - ffirst) * i / (fnpts - 1);
    }
  }

  const header = parseLog(dv, flogoff, le, buf.byteLength);
  const meta = {};
  for (const [k, v] of Object.entries(header)) { const nm = laserFromHeader(k, v); if (nm) { meta.laserNm = nm; break; } }
  if (Object.keys(header).length) meta.header = header;
  if (memo) meta.memo = memo;
  if (fxtype === 3) warnings.push(`${who}: x axis is in nanometres; Raman shift is assumed by the app.`);

  const nsub = multi ? Math.max(1, fnsub) : 1;
  const spectra = [];
  for (let s = 0; s < nsub; s++) {
    need(off, 32);
    const subexp = dv.getInt8(off + 1), subnpts = dv.getUint32(off + 16, le);
    off += 32;
    const n = xyxys ? subnpts : fnpts;
    let x = sharedX;
    if (xyxys) { x = f32(off, n); off += 4 * n; }
    const exp = multi ? subexp : fexp;
    const y = new Float64Array(n);
    if (exp === -128) {
      need(off, 4 * n);
      for (let i = 0; i < n; i++) y[i] = dv.getFloat32(off + 4 * i, le);
      off += 4 * n;
    } else if (ftflgs & TSPREC) {
      need(off, 2 * n);
      const k = Math.pow(2, exp - 16);
      for (let i = 0; i < n; i++) y[i] = dv.getInt16(off + 2 * i, le) * k;
      off += 2 * n;
    } else {
      need(off, 4 * n);
      const k = Math.pow(2, exp - 32);
      for (let i = 0; i < n; i++) y[i] = dv.getInt32(off + 4 * i, le) * k;
      off += 4 * n;
    }
    spectra.push(makeSpectrum({
      x, y, meta: { ...meta, subfile: s },
      name: [filename, nsub > 1 ? `subfile ${s + 1}` : null].filter(Boolean).join(' · ') || 'SPC spectrum',
      source: { file: filename, format: 'spc', column: nsub > 1 ? `subfile ${s + 1}` : undefined },
    }));
  }
  return { format: 'spc', spectra, needsMapping: false, confidence: 1, warnings };
}

function ascii(dv, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = dv.getUint8(off + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function parseLog(dv, flogoff, le, size) {
  const out = {};
  if (!flogoff || flogoff + 64 > size) return out;
  const txto = dv.getUint32(flogoff + 8, le);
  let p = flogoff + txto, text = '';
  while (p < size) { const c = dv.getUint8(p++); if (!c) break; text += String.fromCharCode(c); }
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
