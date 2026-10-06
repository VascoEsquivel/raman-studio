/* Band libraries: load, validate, and prepare for a given laser.

   A library is plain JSON (data/libraries/schema.json). Loading never throws —
   a broken library file must not take the app down, it is listed in `errors`
   and the remaining libraries still load. Preparation turns the atlas bands into
   laser-specific match windows; it is the only place that knows about dispersion,
   so the matcher, the fitter and the plot all agree on where a band is. */

import { photonEnergyEV, dispersionShift } from './dispersion.js';

const SCHEMA_ID = 'raman-studio/band-library@1';

// Used only when a library carries no matchDefaults. Same value graphene-go
// ships with, so a minimal third-party library behaves like the bundled one.
const FALLBACK_TOLERANCE_CM = 25;

// Generous bounds for a Stokes Raman shift. Anything outside is almost
// certainly a typo (nm instead of cm⁻¹, a missing digit) rather than physics.
const SANE_SHIFT = [0, 5000];

// FWHM of a Gaussian from its σ — the extractor derives fit.fwhmSeed this way,
// so a library that only has plot.sig gets the same seed it would have had.
const SIGMA_TO_FWHM = 2 * Math.sqrt(2 * Math.LN2);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string' && v.length > 0;

function defaultBaseUrl() {
  return new URL('../../data/libraries/', import.meta.url).href;
}

