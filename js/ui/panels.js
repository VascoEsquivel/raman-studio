// Side-deck panes: peak list, ratio guide, read-your-spectrum, fit report,
// and the atlas band explainer. Pure render functions over a view model built
// in main.js; event handling is delegated by main.js via data-* attributes.

import { esc, fmt, fmtPm, fmtX, fmtSigned, richText, plainText } from './dom.js';
import { peakType } from '../fit/profile.js';
import { RAMP, rampColor } from '../analysis/map.js';

const STATUS_GLYPH = { match: '✓', partial: '◐', no: '✕', info: 'i', insufficient: '…' };
/** The matcher's confidence is a position score, never shown as a percentage (it is not a probability). */
const SCORE_TIP = 'Position-match score: 1 at the atlas band centre, about 0.14 at the window edge. A distance measure, not a probability.';
const score = c => (c || 0).toFixed(2);

function refChips(lib, keys) {
  if (!keys || !keys.length) return '';
  return keys.map(k => {
    const r = lib.references && lib.references[k];
    if (!r) return '';
    const yr = (r.c.match(/\((\d{4})\)/) || [])[1] || '';
    const label = esc(r.c.split('(')[0].trim() + (yr ? ' ' + yr : ''));
    return r.u
      ? `<a class="ref" href="${esc(r.u)}" target="_blank" rel="noopener noreferrer" title="${esc(r.c)}">${label}${r.n ? ' ■' : ''}</a>`
      : `<span class="ref" title="${esc(r.c)}">${label}${r.n ? ' ■' : ''}</span>`;
  }).join('');
}

function tagClass(item) {
  return item.kind === 'fit' ? 'fit' : item.kind === 'unassigned' ? 'unassigned' : item.kind === 'region' ? 'region' : '';
}

// ------------------------------------------------------------------ peaks
export function renderPeaks(el, vm) {
  if (!vm.hasData) { el.innerHTML = `<div class="empty">Load a spectrum to see its peaks.</div>`; return; }
  const items = vm.items;
  const tier1 = items.filter(i => i.tier !== 'fit');
  const tier2 = items.filter(i => i.tier === 'fit');
  const assigned = tier1.filter(i => i.kind === 'detected').length;
  const row = it => {
    const conf = it.confidence != null && it.kind !== 'unassigned' ? Math.round(it.confidence * 100) : null;
    const nums = [`<b>${fmtX(it.x)}</b> cm⁻¹`];
    if (it.delta != null && isFinite(it.delta)) nums.push(`Δ ${fmtSigned(it.delta)}`);
    if (it.fwhm != null && isFinite(it.fwhm)) nums.push(`FWHM ${fmt(it.fwhm, 3)}`);
    if (it.tier === 'fit' && it.area != null) nums.push(`A ${fmt(it.area, 3)}`);
    else if (it.height != null) nums.push(`h ${fmt(it.height, 3)}`);
    return `<div class="prow${it.id === vm.selectedId ? ' sel' : ''}" data-select="${esc(it.id)}">
      <span class="ptag ${tagClass(it)}">${esc(it.sym)}</span>
      <div class="pinfo"><div class="pname">${esc(it.name)}</div><div class="pnums">${nums.join(' · ')}</div>${candLine(it)}</div>
      <div class="pside">${conf != null ? `<span class="pane-meta" title="${SCORE_TIP}">score ${score(it.confidence)}</span><span class="conf" title="${SCORE_TIP}"><i style="width:${conf}%"></i></span>` : `<span class="pane-meta">${esc(it.tierText)}</span>`}
      ${it.tier !== 'fit' ? `<button class="x" data-delete="${esc(it.id)}" title="Remove this peak (Del)">×</button>` : ''}</div>
    </div>`;
  };
  el.innerHTML = `
    <div class="pane-head"><h2 class="pane-title">Detected peaks</h2><span class="pane-meta">${tier1.length} found · ${assigned} assigned</span></div>
    ${refBox(vm)}
    ${tier1.length ? `<div class="peaklist">${tier1.map(row).join('')}</div>` : `<div class="empty">No peaks above the current sensitivity. Raise <b>Detect</b> sensitivity in the chain below the plot.</div>`}
    ${tier2.length ? `<div class="pane-head" style="margin-top:18px"><h2 class="pane-title">Resolved by deconvolution</h2><span class="pane-meta">${tier2.length} bands</span></div><div class="peaklist">${tier2.map(row).join('')}</div>` : ''}
    <div class="tiers"><span><i></i>detected maximum</span><span><i class="fit"></i>fit-resolved band</span><span><i class="un"></i>unassigned</span></div>
    <p class="empty" style="padding-top:10px">Double-click the plot to add a peak by hand · <kbd>Del</kbd> removes the selected one · <kbd>[</kbd> <kbd>]</kbd> step through labels.</p>
    ${vm.refList ? '' : `<p class="empty" style="padding-top:4px"><button class="btn ghost" data-action="refload">Load a reference list…</button> candidate positions for unassigned peaks from your own JSON list, kept in this browser session only.</p>`}`;
}

/** Candidates from the private reference list for an unassigned peak (position coincidences, not identifications). */
function candLine(it) {
  if (!it.refCands || !it.refCands.length) return '';
  return `<div class="pcand" title="Within the reference list's tolerance of a listed band: a candidate, not an identification">candidates: ${it.refCands.map(c => `${esc(c.material)} ${fmt(c.position, 5)} (Δ ${fmtSigned(c.delta)})`).join(' · ')}</div>`;
}

