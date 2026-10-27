/* Acquisition metadata and data-quality checks.

   Instrument exports carry the acquisition settings in their header (WiRE
   writes them into the SPC log block as "Key=Label: value" lines). They matter
   for reading the result: with the instrument's own cosmic-ray removal off and
   a single accumulation, the app's despike is the only protection against
   spikes; a saturated detector flattens band tops and corrupts every ratio.
   Nothing here changes the data; it only reports. */

const pickKey = (header, re) => {
  for (const [k, v] of Object.entries(header || {})) if (re.test(k)) return { key: k, value: String(v) };
  return null;
};
/** "Label: 10000" → "10000"; values without a label pass through. */
const bare = v => String(v).replace(/^[^:=]*:\s*/, '').trim();
const num = v => { const m = /-?\d+(?:\.\d+)?/.exec(String(v)); return m ? +m[0] : null; };

/**
 * Acquisition settings found in a spectrum's metadata.
 * @param {object} meta Spectrum meta (meta.header: raw key → value strings, meta.laserNm)
 * @returns {{fields:Array<{label:string,value:string,key:string}>, laserNm:number|null,
 *   exposureS:number|null, accumulations:number|null, cosmicRayRemoval:boolean|null, hasHeader:boolean}}
 *   exposureS is only derived for WiRE's "Time: <ms>" form; other forms are shown verbatim.
 */
export function acquisition(meta) {
  const h = (meta && meta.header) || {};
  const out = { fields: [], laserNm: Number.isFinite(meta?.laserNm) ? meta.laserNm : null, exposureS: null,
    accumulations: null, cosmicRayRemoval: null, hasHeader: Object.keys(h).length > 0 };
  const add = (label, hit, value) => { if (hit) out.fields.push({ label, value: value ?? bare(hit.value), key: hit.key }); };

  const laser = pickKey(h, /^laser$|^laser[_ ]?(wavelength|line)?$/i);
  add('Laser', laser);
  const grating = pickKey(h, /grating/i);
  add('Grating', grating);
  const exp = pickKey(h, /exposure/i);
  if (exp) {
    const v = bare(exp.value), n = num(v);
    // WiRE logs exposure as "Time: <milliseconds>" (10000 for a 10 s exposure)
    if (/^time\s*:/i.test(exp.value.trim()) && n != null) { out.exposureS = n / 1000; add('Exposure', exp, `${n / 1000} s`); }
    else add('Exposure', exp, v);
  }
  const acc = pickKey(h, /accumulation/i);
  if (acc) { out.accumulations = num(bare(acc.value)); add('Accumulations', acc); }
  const crr = pickKey(h, /cosmic/i);
  if (crr) {
    const v = bare(crr.value).toLowerCase();
    out.cosmicRayRemoval = /^(1|on|true|yes|enabled?)$/.test(v) ? true : /^(0|off|false|no|disabled?)$/.test(v) ? false : null;
    add('Instrument cosmic-ray removal', crr, out.cosmicRayRemoval === true ? 'on' : out.cosmicRayRemoval === false ? 'off' : bare(crr.value));
  }
  add('Laser power', pickKey(h, /laser[_ ]?power|^power$/i));
  add('Objective', pickKey(h, /objective|magnification/i));
  add('Slit', pickKey(h, /slit/i));
  const sw = pickKey(h, /^version$|software/i);
  add('Software version', sw);
  return out;
}

/**
 * Data-quality flags for a raw spectrum.
 * @param {{x:ArrayLike<number>, y:ArrayLike<number>}} spectrum raw data, ascending x
 * @param {ReturnType<typeof acquisition>} acq
 * @returns {Array<{level:'warn'|'info', id:string, text:string}>}
 */
export function qualityFlags(spectrum, acq) {
  const flags = [];
  const y = spectrum && spectrum.y, x = spectrum && spectrum.x;
  if (acq && acq.cosmicRayRemoval === false) {
    const single = acq.accumulations === 1;
    flags.push({ level: 'warn', id: 'crr-off',
      text: `The instrument's cosmic-ray removal was off${single ? ' and only one accumulation was taken' : ''}, so the app's despike is the only protection against spikes. Review the removals listed below.` });
  } else if (acq && acq.accumulations === 1 && acq.cosmicRayRemoval == null) {
    flags.push({ level: 'info', id: 'single-acc', text: 'A single accumulation: the instrument could not reject cosmic rays by comparing repeats.' });
  }
  if (!y || y.length < 3) return flags;
  const n = y.length;
  let max = -Infinity, at = -1;
  for (let i = 0; i < n; i++) if (y[i] > max) { max = y[i]; at = i; }
  // flat top: the maximum held over ≥ 3 consecutive points
  let run = y[0] === max ? 1 : 0, best = 1, bestEnd = at;
  for (let i = 1; i < n; i++) {
    run = y[i] === max && y[i - 1] === max ? run + 1 : (y[i] === max ? 1 : 0);
    if (run > best) { best = run; bestEnd = i; }
  }
  if (best >= 3) {
    const x0 = x ? x[bestEnd - best + 1] : bestEnd - best + 1, x1 = x ? x[bestEnd] : bestEnd;
    flags.push({ level: 'warn', id: 'flat-top',
      text: `The maximum (${fmtNum(max)}) is held over ${best} consecutive points near ${Math.round(x0)}–${Math.round(x1)} cm⁻¹: the detector was probably saturated. Band heights and ratios there are not reliable; lower the laser power or exposure.` });
  }
  if (max >= 65535 && max <= 65536) {
    flags.push({ level: 'warn', id: 'adc-ceiling', text: 'The maximum sits at the 16-bit ceiling (65535): saturated or clipped data.' });
  }
  // flat segment anywhere: identical values over ≥ 2 % of the spectrum (and ≥ 10 points)
  const need = Math.max(10, Math.ceil(0.02 * n));
  let r = 1;
  for (let i = 1; i < n; i++) {
    r = y[i] === y[i - 1] ? r + 1 : 1;
    if (r === need) {
      const xs = x ? Math.round(x[i - need + 1]) : i - need + 1;
      flags.push({ level: 'warn', id: 'flat-segment',
        text: `A flat segment of ${need}+ identical values from ${xs} cm⁻¹: clipped, saturated or padded data.` });
      break;
    }
  }
  return flags;
}

function fmtNum(v) { return Math.abs(v) >= 1000 ? String(Math.round(v)) : String(+v.toPrecision(4)); }