function joinUrl(base, file) {
  const b = String(base);
  return b.endsWith('/') ? b + file : b + '/' + file;
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`could not be fetched (${err && err.message ? err.message : err})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`is not valid JSON (${err.message})`);
  }
}

/**
 * Load every library listed in `index.json` under `baseUrl`.
 * Never throws: unreadable or invalid files are reported in `errors`.
 * @param {string|URL} [baseUrl] folder URL holding index.json (default: the app's data/libraries/)
 * @returns {Promise<{ libraries: object[], errors: string[], defaultId: string|null }>}
 *   libraries in manifest order; `defaultId` is the id of the manifest's default entry
 *   (or the first library loaded) — an addition to the contract for the UI's picker.
 */
export async function loadLibraries(baseUrl = defaultBaseUrl()) {
  const libraries = [];
  const errors = [];
  let defaultId = null;

  let manifest;
  try {
    manifest = await fetchJson(joinUrl(baseUrl, 'index.json'));
  } catch (err) {
    errors.push(`index.json ${err.message}`);
    return { libraries, errors, defaultId };
  }
  if (!isObj(manifest) || !Array.isArray(manifest.libraries)) {
    errors.push('index.json: expected { "libraries": [ { "file": … } ] }');
    return { libraries, errors, defaultId };
  }

  const seen = new Set();
  for (let i = 0; i < manifest.libraries.length; i++) {
    const entry = manifest.libraries[i];
    const file = isObj(entry) ? entry.file : entry;
    if (!isStr(file)) {
      errors.push(`index.json: libraries[${i}] has no file name`);
      continue;
    }
    let lib;
    try {
      lib = await fetchJson(joinUrl(baseUrl, file));
    } catch (err) {
      errors.push(`${file} ${err.message}`);
      continue;
    }
    const v = validateLibrary(lib);
    if (!v.ok) {
      for (const e of v.errors) errors.push(`${file}: ${e}`);
      continue;
    }
    // Two files with the same id would make the library picker ambiguous; the
    // first one listed wins so the manifest order stays authoritative.
    if (seen.has(lib.id)) {
      errors.push(`${file}: duplicate library id "${lib.id}" (already loaded)`);
      continue;
    }
    seen.add(lib.id);
    libraries.push(lib);
    if (isObj(entry) && entry.default === true && defaultId === null) defaultId = lib.id;
  }
  if (defaultId === null && libraries.length) defaultId = libraries[0].id;
  return { libraries, errors, defaultId };
}

function checkRange(range, path, errors) {
  if (!Array.isArray(range) || range.length !== 2 || !isNum(range[0]) || !isNum(range[1])) {
    errors.push(`${path}: expected [lo, hi] of two numbers`);
    return false;
  }
  if (range[0] > range[1]) {
    errors.push(`${path}: lo ${range[0]} is greater than hi ${range[1]}`);
    return false;
  }
  return true;
}

function checkSane(v, path, errors) {
  if (v < SANE_SHIFT[0] || v > SANE_SHIFT[1]) {
    errors.push(`${path}: ${v} cm⁻¹ is outside the plausible Raman range ${SANE_SHIFT[0]}–${SANE_SHIFT[1]} cm⁻¹`);
  }
}

function validateBand(b, i, refs, errors) {
  if (!isObj(b)) {
    errors.push(`bands[${i}]: expected an object`);
    return;
  }
  const p = `bands[${i}]${isStr(b.id) ? ` (${b.id})` : ''}`;
  for (const k of ['id', 'label', 'name', 'posText']) {
    if (!isStr(b[k])) errors.push(`${p}.${k}: required non-empty string`);
  }
  if (b.region !== 'first' && b.region !== 'second') {
    errors.push(`${p}.region: must be "first" or "second"`);
  }
  if (!isNum(b.posSort)) errors.push(`${p}.posSort: required number`);
  else checkSane(b.posSort, `${p}.posSort`, errors);

  const m = b.match;
  if (!isObj(m)) {
    errors.push(`${p}.match: required object with range, center, dispersion`);
  } else {
    const rangeOk = checkRange(m.range, `${p}.match.range`, errors);
    if (rangeOk) {
      checkSane(m.range[0], `${p}.match.range[0]`, errors);
      checkSane(m.range[1], `${p}.match.range[1]`, errors);
    }
    if (!isNum(m.center)) {
      errors.push(`${p}.match.center: required number`);
    } else {
      checkSane(m.center, `${p}.match.center`, errors);
      // The matcher measures confidence outward from the centre to each window
      // edge; a centre outside its own range would give a negative half-width.
      if (rangeOk && (m.center < m.range[0] || m.center > m.range[1])) {
        errors.push(`${p}.match.center: ${m.center} lies outside match.range [${m.range[0]}, ${m.range[1]}]`);
      }
    }
    const d = m.dispersion;
    if (!isObj(d)) {
      errors.push(`${p}.match.dispersion: required object with cmPerEV (number or null)`);
    } else {
      if (!(d.cmPerEV === null || isNum(d.cmPerEV))) errors.push(`${p}.match.dispersion.cmPerEV: must be a number or null`);
      if (d.widenWindow !== undefined && typeof d.widenWindow !== 'boolean') {
        errors.push(`${p}.match.dispersion.widenWindow: must be true or false`);
      }
    }
  }
  if (b.fit !== undefined) {
    if (!isObj(b.fit)) errors.push(`${p}.fit: expected an object`);
    else if (b.fit.fwhmSeed !== undefined && !(isNum(b.fit.fwhmSeed) && b.fit.fwhmSeed > 0)) {
      errors.push(`${p}.fit.fwhmSeed: must be a positive number`);
    }
  }
  if (b.refs !== undefined) {
    if (!Array.isArray(b.refs)) {
      errors.push(`${p}.refs: expected an array of reference keys`);
    } else {
      for (const k of b.refs) {
        if (!refs || !Object.prototype.hasOwnProperty.call(refs, k)) {
          errors.push(`${p}.refs: "${k}" is not a key in references`);
        }
      }
    }
  }
}

/**
 * Check a parsed library against the essentials of data/libraries/schema.json.
 * Not a full JSON-Schema validator — it checks what the app relies on: required
 * fields, numeric band ranges with lo ≤ hi inside a plausible Raman range, and
 * that every cross-reference (band refs, ratio cards, ratioMap band ids) resolves.
 * @param {*} obj parsed JSON
 * @returns {{ ok: boolean, errors: string[] }} errors carry a path, e.g. "bands[3] (G).match.range: …"
 */
export function validateLibrary(obj) {
  const errors = [];
  if (!isObj(obj)) return { ok: false, errors: ['library must be a JSON object'] };

  if (obj.schema !== SCHEMA_ID) errors.push(`schema: expected "${SCHEMA_ID}", got ${JSON.stringify(obj.schema)}`);
  if (!isStr(obj.id)) errors.push('id: required non-empty string');
  else if (!/^[a-z0-9-]+$/.test(obj.id)) errors.push(`id: "${obj.id}" must use only a–z, 0–9 and "-"`);
  if (!isStr(obj.name)) errors.push('name: required non-empty string');

  let refs = null;
  if (obj.references !== undefined) {
    if (!isObj(obj.references)) {
      errors.push('references: expected an object of key → { c: citation }');
    } else {
      refs = obj.references;
      for (const [k, r] of Object.entries(refs)) {
        if (!isObj(r) || typeof r.c !== 'string') errors.push(`references.${k}: needs a "c" citation string`);
      }
    }
  }

  if (obj.referenceExcitation !== undefined) {
    const re = obj.referenceExcitation;
    if (!isObj(re) || !(re.nm === null || (isNum(re.nm) && re.nm > 0))) {
      errors.push('referenceExcitation.nm: must be a positive wavelength in nm or null');
    }
  }
  if (obj.matchDefaults !== undefined) {
    const md = obj.matchDefaults;
    if (!isObj(md)) errors.push('matchDefaults: expected an object');
    else {
      for (const k of ['toleranceCm', 'unknownDispersionAllowanceCmPerEV']) {
        if (md[k] !== undefined && !(isNum(md[k]) && md[k] >= 0)) errors.push(`matchDefaults.${k}: must be a number ≥ 0`);
      }
    }
  }
  if (obj.fitDefaults !== undefined) {
    const fd = obj.fitDefaults;
    if (!isObj(fd)) errors.push('fitDefaults: expected an object');
    else {
      for (const k of ['fwhmMin', 'fwhmMax']) {
        if (fd[k] !== undefined && !(isNum(fd[k]) && fd[k] > 0)) errors.push(`fitDefaults.${k}: must be a number > 0`);
      }
      if (isNum(fd.fwhmMin) && isNum(fd.fwhmMax) && fd.fwhmMin > fd.fwhmMax) {
        errors.push(`fitDefaults: fwhmMin ${fd.fwhmMin} is greater than fwhmMax ${fd.fwhmMax}`);
      }
      if (fd.gaussianPercentSeed !== undefined && !(isNum(fd.gaussianPercentSeed) && fd.gaussianPercentSeed >= 0 && fd.gaussianPercentSeed <= 100)) {
        errors.push('fitDefaults.gaussianPercentSeed: must be between 0 and 100');
      }
      if (fd.windowPadCm !== undefined && !(isNum(fd.windowPadCm) && fd.windowPadCm >= 0)) {
        errors.push('fitDefaults.windowPadCm: must be a number ≥ 0');
      }
    }
  }

  const bandIds = new Set();
  if (!Array.isArray(obj.bands) || obj.bands.length === 0) {
    errors.push('bands: required non-empty array');
  } else {
    obj.bands.forEach((b, i) => {
      validateBand(b, i, refs, errors);
      if (isObj(b) && isStr(b.id)) {
        if (bandIds.has(b.id)) errors.push(`bands[${i}].id: duplicate band id "${b.id}"`);
        bandIds.add(b.id);
      }
    });
  }

  if (obj.regions !== undefined) {
    if (!Array.isArray(obj.regions)) errors.push('regions: expected an array');
    else {
      obj.regions.forEach((r, i) => {
        if (!isObj(r)) { errors.push(`regions[${i}]: expected an object`); return; }
        if (!isStr(r.id)) errors.push(`regions[${i}].id: required non-empty string`);
        if (!isStr(r.label)) errors.push(`regions[${i}].label: required non-empty string`);
        checkRange(r.range, `regions[${i}].range`, errors);
      });
    }
  }

  let nCards = null;
  if (obj.ratios !== undefined) {
    if (!Array.isArray(obj.ratios)) errors.push('ratios: expected an array of ratio cards');
    else {
      nCards = obj.ratios.length;
      obj.ratios.forEach((r, i) => {
        if (!isObj(r) || typeof r.n !== 'string') errors.push(`ratios[${i}]: needs an "n" (name) string`);
        if (isObj(r) && Array.isArray(r.refs)) {
          for (const k of r.refs) {
            if (!refs || !Object.prototype.hasOwnProperty.call(refs, k)) errors.push(`ratios[${i}].refs: "${k}" is not a key in references`);
          }
        }
      });
    }
  }

  if (obj.ratioMap !== undefined) {
    if (!Array.isArray(obj.ratioMap)) errors.push('ratioMap: expected an array');
    else {
      obj.ratioMap.forEach((e, i) => {
        const p = `ratioMap[${i}]`;
        if (!isObj(e)) { errors.push(`${p}: expected an object`); return; }
        if (!Number.isInteger(e.ratioIndex) || e.ratioIndex < 0) errors.push(`${p}.ratioIndex: must be an integer ≥ 0`);
        else if (nCards === null) errors.push(`${p}.ratioIndex: library has no ratios array to point into`);
        else if (e.ratioIndex >= nCards) errors.push(`${p}.ratioIndex: ${e.ratioIndex} but there are only ${nCards} ratio cards`);
        for (const k of ['num', 'den']) {
          if (!isStr(e[k])) errors.push(`${p}.${k}: required band id`);
          else if (bandIds.size && !bandIds.has(e[k])) errors.push(`${p}.${k}: "${e[k]}" is not a band id`);
        }
        if (!Array.isArray(e.measures) || !e.measures.length || e.measures.some(m => m !== 'height' && m !== 'area')) {
          errors.push(`${p}.measures: expected a non-empty array of "height" / "area"`);
        }
        if (e.classify !== undefined) {
          const c = e.classify;
          if (!isObj(c) || !Array.isArray(c.values) || !c.values.length || !c.values.every(isNum)) {
            errors.push(`${p}.classify.values: expected a non-empty array of numbers`);
          } else if (!Array.isArray(c.labels) || c.labels.length !== c.values.length) {
            errors.push(`${p}.classify.labels: expected one label per value`);
          }
        }
      });
    }
  }

  if (obj.workflow !== undefined && (!Array.isArray(obj.workflow) || obj.workflow.some(s => typeof s !== 'string'))) {
    errors.push('workflow: expected an array of strings');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Shift a library's bands for the selected laser and build their match windows.
 * Bands with a stated rate move by cmPerEV × (E(laser) − E(ref)); bands whose rate
 * the source doesn't give (dispersion.widenWindow) stay put but get a wider window,
 * matchDefaults.unknownDispersionAllowanceCmPerEV × |ΔE| on each side.
 * @param {object} lib a validated library
 * @param {{ laserNm?: number|null, toleranceCm?: number }} [opts] laserNm defaults to the
 *   library's reference excitation (no shift); toleranceCm defaults to matchDefaults.toleranceCm
 * @returns {{ library: object, laserNm: number|null, referenceNm: number|null, deltaEV: number,
 *   toleranceCm: number, bands: object[], regions: object[] }} bands are PreparedBand objects
 */
export function prepareLibrary(lib, { laserNm = null, toleranceCm } = {}) {
  if (!isObj(lib) || !Array.isArray(lib.bands)) throw new Error('Not a band library (no bands array).');
  const referenceNm = isObj(lib.referenceExcitation) && isNum(lib.referenceExcitation.nm) ? lib.referenceExcitation.nm : null;

  let laser = laserNm;
  if (laser === null || laser === undefined || laser === '') laser = referenceNm;
  else {
    laser = Number(laser);
    if (!Number.isFinite(laser) || laser <= 0) throw new Error(`Laser wavelength must be a positive number of nanometres (got ${laserNm}).`);
  }

  const md = isObj(lib.matchDefaults) ? lib.matchDefaults : {};
  let tol = toleranceCm;
  if (tol === null || tol === undefined) tol = isNum(md.toleranceCm) ? md.toleranceCm : FALLBACK_TOLERANCE_CM;
  tol = Number(tol);
  if (!Number.isFinite(tol) || tol < 0) throw new Error(`Match tolerance must be a number ≥ 0 cm⁻¹ (got ${toleranceCm}).`);
  const allowance = isNum(md.unknownDispersionAllowanceCmPerEV) ? md.unknownDispersionAllowanceCmPerEV : 0;

  // Without a reference wavelength there is nothing to shift against, so the
  // positions are used as written (ΔE = 0) rather than guessed.
  const dE = referenceNm !== null && laser !== null ? photonEnergyEV(laser) - photonEnergyEV(referenceNm) : 0;
  const deltaEV = Number.isFinite(dE) ? dE : 0;

  const bands = lib.bands.map(b => {
    const m = b.match || {};
    const disp = m.dispersion || {};
    const shift = deltaEV === 0 ? 0 : dispersionShift(disp.cmPerEV, laser, referenceNm);
    const widen = disp.widenWindow ? allowance * Math.abs(deltaEV) : 0;
    const r = Array.isArray(m.range) ? m.range : [b.posSort, b.posSort];
    const centre = isNum(m.center) ? m.center : b.posSort;
    const range = [r[0] + shift, r[1] + shift];
    const window = [range[0] - tol - widen, range[1] + tol + widen];
    let fwhmSeed = b.fit && isNum(b.fit.fwhmSeed) ? b.fit.fwhmSeed : null;
    if (fwhmSeed === null && b.plot && isNum(b.plot.sig)) fwhmSeed = b.plot.sig * SIGMA_TO_FWHM;
    // Last resort so the fitter always has a finite starting width: half the
    // match window is a neutral guess that keeps the component inside it.
    if (fwhmSeed === null) fwhmSeed = (window[1] - window[0]) / 2;
    const dispersion = { cmPerEV: disp.cmPerEV === undefined ? null : disp.cmPerEV, stated: !!disp.stated };
    if (disp.widenWindow !== undefined) dispersion.widenWindow = !!disp.widenWindow;
    return {
      id: b.id, label: b.label, name: b.name, order: b.region,
      center: centre + shift, shift, range, window, widen,
      fwhmSeed, dispersion, band: b,
    };
  });

  // Regions (sp³ C–H stretching) are bond vibrations, not double-resonance
  // phonons, so they are not dispersion-shifted.
  const regions = (Array.isArray(lib.regions) ? lib.regions : []).map(r => ({
    id: r.id, label: r.label, name: r.name || r.label, kind: r.kind || null,
    range: Array.isArray(r.range) ? [r.range[0], r.range[1]] : [NaN, NaN], text: r.text || '', region: r,
  }));

  return { library: lib, laserNm: laser, referenceNm, deltaEV, toleranceCm: tol, bands, regions };
}