/** The loaded reference list: tolerance, and the materials whose listed bands line up with unassigned peaks. */
function refBox(vm) {
  const L = vm.refList;
  if (!L) return '';
  const rows = L.summary.slice(0, 8).map(m => `<div class="refrow"><b>${esc(m.name)}</b>${m.role ? ` <span class="pane-meta">${esc(m.role)}</span>` : ''}
    · ${m.matched.length} of ${m.total} listed band${m.total === 1 ? '' : 's'} near a peak (${m.matched.map(q => `${fmt(q.position, 5)} → ${fmtX(q.x)}`).join(', ')})${m.source ? ` · <a href="${esc(m.source.url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</div>`).join('');
  return `<div class="refbox">
    <div class="refhead"><span><b>${esc(L.name)}</b> · private reference list, ${L.count} materials</span>
      <label class="mrange">± <input data-reftol type="number" min="0.5" max="100" step="0.5" value="${L.toleranceCm}" aria-label="Candidate tolerance (cm⁻¹)"> cm⁻¹</label>
      <button class="btn ghost" data-action="refclear">Clear</button></div>
    <p class="dnote">Unassigned peaks within the tolerance of a listed band show that material as a <b>candidate</b>: a coincidence of position, not an identification; several bands of one material lining up is stronger evidence than one. Loaded for this session only and not saved in projects.${L.note ? ' ' + esc(L.note) : ''}</p>
    ${rows ? `<div class="reflist">${rows}</div>` : '<div class="okline">No listed band lies within the tolerance of an unassigned peak.</div>'}
  </div>`;
}

// ------------------------------------------------------------------ ratios
/** The same ratio from the runner-up band set, when it scored within the close-call margin. */
function runnerUpLine(vm, r) {
  const ru = vm.runnerUp;
  const q = ru && ru.ratios.find(x => x.ratioIndex === r.ratioIndex);
  if (!q || !(q.height?.source === 'fit' || q.area)) return '';
  const parts = [q.height?.source === 'fit' ? `height ${fmt(q.height.value, 3)}` : '', q.area ? `area ${fmt(q.area.value, 3)}` : ''].filter(Boolean);
  const same = (r.height?.source === 'fit' && q.height?.source === 'fit' && Math.abs(q.height.value - r.height.value) < 1e-9 * Math.abs(r.height.value || 1));
  return same ? '' : `<div class="rrun">Runner-up band set (ΔBIC +${fmt(ru.dBic, 2)}, ${esc(bandSetName(vm, ru.kept))}): ${parts.join(' · ')}</div>`;
}

/** "D*, D″ kept" / "no optional band" for a selection's kept list. */
function bandSetName(vm, kept) {
  const lab = id => (vm.library.bands.find(b => b.id === id) || {}).label || id;
  return kept.length ? `with ${kept.map(lab).join(', ')}` : 'no optional band';
}

export function renderRatios(el, vm) {
  if (!vm.hasData) { el.innerHTML = `<div class="empty">Ratios appear once a spectrum is loaded.</div>`; return; }
  const lib = vm.library;
  const PM_TIP = 'Fit-model standard uncertainty (1σ) from the fit covariance: noise for these fitted bands and line shapes only, not the choice of bands or baseline. Not a probability.';
  let anyPm = false;
  const pm = q => { if (q.se != null && isFinite(q.se)) anyPm = true; return fmtPm(q.value, q.se); };
  const cards = (vm.ratios || []).map(r => {
    const card = lib.ratios[r.ratioIndex] || {};
    const hv = r.height ? pm(r.height) : null, av = r.area ? pm(r.area) : null;
    const hasH = (lib.ratioMap[r.ratioIndex]?.measures || []).includes('height');
    const extras = [];
    const ex = r.extras || {};
    if (ex.crystalliteSize && ex.crystalliteSize.length) {
      extras.push('Cançado crystallite size L<sub>a</sub> (low-defect regime, atlas): ' + ex.crystalliteSize.map(c =>
        `<b class="mono">${fmtPm(c.valueNm, c.se)} nm</b> (${c.basis}, E<sub>l</sub> = ${fmt(c.El, 3)} eV)`).join(' · '));
    }
    if (ex.gWidth != null && isFinite(ex.gWidth)) extras.push(`G FWHM <b class="mono">${fmt(ex.gWidth, 3)} cm⁻¹</b> — broad G ⇒ amorphisation regime (atlas).`);
    if (ex.twoDWidth != null && isFinite(ex.twoDWidth)) extras.push(`2D FWHM <b class="mono">${fmt(ex.twoDWidth, 3)} cm⁻¹</b> (monolayer: single Lorentzian, 24–30 cm⁻¹).`);
    if (r.classify && r.classify.label) extras.push(`Nearest atlas reference: <b class="mono">≈ ${esc(String(r.classify.nearest))}</b> → <b>${esc(r.classify.label)}</b>`);
    return `<div class="rcard">
      <h4>${esc(r.name || card.n)}</h4><div class="rt">${richText(r.title || card.t)}</div>
      <div class="rvals">
        ${hasH ? `<div class="rval"><div class="k">Height</div><div class="v${hv ? '' : ' na'}"${r.height?.se != null ? ` title="${PM_TIP}"` : ''}>${hv || 'n/a'}</div><div class="s">${r.height ? esc(r.height.source) : ''}</div></div>` : ''}
        <div class="rval"><div class="k">Area</div><div class="v${av ? '' : ' na'}"${r.area?.se != null ? ` title="${PM_TIP}"` : ''}>${av || 'needs fit'}</div><div class="s">${r.area ? 'fit components' : ''}</div></div>
      </div>
      ${extras.length ? `<div class="rextra">${extras.join('<br>')}</div>` : ''}
      ${runnerUpLine(vm, r)}
      ${r.missing && r.missing.length ? `<div class="rmiss">${r.missing.map(esc).join(' · ')}</div>` : ''}
      <details class="atlas"><summary>Atlas guide</summary>
        <p>${richText(card.b)}</p>${(card.eqs || []).map(e => `<div class="eq">${richText(e)}</div>`).join('')}
        <p>${richText(card.note)}</p><div class="refs">${refChips(lib, card.refs)}</div></details>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="pane-head"><h2 class="pane-title">Intensity ratios</h2><span class="pane-meta">${vm.deconv ? 'fit + detection' : 'detection only'}</span></div>
    ${vm.deconv ? '' : `<p class="empty" style="padding:0 0 12px">Areas and hidden bands (D′, D*, D″) need <b>Deconvolve</b>.</p>`}
    ${cards || '<div class="empty">This library defines no ratios.</div>'}
    ${anyPm ? `<p class="source-note">± is a fit-model standard uncertainty (1σ, from the fit's covariance). It covers noise for the fitted bands and line shapes, not the choice of bands, line shape or baseline, which can move a ratio further. It is not a probability.</p>` : ''}`;
}

// ------------------------------------------------------------------ read
export function renderRead(el, vm) {
  if (!vm.hasData) { el.innerHTML = `<div class="empty">The atlas decision workflow runs on your numbers once a spectrum is loaded.</div>`; return; }
  const wf = vm.workflow;
  if (!wf) { el.innerHTML = '<div class="empty">No workflow for this library.</div>'; return; }
  const summary = wf.summary && wf.summary.text
    ? `<div class="reading"><div class="k">Reading</div><div class="v">${richText(wf.summary.text)}</div></div>`
    : `<div class="reading"><div class="k">Reading</div><div class="v">No pattern from steps 1–3 matches yet.${vm.deconv ? '' : ' Run <b>Deconvolve</b> to resolve D′, D* and D″.'}</div></div>`;
  el.innerHTML = `<div class="pane-head"><h2 class="pane-title">Read your spectrum</h2><span class="pane-meta">atlas workflow</span></div>
    ${summary}
    <div class="steps">${wf.steps.map(st => `
      <div class="step ${esc(st.status)}"><span class="st" title="${esc(st.status)}">${STATUS_GLYPH[st.status] || '·'}</span>
        <div class="txt">${richText(st.html)}${st.evidence && st.evidence.length ? `<ul class="ev">${st.evidence.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}</div></div>`).join('')}
    </div>
    <p class="source-note">Steps quoted from the atlas. Only numeric thresholds the atlas states are applied; other criteria are shown as measured numbers for you to judge.</p>`;
}

// ------------------------------------------------------------------ fit
function verdict(q) {
  if (!isFinite(q)) return ['', '—'];
  if (q < 1.15) return ['good', 'at the noise floor: nothing left to fit'];
  if (q < 1.6) return ['good', 'good: slight structure left in the residual'];
  if (q < 3) return ['fair', 'under-fitted: real structure remains'];
  return ['poor', 'poor: the model does not describe this region'];
}

/* PeakForge's stationarity test (relative χ² change < 1e-12) rarely trips on
   overlapped bands: χ² keeps creeping along the degenerate valley long after
   the residual reaches the noise. Say that, rather than "iteration limit". */
function convText(st) {
  if (/iteration limit/.test(st.conv || '') && isFinite(st.quality) && st.quality < 1.15) {
    return 'residual at the noise floor (χ² still creeping along overlapped bands)';
  }
  return st.conv || '';
}

/** Which band set the BIC chose for a window, the runner-up, and every candidate's ΔBIC. */
function selectionBlock(vm, w) {
  const s = w.selection;
  if (!s) return '';
  const lab = id => (vm.library.bands.find(b => b.id === id) || {}).label || id;
  const always = w.bandIds.filter(id => !s.optional.includes(id));
  const setOf = kept => vm.library.bands.map(b => b.id).filter(id => always.includes(id) || kept.includes(id)).map(lab).join(', ');
  const next = s.models[1];
  const tail = s.runnerUp
    ? ` · runner-up ${esc(setOf(s.runnerUp.kept))} (ΔBIC +${fmt(s.runnerUp.dBic, 2)}): the data barely prefer one over the other (ΔBIC < ${fmt(s.closeCall, 2)}, Kass & Raftery 1995), so its ratios are shown on the Ratios tab too`
    : next ? ` · next best ΔBIC +${fmt(next.dBic, 3)}` : '';
  const rows = s.models.map(m => `<tr><td class="lab">${esc(setOf(m.kept))}</td><td>${m.k}</td><td>${m.dBic === 0 ? 'chosen' : '+' + fmt(m.dBic, 3)}</td></tr>`).join('');
  return `<div class="selline">Band set chosen by BIC: <b>${esc(setOf(s.kept))}</b>${tail}.</div>
    <details class="selsets"><summary>All ${s.models.length} band sets tried</summary>
      <table class="ctab"><thead><tr><th>bands</th><th>free parameters</th><th>ΔBIC</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="source-note">BIC = n·ln(χ²/n) + k·ln n over the same ${s.models[0].n} points; lower is better. It weighs fit against the number of parameters; it does not prove a band is or is not there.</p></details>`;
}

export function renderFit(el, vm) {
  if (!vm.hasData) { el.innerHTML = '<div class="empty">Load a spectrum first.</div>'; return; }
  const d = vm.deconv;
  const ms = vm.library?.fitDefaults?.modelSelection;
  const lab = id => (vm.library.bands.find(b => b.id === id) || {}).label || id;
  const selText = ms && !vm.fitAllBands
    ? ` ${ms.optional.map(lab).join(', ')} are kept only in the band set with the lowest BIC (Bayesian information criterion; Schwarz 1978) over the same data; every other band is always fitted.`
    : ms ? ' Every atlas band is fitted (model selection off).' : '';
  const intro = `<p class="empty" style="padding:0 0 12px">Seeds PeakForge's Levenberg–Marquardt fitter with the atlas bands: atlas centres (shifted for λ<sub>ex</sub>) as starting values, centres bounded to each band's window, widths ${vm.fitBounds}. First- and second-order regions are fitted separately with a linear local baseline.${selText} Profiles use PeakForge's WiRE-compatible pseudo-Voigt.</p>`;
  if (!d) {
    el.innerHTML = `<div class="pane-head"><h2 class="pane-title">Deconvolution</h2><span class="pane-meta">not run</span></div>${intro}
      <button class="key key-primary" data-action="deconvolve">Deconvolve<kbd>F</kbd></button>`;
    return;
  }
  const lib = vm.library;
  const bandName = id => (lib.bands.find(b => b.id === id) || {}).label || id;
  const wins = d.windows.map((w, wi) => {
    const st = w.stats || {};
    const [cls, txt] = verdict(st.quality);
    const comps = d.components.filter(c => c.windowIndex === wi);
    const totA = comps.reduce((a, c) => a + Math.abs(c.area || 0), 0) || 1;
    const warn = [];
    if (isFinite(st.qualityWorst) && isFinite(st.qualityAt) && st.qualityWorst > Math.max(st.quality * 2, 2.5)) warn.push(`Worst region ${fmt(st.qualityWorst, 3)}× noise near ${fmtX(st.qualityAt)} cm⁻¹: likely a missing component.`);
    const insig = comps.filter(c => !c.significant).map(c => c.label);
    if (insig.length) warn.push(`Not significant (height within 2σ of zero, or zero): ${insig.join(', ')}.`);
    if (w.worstCorrelation && Math.abs(w.worstCorrelation.rho) > 0.98) warn.push(`Near-degenerate pair ρ = ${w.worstCorrelation.rho.toFixed(3)}: ${esc(w.worstCorrelation.a)} ↔ ${esc(w.worstCorrelation.b)}. Overlapped bands are not uniquely determined.`);
    return `<div class="fitwin"><h4><span>${wi === 0 && w.lo < 2000 ? 'First-order' : 'Second-order'} · ${fmt(w.lo, 4)}–${fmt(w.hi, 4)} cm⁻¹</span><span>${w.bandIds.length} bands</span></h4>
      <div class="quality ${cls}"><span class="v">${isFinite(st.quality) ? st.quality.toFixed(2) : '—'}<small style="font-size:12px">× noise</small></span><span class="verdict">${txt}</span></div>
      <div class="kv"><span>reduced χ²</span><b>${fmt(st.chiRed, 4)}</b><span>R²</span><b>${isFinite(st.r2) ? st.r2.toFixed(5) : '—'}</b><span>RMSE</span><b>${fmt(st.rmse, 4)}</b><span>iterations</span><b>${st.iters ?? '—'} · ${esc(convText(st))}</b></div>
      ${selectionBlock(vm, w)}
      ${warn.map(x => `<div class="warnline">⚠ ${x}</div>`).join('')}
      <table class="ctab"><thead><tr><th>band</th><th>centre ± σ</th><th>FWHM</th><th>height</th><th>%G</th><th>area %</th></tr></thead><tbody>
      ${comps.map(c => `<tr class="${c.significant ? '' : 'weak'}" data-select="fc:${esc(c.bandId)}"><td class="lab">${esc(bandName(c.bandId))}</td>
        <td>${fmtX(c.x0)}${c.se && isFinite(c.se.x0) ? ' ± ' + fmt(c.se.x0, 2) : ''}</td><td>${fmt(c.w, 3)}</td><td>${fmt(c.h, 3)}</td>
        <td title="${esc(peakType(c))}">${fmt(c.g, 3)}</td><td>${(Math.abs(c.area || 0) / totA * 100).toFixed(1)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }).join('');
  const skipped = d.skipped && d.skipped.length ? `<p class="empty" style="padding:4px 0 10px">Not fitted: ${d.skipped.map(s => `${esc(bandName(s.bandId))} (${esc(s.reason)})`).join(', ')}.</p>` : '';
  el.innerHTML = `<div class="pane-head"><h2 class="pane-title">Deconvolution</h2><span class="pane-meta">${d.components.length} components</span></div>
    ${wins}${skipped}
    <div class="dlg-row" style="margin-top:6px">
      <label class="chk"><input type="checkbox" data-opt="showComponents"${vm.showComponents ? ' checked' : ''}> show component curves</label>
      <label class="chk"><input type="checkbox" data-opt="labelAllFit"${vm.labelAllFit ? ' checked' : ''}> label every fitted band</label>
      ${vm.library?.fitDefaults?.modelSelection ? `<label class="chk"><input type="checkbox" data-opt="fitAllBands"${vm.fitAllBands ? ' checked' : ''}> fit every band (no model selection)</label>` : ''}
    </div>
    <div style="display:flex;gap:8px"><button class="btn primary" data-action="deconvolve">Re-fit (F)</button><button class="btn ghost" data-action="clearfit">Clear fit</button></div>
    <p class="source-note">A low residual does not prove the components are right: heavily overlapped bands are mathematically degenerate (see PeakForge's note). Treat weak shoulders with care.</p>`;
}

// ------------------------------------------------------------------ band
export function renderBand(el, vm) {
  const it = vm.items.find(i => i.id === vm.selectedId);
  if (!it) { el.innerHTML = `<div class="empty">Click any label on the plot to see what the atlas says about that band.</div>`; return; }
  const lib = vm.library;
  const symCls = tagClass(it);
  const measure = `<div class="measure">
      <div><div class="k">measured</div><div class="v">${fmtX(it.x)} <small>cm⁻¹</small></div></div>
      <div><div class="k">${it.pband ? 'Δ atlas' : 'height'}</div><div class="v">${it.pband ? fmtSigned(it.delta) + ' <small>cm⁻¹</small>' : fmt(it.height, 3)}</div></div>
      <div><div class="k"${it.tier === 'fit' ? '' : ` title="${SCORE_TIP}"`}>${it.tier === 'fit' ? 'source' : 'match score'}</div><div class="v">${it.tier === 'fit' ? 'fit' : it.confidence != null && it.kind !== 'unassigned' ? score(it.confidence) : '—'}</div></div>
    </div>`;
  if (it.kind === 'unassigned' || it.kind === 'region') {
    const region = it.region;
    const near = it.nearest ? `Nearest band: <b>${esc(it.nearest.label)}</b>, window ${fmt(it.nearest.window[0], 4)}–${fmt(it.nearest.window[1], 4)} cm⁻¹ (${fmt(Math.abs(it.nearest.dist), 3)} cm⁻¹ away).` : '';
    el.innerHTML = `<div class="bandhead"><div class="bandsym ${symCls}">${esc(it.kind === 'region' ? region.label : '?')}</div>
      <div><div class="bandname">${it.kind === 'region' ? esc(region.name || region.label) : 'Unassigned peak'}</div>
      <div class="badges"><span class="bdg">${it.kind === 'region' ? 'non-lattice region' : 'no atlas band in tolerance'}</span><span class="bdg">${esc(it.tierText)}</span></div></div></div>
      ${measure}
      ${it.kind === 'region' ? `<div class="bfield"><div class="k">Atlas</div><div class="v">${richText(region.text)}.</div></div><div class="bfield"><div class="k">Workflow note</div><div class="v">${richText(lib.workflow[7] || '')}</div></div>`
        : `<div class="bfield"><div class="k">Why unassigned</div><div class="v">No ${esc(lib.name)} band window contains ${fmtX(it.x)} cm⁻¹ at ±${vm.toleranceCm} cm⁻¹ tolerance for ${vm.laserNm} nm. ${near} It may be a substrate, impurity or contamination band, or a band outside this library.</div></div>`}
      ${altsHTML(it)}
      <p class="source-note">Unmatched peaks are always shown, never hidden.</p>`;
    return;
  }
  const b = it.band, pb = it.pband;
  const shiftNote = pb && pb.shift ? ` · shifted ${fmtSigned(pb.shift)} cm⁻¹ for ${vm.laserNm} nm` : '';
  const widenNote = pb && pb.widen ? ` · window widened ±${fmt(pb.widen, 3)} cm⁻¹ (atlas gives no dispersion rate)` : '';
  el.innerHTML = `<div class="bandhead"><div class="bandsym ${symCls}">${esc(b.label)}</div>
      <div><div class="bandname">${richText(b.name)}</div>
      <div class="badges"><span class="bdg ${esc(b.region)}">${esc(b.order)}</span><span class="bdg">${richText(b.activated)}</span>${b.sym && b.sym !== '—' ? `<span class="bdg">${richText(b.sym)}</span>` : ''}<span class="bdg">${esc(it.tierText)}</span></div></div></div>
    ${measure}
    <div class="bfield"><div class="k">Atlas position</div><div class="v"><span class="mono">${esc(b.posText)}</span>${pb ? ` → match window <span class="mono">${fmt(pb.window[0], 4)}–${fmt(pb.window[1], 4)} cm⁻¹</span>${shiftNote}${widenNote}` : ''}<br><small style="color:var(--ink-3)">Atlas positions assume ${esc(vm.refText)}.</small></div></div>
    <div class="bfield"><div class="k">Vibrational origin</div><div class="v"><b>${richText(b.origin)}</b><br>${richText(b.mechanism)}</div></div>
    <div class="bfield"><div class="k">Scattering process</div><div class="v">${richText(b.process)}</div></div>
    <div class="bfield"><div class="k">Physical meaning</div><div class="v">${richText(b.meaning)}</div></div>
    <div class="bfield"><div class="k">Diagnostic use</div><div class="v"><b>${richText(b.use)}</b><br>${richText(b.diagnostics)}</div></div>
    ${b.correction ? `<div class="bfield"><div class="correction"><div class="k">⚠ Atlas accuracy note</div><div class="v">${richText(b.correction)}</div></div></div>` : ''}
    <div class="bfield"><div class="k">References</div><div class="refs">${refChips(lib, b.refs)}</div></div>
    ${altsHTML(it)}
    <p class="source-note">From the <a href="${esc(lib.source?.url || '#')}" target="_blank" rel="noopener noreferrer">Raman graphene atlas</a>${lib.source?.commit ? ` (commit ${esc(lib.source.commit.slice(0, 7))})` : ''}. ■ marks references added during the atlas accuracy review.</p>`;
}

function altsHTML(it) {
  const alts = (it.alternatives || []).filter(a => a.bandId !== it.bandId);
  if (!alts.length || it.tier === 'fit') return '';
  return `<div class="bfield"><div class="k">Other candidates</div><div class="alts">${alts.map(a =>
    `<button data-reassign="${esc(it.id)}" data-band="${esc(a.bandId)}" title="Assign this peak to ${esc(a.label)}">${esc(a.label)}</button> score ${score(a.confidence)} (Δ ${fmtSigned(a.delta)})`).join(' · ')}
    ${it.override ? ` · <button data-reassign="${esc(it.id)}" data-band="">auto</button>` : ''}</div></div>`;
}

/** One-line caption for presentation mode. */
export function captionHTML(it, vm) {
  if (!it) return '';
  const cls = tagClass(it);
  if (!it.band) {
    return `<div class="bandsym ${cls}">${esc(it.kind === 'region' ? it.region.label : '?')}</div>
      <div><div class="cap-name">${it.kind === 'region' ? esc(it.region.name) : 'Unassigned peak'}</div><div class="cap-line">${it.kind === 'region' ? esc(plainText(it.region.text)) : 'No atlas band within tolerance — shown, never hidden.'}</div></div>
      <div class="cap-num"><b>${fmtX(it.x)}</b><br>cm⁻¹</div>`;
  }
  return `<div class="bandsym ${cls}">${esc(it.band.label)}</div>
    <div><div class="cap-name">${esc(plainText(it.band.name))}</div><div class="cap-line">${esc(plainText(it.band.origin))} · ${esc(plainText(it.band.use))}</div></div>
    <div class="cap-num"><b>${fmtX(it.x)}</b><br>cm⁻¹ · ${it.tier === 'fit' ? 'fit' : 'score ' + score(it.confidence)}</div>`;
}

// ------------------------------------------------------------------ data
const hfmt = v => (Math.abs(v) >= 100 ? String(Math.round(v)) : fmt(v, 3));
const SPIKE_KIND = { cosmic: 'cosmic ray', artifact: 'detector artifact', manual: 'zapped', suspect: 'check', kept: 'kept', recurring: 'recurs' };

export function renderData(el, vm) {
  const d = vm.data;
  if (!d) { el.innerHTML = '<div class="empty">Load a spectrum to see its acquisition settings and quality checks.</div>'; return; }
  const range = e => (Math.round(e.xStart) === Math.round(e.xEnd) ? fmtX(e.xStart) : `${fmtX(e.xStart)}–${fmtX(e.xEnd)}`);
  const pts = e => `${e.end - e.start + 1} pt${e.end === e.start ? '' : 's'}`;
  const btn = (act, e, label, title) => `<button class="btn ghost" data-spike="${act}" data-lo="${e.xStart}" data-hi="${e.xEnd}" title="${esc(title)}">${label}</button>`;

  const acq = d.acq.fields.length
    ? `<div class="kv">${d.acq.fields.map(f => `<span>${esc(f.label)}</span><b>${esc(f.value)}</b>`).join('')}</div>`
    : `<p class="empty" style="padding:4px 0">${d.acq.hasHeader ? 'The file header holds no acquisition settings the app recognises.' : 'This file carries no acquisition metadata (plain exports usually do not).'}</p>`;
  const flags = d.flags.length
    ? d.flags.map(f => `<div class="${f.level === 'warn' ? 'warnline' : 'infoline'}">${f.level === 'warn' ? '⚠' : 'i'} ${esc(f.text)}</div>`).join('')
    : '<div class="okline">✓ No saturation, clipping or flat segments found.</div>';

  let spikes;
  if (!d.despikeOn) {
    spikes = '<p class="empty" style="padding:4px 0">Despike is off. Switch it on in the chain below the plot to remove or zap spikes.</p>';
  } else {
    const info = d.info || {};
    const set = info.companions
      ? `Compared with the ${info.companions} other spectra of this file: a feature they share is kept, or labelled a detector artifact when it is one point wide.`
      : d.setSize >= 4 ? `This file has ${d.setSize} other spectra on the same axis; comparing with them is off.` : 'Single spectrum: judged on its own shape.';
    const crit = `A feature is removed only if no real band at least <b class="mono">${fmt(info.minBandCm, 3)} cm⁻¹</b> wide${info.minBandAuto ? ' (auto: 3 points)' : ''}, nor two overlapping ones, can reproduce it within the noise. ${set}`;
    const zapOf = e => (d.edits.zaps || []).find(z => z[0] <= e.xStart + 1e-9 && z[1] >= e.xEnd - 1e-9);
    const evRow = e => {
      const z = e.kind === 'manual' ? zapOf(e) : null;
      const action = e.kind === 'manual'
        ? (z ? `<button class="btn ghost" data-spike="unzap" data-lo="${z[0]}" data-hi="${z[1]}" title="Undo this zap">Undo</button>` : '')
        : btn('keep', e, 'Keep', 'Put these points back: it is real signal');
      return `<div class="srow"><span class="stag ${esc(e.kind)}">${SPIKE_KIND[e.kind] || esc(e.kind)}</span>
        <span class="snum"><b>${range(e)}</b> cm⁻¹ · ${pts(e)} · h ${hfmt(e.height)}${e.share != null && e.kind === 'artifact' ? ` · in ${Math.round(e.share * 100)} % of the others` : ''}</span>${action}</div>`;
    };
    const restRow = e => `<div class="srow"><span class="stag ${esc(e.kind)}">${SPIKE_KIND[e.kind] || esc(e.kind)}</span>
      <span class="snum"><b>${range(e)}</b> cm⁻¹ · ${pts(e)}${e.kind === 'recurring' && e.share != null ? ` · also in ${Math.round(e.share * 100)} % of the other spectra, so treated as real` : ' · kept by you'}</span>
      ${e.kind === 'kept' ? btn('unkeep', e, 'Remove', 'Remove these points again') : ''}</div>`;
    const susRow = e => `<div class="srow"><span class="stag ${esc(e.kind)}">${SPIKE_KIND[e.kind] || esc(e.kind)}</span>
      <span class="snum"><b>${range(e)}</b> cm⁻¹ · ${pts(e)} · h ${hfmt(e.height)}${e.kind === 'artifact' ? ` · same point in ${Math.round((e.share || 0) * 100)} % of the spectra` : e.share === 0 ? ' · in no other spectrum' : ''}</span>
      ${btn('zap', e, 'Remove', 'Interpolate across these points')}</div>`;
    spikes = `<p class="dnote">${crit}</p>
      ${d.spikes.length ? `<div class="slist">${d.spikes.map(evRow).join('')}</div>` : '<div class="okline">No spikes found.</div>'}
      ${d.restored.length ? `<div class="ssub">Left in place</div><div class="slist">${d.restored.map(restRow).join('')}</div>` : ''}
      ${d.suspects.length ? `<div class="ssub">Worth a look</div><p class="dnote">Kept, but close to the spike criteria${info.companions ? ', unique to this spectrum, or a one-point artifact' : ''}. Zoom in and judge; <b>Remove</b> interpolates across it.</p><div class="slist">${d.suspects.map(susRow).join('')}</div>` : ''}
      <form class="zapform" data-zapform><label>Zap by hand</label>
        <input name="lo" type="number" step="any" inputmode="decimal" placeholder="from" aria-label="Zap from (cm⁻¹)">
        <input name="hi" type="number" step="any" inputmode="decimal" placeholder="to" aria-label="Zap to (cm⁻¹)">
        <span class="u">cm⁻¹</span><button class="btn" type="submit">Zap</button></form>
      <p class="dnote">Zapping interpolates the range linearly from its edges. Every removal is listed here, marked on the plot and written into the report. <kbd>Ctrl</kbd> <kbd>Z</kbd> undoes.</p>`;
  }
  const src = [d.source.format, d.source.file].filter(Boolean).map(esc).join(' · ');
  el.innerHTML = `<div class="pane-head"><h2 class="pane-title">Data</h2><span class="pane-meta">${src || esc(d.name)}</span></div>
    <div class="fitwin"><h4><span>Acquisition</span><span>${d.points} pts · ${fmt(d.x0, 4)}–${fmt(d.x1, 4)} cm⁻¹</span></h4>${acq}</div>
    <div class="fitwin"><h4><span>Quality checks</span><span>${d.flags.filter(f => f.level === 'warn').length || '✓'}</span></h4>${flags}</div>
    <div class="fitwin"><h4><span>Cosmic-ray removal</span><span>${d.despikeOn ? `${d.spikes.length} removed` : 'off'}</span></h4>${spikes}</div>
    ${calibrationBox(d)}
    ${labelBox(d)}`;
}

const signed = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;

/** Si offset calibration: what is applied, and measuring a new one in the active spectrum. */
function calibrationBox(d) {
  const cal = d.calibration, si = d.si;
  const now = cal ? `<div class="okline">✓ Every spectrum is shifted by <b class="mono">${signed(cal.offsetCm)} cm⁻¹</b>: Si measured at ${fmtPm(cal.measuredCm, cal.measuredSe, 6)} cm⁻¹ in “${esc(cal.siSpectrum)}”, nominal ${esc(String(cal.nominalCm))} cm⁻¹ (source: ${esc(cal.nominalSource)}).</div>
      <div style="margin-top:6px"><button class="btn ghost" data-action="siclear">Remove calibration</button></div>` : '';
  const result = si ? `<div class="kv" style="margin-top:8px"><span>measured centre</span><b>${fmtPm(si.x0, si.se, 6)} cm⁻¹</b><span>FWHM</span><b>${si.w.toFixed(1)} cm⁻¹</b><span>fit</span><b>${si.n} points${isFinite(si.quality) ? ' · ' + si.quality.toFixed(2) + '× noise' : ''}${si.undersampled ? ' · fewer than 4 points across the band' : ''}</b></div>
      <form class="siapply" data-siapply>
        <label>Nominal Si position <input name="nominal" type="number" step="any" inputmode="decimal" placeholder="cm⁻¹"></label>
        <label>Source of that value <input name="source" type="text" placeholder="reference, SOP or certificate"></label>
        <button class="btn primary" type="button" data-action="siapply">Apply the offset to every spectrum</button></form>` : '';
  return `<div class="fitwin"><h4><span>Wavenumber calibration (Si)</span><span>${cal ? signed(cal.offsetCm) + ' cm⁻¹' : 'none'}</span></h4>
    ${now}
    <p class="dnote">Open a silicon reference spectrum, measure its band here, then enter the nominal position and where it comes from: the app holds no nominal value of its own. The difference is applied to every spectrum of the session as one constant offset, on top of the instrument's own calibration, and recorded in the report, the spectrum CSV and the project. The band is fitted with one pseudo-Voigt over ±20 cm⁻¹ around the highest point of the window, on the uncalibrated axis.</p>
    <div class="siform"><label class="mrange">Si band between <input data-siwin="lo" type="number" step="any" value="${d.siWindow.lo}" aria-label="Search from (cm⁻¹)"> and <input data-siwin="hi" type="number" step="any" value="${d.siWindow.hi}" aria-label="Search to (cm⁻¹)"> cm⁻¹</label>
      <button class="btn" data-action="simeasure">Measure in this spectrum</button></div>
    ${result}</div>`;
}

/** Reviewer label for the active spectrum (for a labelled dataset). */
function labelBox(d) {
  const lb = d.label;
  return `<div class="fitwin"><h4><span>Reviewer label</span><span>${d.labelled} of ${d.total} labelled</span></h4>
    <p class="dnote">Builds a labelled dataset: cosmic-ray masks and band assignments confirmed by a person, for checking methods (and any future machine learning) against. Review the removals above and the peak labels, tick what you checked, grade the spectrum and save: the label keeps what you see now, and reopening this spectrum restores your edits.${lb ? ` Saved ${esc(new Date(lb.savedAt).toLocaleString())}.` : ''}</p>
    <form class="labelform" data-labelform>
      <div class="lrow"><span class="lk">Quality</span>${d.quality.map(v => `<label class="chk"><input type="radio" name="quality" value="${v}"${lb && lb.quality === v ? ' checked' : ''}> ${v}</label>`).join('')}</div>
      <div class="lrow"><label class="chk"><input type="checkbox" name="crr"${lb && lb.checked.cosmicRays ? ' checked' : ''}> cosmic-ray removals checked</label>
        <label class="chk"><input type="checkbox" name="bands"${lb && lb.checked.bands ? ' checked' : ''}> band labels checked</label></div>
      <textarea name="note" rows="2" placeholder="Note (optional)" aria-label="Note">${esc(lb ? lb.note : '')}</textarea>
      <div class="lrow"><input name="reviewer" type="text" placeholder="Reviewer (optional)" aria-label="Reviewer" value="${esc(lb ? lb.reviewer : d.reviewer)}">
        <button class="btn" type="button" data-action="labelsave">Save</button>
        <button class="btn primary" type="button" data-action="labelnext">Save &amp; next ▸</button>
        ${lb ? '<button class="btn ghost" type="button" data-action="labeldel">Delete label</button>' : ''}</div>
    </form>
    ${d.labelled ? `<div style="margin-top:8px"><button class="btn ghost" data-action="labelexport">Export ${d.labelled} label${d.labelled === 1 ? '' : 's'} (JSON)</button> <span class="pane-meta">raw data included; saved to this computer only</span></div>` : ''}
  </div>`;
}

// ------------------------------------------------------------------ map
/** Option list for a measure select: the library's bands, plus a custom range. */
function measureOptions(vm, value, { none = false } = {}) {
  const opts = (vm.map.bands || []).map(b => `<option value="${esc(b.id)}"${b.id === value ? ' selected' : ''}>${esc(b.label)} · ${fmt(b.window[0], 4)}–${fmt(b.window[1], 4)} cm⁻¹</option>`);
  if (none) opts.unshift(`<option value=""${!value ? ' selected' : ''}>—</option>`);
  else opts.push(`<option value="range"${value === 'range' ? ' selected' : ''}>custom range…</option>`);
  return opts.join('');
}

export function renderMap(el, vm) {
  const m = vm.map;
  if (!m || !m.available) { el.innerHTML = '<div class="empty">Load a Renishaw map (.wdf) to see band-intensity maps.</div>'; return; }
  const { lay, values, cmp } = m;
  const fin = Array.from(values).filter(Number.isFinite);
  const lo = fin.length ? Math.min(...fin) : 0, hi = fin.length ? Math.max(...fin) : 1;
  const t = v => (hi > lo ? (v - lo) / (hi - lo) : 0.5);
  // heatmap geometry: square cells in stage units, at most 300 px tall
  const W = 320, ratio = (lay.dy || 1) / (lay.dx || 1);
  const cw = Math.max(4, Math.min(W / lay.nx, 300 / (lay.ny * ratio)));
  const ch = cw * ratio;
  const w = cw * lay.nx, h = ch * lay.ny, gap = cw > 10 ? 1.5 : 0.5;
  const cells = m.points.map((p, k) => {
    const [ix, iy] = lay.cell[k], v = values[k];
    const fill = rampColor(t(v), m.dark);
    const title = `#${p.index + 1} (${fmt(p.x, 4)}, ${fmt(p.y, 4)} ${esc(m.unit)}): ${Number.isFinite(v) ? fmt(v, 4) : 'n/a'}`;
    return `<rect class="mcell${p.id === m.activeId ? ' on' : ''}${fill ? '' : ' na'}" data-mapcell="${esc(p.id)}" data-tip="${title}" x="${(ix * cw + gap / 2).toFixed(2)}" y="${(iy * ch + gap / 2).toFixed(2)}" width="${(cw - gap).toFixed(2)}" height="${(ch - gap).toFixed(2)}" rx="${cw > 12 ? 2 : 0}"${fill ? ` fill="${fill}"` : ''}><title>${title}</title></rect>`;
  }).join('');
  const grad = (m.dark ? [...RAMP].reverse() : RAMP).join(', ');
  const heat = `<svg class="mapsvg" viewBox="-2 -2 ${(w + 4).toFixed(1)} ${(h + 4).toFixed(1)}" width="${(w + 4).toFixed(0)}" height="${(h + 4).toFixed(0)}" role="img" aria-label="${esc(m.label)} map, ${lay.nx} by ${lay.ny} points">${cells}</svg>
    <div class="maxes"><span>x ${fmt(lay.xs[0], 4)} → ${fmt(lay.xs[lay.xs.length - 1], 4)} ${esc(m.unit)}</span><span>y ${fmt(lay.ys[0], 4)} (top) → ${fmt(lay.ys[lay.ys.length - 1], 4)} ${esc(m.unit)}</span></div>
    <div class="mlegend"><span class="mv">${fmt(lo, 4)}</span><span class="mbar" style="background:linear-gradient(90deg, ${grad})"></span><span class="mv">${fmt(hi, 4)}</span></div>
    <div class="mreadout" id="mapReadout">${esc(m.label)} · hover a point for its value, click it to open that spectrum</div>`;

  const rangeInputs = (key, r) => `<span class="mrange"${r.show ? '' : ' hidden'}><input data-maprange="${key}lo" type="number" step="any" value="${r.lo ?? ''}" aria-label="from (cm⁻¹)"> – <input data-maprange="${key}hi" type="number" step="any" value="${r.hi ?? ''}" aria-label="to (cm⁻¹)"> cm⁻¹</span>`;
  const controls = `<div class="mctl">
      <label>Map <select data-mapsel="num">${measureOptions(vm, m.sel.num)}</select></label>${rangeInputs('num', m.ranges.num)}
      <label>÷ <select data-mapsel="den">${measureOptions(vm, m.sel.den, { none: true })}</select></label>
    </div>`;

  let compare = '';
  if (cmp) {
    const { values: cv, r, n, label: clabel } = cmp;
    const pts = m.points.map((p, k) => [values[k], cv[k], p]).filter(q => Number.isFinite(q[0]) && Number.isFinite(q[1]));
    const sw = 300, sh = 170, pad = 30;
    const xs = pts.map(q => q[1]), ys = pts.map(q => q[0]);
    const [x0, x1] = xs.length ? [Math.min(...xs), Math.max(...xs)] : [0, 1], [y0, y1] = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 1];
    const sx = v => pad + (sw - pad - 8) * (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5), sy = v => sh - pad + 8 - (sh - pad - 14) * (y1 > y0 ? (v - y0) / (y1 - y0) : 0.5);
    const dots = pts.map(([a, b, p]) => `<circle class="mdot${p.id === m.activeId ? ' on' : ''}" data-mapcell="${esc(p.id)}" data-tip="#${p.index + 1}: ${esc(clabel)} ${fmt(b, 4)}, ${esc(m.label)} ${fmt(a, 4)}" cx="${sx(b).toFixed(1)}" cy="${sy(a).toFixed(1)}" r="4.5"><title>#${p.index + 1}</title></circle>`).join('');
    const word = !Number.isFinite(r) ? 'not enough points to compare' : Math.abs(r) >= 0.8 ? (r > 0 ? 'rise and fall together' : 'move in opposite directions') : Math.abs(r) >= 0.5 ? 'partly co-vary' : 'vary independently';
    compare = `<div class="ssub">Compare</div>
      <div class="mctl"><label>with <select data-mapsel="cmp">${measureOptions(vm, m.sel.cmp, { none: true })}</select></label>${rangeInputs('cmp', m.ranges.cmp)}</div>
      <div class="mcorr"><b class="mono">r = ${Number.isFinite(r) ? r.toFixed(3) : '—'}</b> over ${n} points: the two maps ${word}.</div>
      <svg class="mscatter" viewBox="0 0 ${sw} ${sh}" width="${sw}" height="${sh}" role="img" aria-label="${esc(m.label)} against ${esc(clabel)}">
        <line class="max" x1="${pad}" y1="${sh - pad + 8}" x2="${sw - 8}" y2="${sh - pad + 8}"/><line class="max" x1="${pad}" y1="18" x2="${pad}" y2="${sh - pad + 8}"/>
        <text class="mlab" x="${sw - 8}" y="${sh - 6}" text-anchor="end">${esc(clabel)} →</text>
        <text class="mlab" x="${pad - 4}" y="10">${esc(m.label)} ↑</text>${dots}</svg>
      <p class="dnote">Pearson correlation across the map points. Bands of one component rise and fall together, so a high r supports a common origin, but does not prove it: thickness, focus and fluorescence move every band at once.</p>`;
  } else {
    compare = `<div class="ssub">Compare</div><div class="mctl"><label>with <select data-mapsel="cmp">${measureOptions(vm, '', { none: true })}</select></label></div>`;
  }

  el.innerHTML = `<div class="pane-head"><h2 class="pane-title">Map</h2><span class="pane-meta">${lay.nx} × ${lay.ny} points · ${fmt(lay.dx, 3)} × ${fmt(lay.dy, 3)} ${esc(m.unit)}</span></div>
    ${controls}
    <div class="fitwin mapbox">${heat}</div>
    ${compare}
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn" data-action="mapcsv">Map values (CSV)</button></div>
    <p class="source-note">Heights above a straight line joining the window edges (WiRE's “signal to baseline”), measured on the despiked spectra${m.setDespike ? ', with cosmic rays judged against the rest of the map' : ''}. ${m.den ? 'Ratio cells are empty where the denominator band is under 5 % of its largest height in this map (absent: the ratio would divide by noise).' : ''}</p>`;
}
