/* Intensity ratios from the library's ratio cards.

   Which bands make up each ratio comes from library.ratioMap; names, titles and
   the classification values come verbatim from the atlas cards, so nothing here
   is graphene-specific except the extras the ratioMap asks for by name.

   Height source policy: fitted heights (deconvolution separates overlapping
   bands, e.g. D′ under the G shoulder) win over detected apex heights, but a
   ratio never mixes the two — a fitted G against a raw-apex D would compare a
   baseline-free component with an overlap-inflated maximum. Areas exist only for
   fitted components; a detected peak has no defensible area. */

import { photonEnergyEV } from '../match/dispersion.js';
import { matchPeaks } from '../match/matcher.js';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

function asComponents(components) {
  if (Array.isArray(components)) return components;
  // Accept a whole Deconvolution object too — callers often have that in hand.
  if (components && Array.isArray(components.components)) return components.components;
  return [];
}

/**
 * Per-band measurement lookups shared by computeRatios and evaluateWorkflow
 * (an addition to the contract, exported so both read bands the same way).
 * @param {object} prepared result of prepareLibrary
 * @param {{ assignments?: object[], peaks?: object[], components?: object[] }} [data]
 * @returns {{ comps: object[], peaks: object[], assignments: object[], fitRun: boolean,
 *   bandLabel: (id: string) => string, component: (id: string) => object|null,
 *   fitted: (id: string) => object|null, detected: (id: string) => object|null }}
 *   fitted = significant component with a finite h; detected = peak assigned to the band
 */
export function bandSources(prepared, { assignments, peaks, components } = {}) {
  const comps = asComponents(components);
  const peakList = Array.isArray(peaks) ? peaks : [];
  let asg = Array.isArray(assignments) ? assignments : null;
  if (!asg && peakList.length && prepared) asg = matchPeaks(peakList, prepared);
  asg = asg || [];

  const byId = new Map();
  for (const p of peakList) if (p && p.id !== undefined) byId.set(p.id, p);

  const bandLabel = id => {
    const pb = prepared && Array.isArray(prepared.bands) ? prepared.bands.find(b => b.id === id) : null;
    if (pb) return pb.label;
    const lb = prepared && prepared.library && Array.isArray(prepared.library.bands) ? prepared.library.bands.find(b => b.id === id) : null;
    return lb ? lb.label : id;
  };

  /** Best component for a band: significant beats insignificant, then larger h. */
  const component = id => {
    let best = null;
    for (const c of comps) {
      if (!c || c.bandId !== id) continue;
      if (!best || (!!c.significant > !!best.significant) || (!!c.significant === !!best.significant && (c.h || 0) > (best.h || 0))) best = c;
    }
    return best;
  };
  const fitted = id => {
    const c = component(id);
    return c && c.significant && isNum(c.h) ? c : null;
  };
  /** Detected peak assigned to the band (largest if a caller passed duplicates). */
  const detected = id => {
    let best = null;
    asg.forEach((a, i) => {
      if (!a || a.kind !== 'band' || a.bandId !== id) return;
      let p = a.peakId !== null && a.peakId !== undefined ? byId.get(a.peakId) : undefined;
      // Assignments come back in peak order, so the index is a safe fallback when ids are absent.
      if (!p && asg.length === peakList.length) p = peakList[i];
      if (!p || !isNum(p.y)) return;
      if (!best || p.y > best.y) best = p;
    });
    return best;
  };
  return { comps, peaks: peakList, assignments: asg, fitRun: comps.length > 0, bandLabel, component, fitted, detected };
}

function reasonFor(src, id) {
  const L = src.bandLabel(id);
  const c = src.component(id);
  if (c && !c.significant) return `${L} fit component not significant`;
  if (!c && src.fitRun) return `${L} not in the fitted range`;
  return `${L} not resolved — run Deconvolve`;
}

function nearestClass(value, classify) {
  let k = 0;
  for (let i = 1; i < classify.values.length; i++) {
    if (Math.abs(value - classify.values[i]) < Math.abs(value - classify.values[k])) k = i;
  }
  return { nearest: classify.values[k], label: classify.labels ? classify.labels[k] : String(classify.values[k]), value };
}

function width(src, id) {
  const c = src.fitted(id);
  if (c && isNum(c.w)) return { value: Math.abs(c.w), source: 'fit' };
  const p = src.detected(id);
  if (p && isNum(p.fwhm)) return { value: p.fwhm, source: 'detected' };
  return null;
}

