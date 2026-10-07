// Side-deck panes: peak list, ratio guide, read-your-spectrum, fit report,
// and the atlas band explainer. Pure render functions over a view model built
// in main.js; event handling is delegated by main.js via data-* attributes.

import { esc, fmt, fmtX, fmtSigned, richText, plainText } from './dom.js';
import { peakType } from '../fit/profile.js';

const STATUS_GLYPH = { match: '✓', partial: '◐', no: '✕', info: 'i', insufficient: '…' };

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
      <div class="pinfo"><div class="pname">${esc(it.name)}</div><div class="pnums">${nums.join(' · ')}</div></div>
      <div class="pside">${conf != null ? `<span class="pane-meta">${conf}%</span><span class="conf"><i style="width:${conf}%"></i></span>` : `<span class="pane-meta">${esc(it.tierText)}</span>`}
      ${it.tier !== 'fit' ? `<button class="x" data-delete="${esc(it.id)}" title="Remove this peak (Del)">×</button>` : ''}</div>
    </div>`;
  };
  el.innerHTML = `
    <div class="pane-head"><h2 class="pane-title">Detected peaks</h2><span class="pane-meta">${tier1.length} found · ${assigned} assigned</span></div>
    ${tier1.length ? `<div class="peaklist">${tier1.map(row).join('')}</div>` : `<div class="empty">No peaks above the current sensitivity. Raise <b>Detect</b> sensitivity in the chain below the plot.</div>`}
    ${tier2.length ? `<div class="pane-head" style="margin-top:18px"><h2 class="pane-title">Resolved by deconvolution</h2><span class="pane-meta">${tier2.length} bands</span></div><div class="peaklist">${tier2.map(row).join('')}</div>` : ''}
    <div class="tiers"><span><i></i>detected maximum</span><span><i class="fit"></i>fit-resolved band</span><span><i class="un"></i>unassigned</span></div>
    <p class="empty" style="padding-top:10px">Double-click the plot to add a peak by hand · <kbd>Del</kbd> removes the selected one · <kbd>[</kbd> <kbd>]</kbd> step through labels.</p>`;
}

// ------------------------------------------------------------------ ratios
export function renderRatios(el, vm) {
  if (!vm.hasData) { el.innerHTML = `<div class="empty">Ratios appear once a spectrum is loaded.</div>`; return; }
  const lib = vm.library;
  const cards = (vm.ratios || []).map(r => {
    const card = lib.ratios[r.ratioIndex] || {};
    const hv = r.height ? fmt(r.height.value, 3) : null, av = r.area ? fmt(r.area.value, 3) : null;
    const hasH = (lib.ratioMap[r.ratioIndex]?.measures || []).includes('height');
    const extras = [];
    const ex = r.extras || {};
    if (ex.crystalliteSize && ex.crystalliteSize.length) {
      extras.push('Cançado crystallite size L<sub>a</sub>: ' + ex.crystalliteSize.map(c =>
        `<b class="mono">${fmt(c.valueNm, 3)} nm</b> (${c.basis}, E<sub>l</sub> = ${fmt(c.El, 3)} eV)`).join(' · '));
    }
    if (ex.gWidth != null && isFinite(ex.gWidth)) extras.push(`G FWHM <b class="mono">${fmt(ex.gWidth, 3)} cm⁻¹</b> — broad G ⇒ amorphisation regime (atlas).`);
    if (ex.twoDWidth != null && isFinite(ex.twoDWidth)) extras.push(`2D FWHM <b class="mono">${fmt(ex.twoDWidth, 3)} cm⁻¹</b> (monolayer: single Lorentzian, 24–30 cm⁻¹).`);
    if (r.classify && r.classify.label) extras.push(`Nearest atlas reference: <b class="mono">≈ ${esc(String(r.classify.nearest))}</b> → <b>${esc(r.classify.label)}</b>`);
    return `<div class="rcard">
      <h4>${esc(r.name || card.n)}</h4><div class="rt">${richText(r.title || card.t)}</div>
      <div class="rvals">
        ${hasH ? `<div class="rval"><div class="k">Height</div><div class="v${hv ? '' : ' na'}">${hv || 'n/a'}</div><div class="s">${r.height ? esc(r.height.source) : ''}</div></div>` : ''}
        <div class="rval"><div class="k">Area</div><div class="v${av ? '' : ' na'}">${av || 'needs fit'}</div><div class="s">${r.area ? 'fit components' : ''}</div></div>
      </div>
      ${extras.length ? `<div class="rextra">${extras.join('<br>')}</div>` : ''}
      ${r.missing && r.missing.length ? `<div class="rmiss">${r.missing.map(esc).join(' · ')}</div>` : ''}
      <details class="atlas"><summary>Atlas guide</summary>
        <p>${richText(card.b)}</p>${(card.eqs || []).map(e => `<div class="eq">${richText(e)}</div>`).join('')}
        <p>${richText(card.note)}</p><div class="refs">${refChips(lib, card.refs)}</div></details>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="pane-head"><h2 class="pane-title">Intensity ratios</h2><span class="pane-meta">${vm.deconv ? 'fit + detection' : 'detection only'}</span></div>
    ${vm.deconv ? '' : `<p class="empty" style="padding:0 0 12px">Areas and hidden bands (D′, D*, D″) need <b>Deconvolve</b>.</p>`}
    ${cards || '<div class="empty">This library defines no ratios.</div>'}`;
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

export function renderFit(el, vm) {
  if (!vm.hasData) { el.innerHTML = '<div class="empty">Load a spectrum first.</div>'; return; }
  const d = vm.deconv;
  const intro = `<p class="empty" style="padding:0 0 12px">Seeds PeakForge's Levenberg–Marquardt fitter with the atlas nine-band model: atlas centres (shifted for λ<sub>ex</sub>) as starting values, centres bounded to each band's window, widths ${vm.fitBounds}. First- and second-order regions are fitted separately with a linear local baseline. Profiles use PeakForge's WiRE-compatible pseudo-Voigt.</p>`;
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
      <div><div class="k">${it.tier === 'fit' ? 'source' : 'confidence'}</div><div class="v">${it.tier === 'fit' ? 'fit' : it.confidence != null && it.kind !== 'unassigned' ? Math.round(it.confidence * 100) + '%' : '—'}</div></div>
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
    `<button data-reassign="${esc(it.id)}" data-band="${esc(a.bandId)}" title="Assign this peak to ${esc(a.label)}">${esc(a.label)}</button> ${Math.round(a.confidence * 100)}% (Δ ${fmtSigned(a.delta)})`).join(' · ')}
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
    <div class="cap-num"><b>${fmtX(it.x)}</b><br>cm⁻¹ · ${it.tier === 'fit' ? 'fit' : Math.round((it.confidence || 0) * 100) + '%'}</div>`;
}
