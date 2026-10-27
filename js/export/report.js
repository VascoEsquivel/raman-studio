// One-page printable report: figure, peak table, ratios and the atlas reading.
// Rendered into #report (hidden on screen) and printed via print.css.

import { esc, fmt, fmtPm, fmtX, fmtSigned, richText } from '../ui/dom.js';

/**
 * @param {HTMLElement} el   the #report element
 * @param {object} r  { svg, spectrumName, laserNm, refText, library, items, ratios, workflow, deconv, settingsText, dateText,
 *   acqText?, qualityText? }
 */
/** Reference-list candidates for unassigned peaks, when a private list was loaded. */
function candText(r) {
  if (!r.refListName) return '';
  const rows = (r.items || []).filter(it => it.tier !== 'fit' && it.refCands && it.refCands.length)
    .map(it => `${fmtX(it.x)} → ${it.refCands.map(c => `${esc(c.material)} ${fmt(c.position, 5)} (${fmtSigned(c.delta)})`).join(', ')}`);
  return `Reference-list candidates (${esc(r.refListName)}; position coincidences, not identifications): ${rows.length ? rows.join('; ') : 'none'}.<br>`;
}

export function fillReport(el, r) {
  const lib = r.library;
  // One row per band: detected position/match score merged with the fitted
  // width/area, so a deconvolved spectrum still fits on one page.
  const groups = new Map();
  for (const it of r.items) {
    const key = it.bandId ? 'b:' + it.bandId : 'p:' + it.id;
    const g = groups.get(key) || { det: null, fit: null };
    if (it.tier === 'fit') g.fit = it; else g.det = g.det || it;
    groups.set(key, g);
  }
  const rows = [...groups.values()].map(({ det, fit }) => {
    const it = det || fit;
    const src = det && fit ? 'det. + fit' : det ? (det.tier === 'manual' ? 'manual' : 'detected') : 'fit';
    return `<tr>
    <td class="sym ${det ? '' : 'fit'}">${esc(it.sym)}</td>
    <td class="n">${fmtX(it.x)}</td><td class="n">${it.delta != null ? fmtSigned(it.delta) : '—'}</td>
    <td class="n">${fmt(it.height, 3)}</td><td class="n">${fmt(fit ? fit.fwhm : it.fwhm, 3)}</td>
    <td class="n">${fit && fit.area != null ? fmt(fit.area, 3) : '—'}</td>
    <td class="n">${det && det.kind !== 'unassigned' && det.kind !== 'region' ? (det.confidence || 0).toFixed(2) : '—'}</td>
    <td>${src}</td></tr>`;
  }).join('');
  const ratioRows = (r.ratios || []).map(x => `<tr><td>${esc(x.name)}</td>
    <td class="n">${x.height ? fmtPm(x.height.value, x.height.se) : '—'}</td><td class="n">${x.area ? fmtPm(x.area.value, x.area.se) : '—'}</td>
    <td>${[
      ...(x.extras?.crystalliteSize || []).map(c => `L<sub>a</sub> ${fmtPm(c.valueNm, c.se)} nm (${c.basis})`),
      x.classify?.label ? `≈${esc(String(x.classify.nearest))}: ${esc(x.classify.label)}` : '',
      x.extras?.twoDWidth != null ? `2D FWHM ${fmt(x.extras.twoDWidth, 3)} cm⁻¹` : '',
      x.extras?.gWidth != null ? `G FWHM ${fmt(x.extras.gWidth, 3)} cm⁻¹` : '',
    ].filter(Boolean).join(' · ')}</td></tr>`).join('');
  const wf = r.workflow;
  // The atlas step behind the reading, with its evidence; the ratios table carries the numbers.
  const best = wf && wf.summary ? wf.steps.find(st => st.index === wf.summary.stepIndex) : null;
  const steps = best ? `<li><b>Step ${best.index + 1}.</b> ${richText(best.html)}${best.evidence && best.evidence.length ? `<br><span class="ev">${best.evidence.map(esc).join(' · ')}</span>` : ''}</li>` : '';
  const labelOf = id => (lib.bands.find(b => b.id === id) || {}).label || id;
  const setLine = w => (w.selection ? `, band set by BIC: ${w.bandIds.map(labelOf).join(', ')}${w.selection.runnerUp ? ` (runner-up within ΔBIC ${fmt(w.selection.runnerUp.dBic, 2)}: ${w.selection.runnerUp.kept.length ? 'with ' + w.selection.runnerUp.kept.map(labelOf).join(', ') : 'no optional band'})` : ''}` : '');
  const fitLine = r.deconv ? r.deconv.windows.map(w => `${fmt(w.lo, 4)}–${fmt(w.hi, 4)} cm⁻¹: quality ${isFinite(w.stats?.quality) ? w.stats.quality.toFixed(2) : '—'}× noise, R² ${isFinite(w.stats?.r2) ? w.stats.r2.toFixed(4) : '—'}${setLine(w)}`).join(' · ') : 'not run';

  el.innerHTML = `
    <header class="rp-head">
      <div><div class="rp-kicker">Raman Studio · spectrum report</div><h1>${esc(r.spectrumName)}</h1></div>
      <div class="rp-meta">${esc(r.dateText)}<br>λ<sub>ex</sub> ${r.laserNm} nm · library ${esc(lib.name)}</div>
    </header>
    <figure class="rp-fig">${r.svg}</figure>
    ${wf && wf.summary && wf.summary.text ? `<p class="rp-reading"><b>Reading:</b> ${richText(wf.summary.text)}</p>` : ''}
    <section class="rp-cols">
      <div>
        <h2>Peaks</h2>
        <table class="rp-table"><thead><tr><th>Band</th><th>cm⁻¹</th><th>Δ</th><th>Height</th><th>FWHM</th><th>Area</th><th>Match</th><th>Source</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No peaks</td></tr>'}</tbody></table>
      </div>
      <div>
        <h2>Intensity ratios</h2>
        <table class="rp-table"><thead><tr><th>Ratio</th><th>Height</th><th>Area</th><th>Notes</th></tr></thead><tbody>${ratioRows}</tbody></table>
        <h2>Atlas reading</h2>
        <ul class="rp-steps">${steps || '<li>No identification step matched yet.</li>'}</ul>
      </div>
    </section>
    <footer class="rp-foot">
      ${r.acqText ? `Acquisition: ${esc(r.acqText)}.<br>` : ''}${r.calText ? `Wavenumber calibration: ${esc(r.calText)}.<br>` : ''}${candText(r)}${r.qualityText ? `Quality: ${esc(r.qualityText)}<br>` : ''}Processing: ${esc(r.settingsText)}. Deconvolution: ${esc(fitLine)}.<br>
      Match: the position score of a detected peak in its atlas window (1 at the band centre, about 0.14 at the window edge), a distance measure, not a probability.<br>
      Ratio ± values: fit-model standard uncertainty (1σ, from the fit covariance); noise for the fitted bands only, not the choice of bands or baseline, and not a probability.<br>
      Band assignments from the Raman graphene / graphene-oxide atlas (${esc(lib.source?.url || '')}${lib.source?.commit ? ', commit ' + esc(lib.source.commit.slice(0, 7)) : ''}). Atlas positions assume ${esc(r.refText)}.
      Fitting uses PeakForge's WiRE-compatible pseudo-Voigt and Levenberg–Marquardt fitter. Peak positions shift with excitation, strain, doping, layer number and oxidation: calibrate against a standard.
    </footer>`;
}