/**
 * Compute every ratio card the library maps (library.ratioMap).
 * @param {object} prepared result of prepareLibrary
 * @param {{ assignments?: object[], peaks?: object[], components?: object[], laserNm?: number }} [data]
 *   assignments default to matchPeaks(peaks, prepared); laserNm defaults to prepared.laserNm
 * @returns {object[]} RatioResult per ratioMap entry:
 *   { ratioIndex, name, title, num, den,
 *     height: { value, source: 'fit'|'detected', numValue, denValue } | null,
 *     area: { value, numValue, denValue } | null,
 *     classify?: { nearest, label, value } | null,
 *     extras: { crystalliteSize?: [{ basis, valueNm, El }], gWidth?, gWidthSource?, twoDWidth?, twoDWidthSource? },
 *     missing: string[] }
 *   gWidth / twoDWidth are FWHMs in cm⁻¹; the *Source keys ('fit'|'detected') are additions to the contract.
 */
export function computeRatios(prepared, { assignments, peaks, components, laserNm } = {}) {
  const lib = prepared && prepared.library;
  if (!lib || !Array.isArray(lib.ratioMap)) return [];
  const src = bandSources(prepared, { assignments, peaks, components });
  const laser = isNum(laserNm) && laserNm > 0 ? laserNm : (prepared && isNum(prepared.laserNm) ? prepared.laserNm : null);
  const cards = Array.isArray(lib.ratios) ? lib.ratios : [];

  return lib.ratioMap.map(entry => {
    const card = cards[entry.ratioIndex] || {};
    const { num, den } = entry;
    const measures = Array.isArray(entry.measures) ? entry.measures : [];
    const extrasWanted = Array.isArray(entry.extras) ? entry.extras : [];
    const missing = [];
    const miss = m => { if (m && !missing.includes(m)) missing.push(m); };

    let height = null;
    if (measures.includes('height')) {
      const fn = src.fitted(num), fd = src.fitted(den);
      const dn = src.detected(num), dd = src.detected(den);
      let pair = null;
      if (fn && fd) pair = { n: fn.h, d: fd.h, source: 'fit' };
      else if (dn && dd) pair = { n: dn.y, d: dd.y, source: 'detected' };
      if (pair) {
        if (pair.d > 0) height = { value: pair.n / pair.d, source: pair.source, numValue: pair.n, denValue: pair.d };
        else miss(`${src.bandLabel(den)} height is zero`);
      } else {
        // Name the band(s) with nothing usable; if each has *something* the
        // sources just don't agree, so point at the band lacking a fit.
        const bare = [num, den].filter(id => !src.fitted(id) && !src.detected(id));
        const blame = bare.length ? bare : [num, den].filter(id => !src.fitted(id));
        for (const id of blame) miss(reasonFor(src, id));
      }
    }

    let area = null;
    if (measures.includes('area')) {
      const fn = src.fitted(num), fd = src.fitted(den);
      if (fn && fd && isNum(fn.area) && isNum(fd.area)) {
        if (fd.area > 0) area = { value: fn.area / fd.area, numValue: fn.area, denValue: fd.area };
        else miss(`${src.bandLabel(den)} area is zero`);
      } else if (!src.fitRun) {
        miss('Areas need a fit — run Deconvolve');
      } else {
        for (const id of [num, den]) if (!src.fitted(id)) miss(reasonFor(src, id));
      }
    }

    const result = {
      ratioIndex: entry.ratioIndex,
      name: card.n !== undefined ? card.n : `${num} / ${den}`,
      title: card.t !== undefined ? card.t : '',
      num, den, height, area,
      extras: {},
      missing,
    };

    if (entry.classify && Array.isArray(entry.classify.values)) {
      // The atlas classification values are intensity (peak-height) ratios.
      result.classify = height ? nearestClass(height.value, entry.classify) : null;
    }

    if (extrasWanted.includes('crystalliteSize')) {
      const El = photonEnergyEV(laser);
      const sizes = [];
      if (!Number.isFinite(El)) {
        if (height || area) miss('Lₐ needs the laser wavelength');
      } else {
        // Cançado 2011 as quoted on the atlas card: Lₐ[nm] = (560 / E_l⁴) · (I_D/I_G)⁻¹.
        const k = 560 / Math.pow(El, 4);
        if (height && height.value > 0) sizes.push({ basis: 'height', valueNm: k / height.value, El });
        if (area && area.value > 0) sizes.push({ basis: 'area', valueNm: k / area.value, El });
      }
      if (sizes.length) result.extras.crystalliteSize = sizes;
    }
    if (extrasWanted.includes('gWidth')) {
      const w = width(src, 'G');
      if (w) { result.extras.gWidth = w.value; result.extras.gWidthSource = w.source; }
      else miss(`${src.bandLabel('G')} FWHM not available`);
    }
    if (extrasWanted.includes('twoDWidth')) {
      const w = width(src, 'twoD');
      if (w) { result.extras.twoDWidth = w.value; result.extras.twoDWidthSource = w.source; }
      else miss(`${src.bandLabel('twoD')} FWHM not available`);
    }
    return result;
  });
}
