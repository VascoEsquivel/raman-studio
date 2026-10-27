// The signal chain: processing steps laid out left→right like modules on an
// instrument rack. Each module has a power switch (LED) and a parameter
// readout; clicking the readout opens its controls.

import { esc, fmt, dismissable, paintRange } from './dom.js';

const BASELINE_LABEL = { none: 'None', constant: 'Constant', linear: 'Linear', quadratic: 'Quadratic', als: 'ALS' };
const NORM_LABEL = { max: 'max = 1', band: 'G band = 1', area: 'area = 1' };

export class Chain {
  /**
   * @param {HTMLElement} el
   * @param {{onToggle:(step:string,on:boolean)=>void, onSetting:(path:string,value:any,commit:boolean)=>void,
   *          onDeconvolve:()=>void, onDetect:()=>void}} handlers
   */
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.model = null;
    this.pop = null;
    this._build();
  }

  _build() {
    const mod = (key, name, { led = true, extra = '' } = {}) =>
      `<div class="mod" data-mod="${key}">` +
      `<div class="mod-head">${led ? `<button class="led" data-toggle="${key}" aria-pressed="false" aria-label="Toggle ${name}"></button>` : ''}` +
      `<button class="mod-name" data-open="${key}">${name}</button></div>` +
      `<button class="mod-val" data-open="${key}" data-val="${key}">—</button>${extra}</div>`;
    const wire = '<span class="wire" aria-hidden="true"></span>';
    this.el.innerHTML =
      mod('raw', 'Raw', { led: false }) + wire +
      mod('despike', 'Despike') + wire +
      mod('baseline', 'Baseline') + wire +
      mod('smooth', 'Smooth') + wire +
      mod('normalize', 'Normalize') + wire +
      `<div class="mod mod-detect" data-mod="detect"><div class="mod-head"><button class="mod-name" data-open="detect">Detect</button>` +
      `<span class="mod-val" data-val="detect" style="margin-left:auto">—</span></div>` +
      `<input type="range" min="0" max="1" step="0.01" id="sens" aria-label="Detection sensitivity" title="Sensitivity: prominence threshold in multiples of the noise σ"></div>` + wire +
      mod('label', 'Label', { led: false }) +
      `<button class="mod-fire" id="bDeconv" title="Deconvolve with the atlas nine-band model (F)"><b>Deconvolve</b><span data-val="fire">nine-band fit · F</span></button>`;

    this.el.addEventListener('click', e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.toggle) {
        const on = t.getAttribute('aria-pressed') !== 'true';
        this.h.onToggle(t.dataset.toggle, on);
      } else if (t.dataset.open) {
        this.open(t.dataset.open, t.closest('.mod'));
      } else if (t.id === 'bDeconv') {
        this.h.onDeconvolve();
      }
    });
    const sens = this.el.querySelector('#sens');
    sens.addEventListener('input', () => { paintRange(sens); this.h.onSetting('detect.sensitivity', +sens.value, false); });
    sens.addEventListener('change', () => this.h.onSetting('detect.sensitivity', +sens.value, true));
  }

  /** Refresh LEDs and readouts from the app model (never rebuilds controls). */
  update(m) {
    this.model = m;
    const s = m.settings;
    const set = (key, html) => { const v = this.el.querySelector(`[data-val="${key}"]`); if (v) v.innerHTML = html; };
    const led = (key, on, disabled = false) => {
      const b = this.el.querySelector(`[data-toggle="${key}"]`);
      if (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.disabled = disabled; }
      const modEl = this.el.querySelector(`[data-mod="${key}"]`);
      if (modEl) modEl.classList.toggle('off', !on);
    };
    const st = m.stats || {};
    set('raw', st.points ? `${st.points} pts` : '—');
    led('despike', s.despike.on);
    set('despike', s.despike.on ? `<span class="stat">${st.spikes ?? 0}</span> removed${st.suspects ? ` · ${st.suspects} to check` : ''}` : 'off');
    led('baseline', s.baseline.on);
    const bm = s.baseline.method;
    set('baseline', s.baseline.on ? (bm === 'als' ? `ALS λ 1e${Math.round(Math.log10(s.baseline.lambda) * 10) / 10}` : BASELINE_LABEL[bm] || bm) : 'off');
    led('smooth', s.smooth.on);
    set('smooth', s.smooth.on ? `SG ${s.smooth.window}/${s.smooth.order}` : 'off');
    led('normalize', s.normalize.on);
    set('normalize', s.normalize.on ? NORM_LABEL[s.normalize.mode] || s.normalize.mode : 'off');
    const sens = this.el.querySelector('#sens');
    if (document.activeElement !== sens) { sens.value = m.detect.sensitivity; paintRange(sens); }
    set('detect', `<span class="stat">${st.peaks ?? 0}</span> peaks`);
    set('label', `±${m.toleranceCm} cm⁻¹`);
    const lab = this.el.querySelector('[data-mod="label"] .mod-val'); if (lab) lab.title = (m.libraryShort || '') + ' · match tolerance';
    const fire = this.el.querySelector('#bDeconv');
    fire.disabled = !m.canDeconvolve;
    set('fire', m.deconvText || 'nine-band fit · F');
    if (this.pop && this.pop.refresh) this.pop.refresh();
  }

  close() { if (this.pop) { this.pop.close(); } }

  open(key, anchor) {
    const wasOpen = this.pop && this.pop.key === key;
    this.close();
    if (wasOpen || !this.model) return;
    const html = this._popHTML(key);
    if (!html) return;
    const pop = document.createElement('div');
    pop.className = 'pop';
    pop.innerHTML = html;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const pw = Math.min(300, window.innerWidth - 16);
    pop.style.width = pw + 'px';
    const left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left));
    pop.style.left = left + 'px';
    const ph = pop.offsetHeight;
    const above = r.top - ph - 8;
    pop.style.top = (above > 8 ? above : Math.min(window.innerHeight - ph - 8, r.bottom + 8)) + 'px';
    anchor.classList.add('open');
    this._wirePop(key, pop);
    const close = dismissable(pop, () => {
      pop.remove(); anchor.classList.remove('open');
      if (this.pop && this.pop.el === pop) this.pop = null;
    }, [anchor]);
    this.pop = { key, el: pop, close };
  }

  _popHTML(key) {
    const m = this.model, s = m.settings;
    const range = (path, label, min, max, step, value, out) =>
      `<div class="field"><label>${label}</label><input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${value}"><output data-out="${path}">${out}</output></div>`;
    switch (key) {
      case 'raw': return `<h3>Raw spectrum</h3>
        <div class="kv"><span>points</span><b>${m.stats.points ?? '—'}</b><span>range</span><b>${fmt(m.stats.x0, 5)} – ${fmt(m.stats.x1, 5)} cm⁻¹</b><span>source</span><b>${esc(m.stats.source || '—')}</b></div>
        <p class="hint">Use the view switch on the plot (Processed · Raw + baseline · Compare) to see what each step removed. Keys <kbd>B</kbd> and <kbd>C</kbd>.</p>`;
      case 'despike': {
        const info = m.despikeInfo || {}, mb = s.despike.minBandCm || 0;
        return `<h3>Cosmic-ray removal</h3>
        ${range('despike.threshold', 'Threshold', 3, 15, 0.5, s.despike.threshold, s.despike.threshold)}
        ${range('despike.maxWidth', 'Max width', 1, 25, 1, s.despike.maxWidth, s.despike.maxWidth + ' pt')}
        ${range('despike.minBandCm', 'Narrowest band', 0, 30, 0.5, mb, mb ? mb + ' cm⁻¹' : 'auto' + (info.minBandCm ? ' · ' + fmt(info.minBandCm, 3) + ' cm⁻¹' : ''))}
        ${m.setSize >= 4 ? `<div class="field"><label class="chk"><input type="checkbox" data-path="despike.useSet"${s.despike.useSet ? ' checked' : ''}> compare with the ${m.setSize} other spectra of this file</label></div>` : ''}
        <p class="hint">A feature is removed only if no real band at least <b>Narrowest band</b> wide, nor two overlapping ones, can reproduce its shape within the noise. That catches cosmic-ray tracks of any width up to <b>Max width</b> and keeps narrow real bands. Auto is 3 data points; lower it if your sample has sharper real lines (a Si peak on a coarse grid, for example). <b>Threshold</b> sets how far above its surroundings (in noise σ) a feature must stand to be examined. The <b>Data</b> tab lists every removal, with Keep and Zap.</p>`;
      }
      case 'baseline': {
        const lam = Math.log10(s.baseline.lambda), p = Math.log10(s.baseline.p);
        const opts = ['none', 'constant', 'linear', 'quadratic', 'als'].map(k => `<option value="${k}"${k === s.baseline.method ? ' selected' : ''}>${k === 'als' ? 'Asymmetric least squares' : BASELINE_LABEL[k]}</option>`).join('');
        return `<h3>Baseline</h3>
        <div class="field"><label>Method</label><select data-path="baseline.method">${opts}</select></div>
        <div data-als ${s.baseline.method === 'als' ? '' : 'hidden'}>
          ${range('baseline.lambdaLog', 'Stiffness λ', 2, 9, 0.1, lam, '1e' + lam.toFixed(1))}
          ${range('baseline.pLog', 'Asymmetry p', -4, -0.7, 0.05, p, s.baseline.p.toPrecision(2))}
        </div>
        <p class="hint">Polynomial options match PeakForge (constant / linear / quadratic), fitted iteratively under the peaks. ALS (Eilers &amp; Boelens) follows curved fluorescence backgrounds: raise λ for a stiffer baseline, lower p to hug the floor.</p>`;
      }
      case 'smooth': return `<h3>Savitzky–Golay smoothing</h3>
        ${range('smooth.window', 'Window', 5, 51, 2, s.smooth.window, s.smooth.window + ' pt')}
        ${range('smooth.order', 'Order', 1, 5, 1, s.smooth.order, s.smooth.order)}
        <p class="hint">Off by default: smoothing broadens narrow bands. Keep the window well below the narrowest FWHM in points.</p>`;
      case 'normalize': {
        const opts = [['max', 'Maximum = 1'], ['band', 'G band = 1'], ['area', 'Area = 1']].map(([k, l]) => `<option value="${k}"${k === s.normalize.mode ? ' selected' : ''}>${l}</option>`).join('');
        return `<h3>Normalization</h3><div class="field"><label>Mode</label><select data-path="normalize.mode">${opts}</select></div>
        <p class="hint">G band uses the maximum inside the atlas G window, shifted for the selected laser. Ratios are unaffected by normalization.</p>`;
      }
      case 'detect': {
        const d = m.detect;
        return `<h3>Peak detection</h3>
        ${range('detect.sensitivity', 'Sensitivity', 0, 1, 0.01, d.sensitivity, (d.sensitivity * 100).toFixed(0) + '%')}
        ${range('detect.minWidthCm', 'Min width', 1, 40, 1, d.minWidthCm, d.minWidthCm + ' cm⁻¹')}
        ${range('detect.minDistanceCm', 'Min distance', 2, 80, 1, d.minDistanceCm, d.minDistanceCm + ' cm⁻¹')}
        ${range('detect.maxPeaks', 'Max peaks', 3, 40, 1, d.maxPeaks, d.maxPeaks)}
        <p class="hint">Prominence-based (a port of SciPy's find_peaks): a peak must rise above its surroundings by a multiple of the measured noise σ. Sensitivity sets that multiple. Shoulders hidden inside broad GO bands need <b>Deconvolve</b>.</p>`;
      }
      case 'label': {
        const libs = m.libraries.map(l => `<option value="${esc(l.id)}"${l.id === m.libraryId ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
        return `<h3>Atlas labelling</h3>
        <div class="field"><label>Library</label><select data-path="libraryId">${libs}</select></div>
        ${range('match.toleranceCm', 'Tolerance', 5, 60, 1, m.toleranceCm, '±' + m.toleranceCm + ' cm⁻¹')}
        <p class="hint">A peak matches a band when it lies within the atlas range ± tolerance. D and 2D windows shift with the laser (atlas: ~50 and ~100 cm⁻¹/eV). D′, G*, D+D′ and 2D′ have no atlas rate, so their windows widen instead. Positions assume ${esc(m.refText)}.</p>`;
      }
      default: return '';
    }
  }

  _wirePop(key, pop) {
    const fmtOut = (path, v) => {
      switch (path) {
        case 'baseline.lambdaLog': return '1e' + (+v).toFixed(1);
        case 'baseline.pLog': return Math.pow(10, +v).toPrecision(2);
        case 'despike.maxWidth': case 'smooth.window': return v + ' pt';
        case 'despike.minBandCm': return +v ? v + ' cm⁻¹' : 'auto';
        case 'detect.sensitivity': return (v * 100).toFixed(0) + '%';
        case 'detect.minWidthCm': case 'detect.minDistanceCm': return v + ' cm⁻¹';
        case 'match.toleranceCm': return '±' + v + ' cm⁻¹';
        default: return v;
      }
    };
    for (const inp of pop.querySelectorAll('[data-path]')) {
      if (inp.type === 'range') paintRange(inp);
      const send = commit => {
        const path = inp.dataset.path;
        let v = inp.type === 'range' ? +inp.value : inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.type === 'range') {
          paintRange(inp);
          const o = pop.querySelector(`[data-out="${path}"]`); if (o) o.textContent = fmtOut(path, v);
        }
        if (path === 'baseline.lambdaLog') this.h.onSetting('baseline.lambda', Math.pow(10, v), commit);
        else if (path === 'baseline.pLog') this.h.onSetting('baseline.p', +Math.pow(10, v).toPrecision(3), commit);
        else this.h.onSetting(path, v, commit);
        if (path === 'baseline.method') {
          const als = pop.querySelector('[data-als]'); if (als) als.hidden = v !== 'als';
        }
      };
      inp.addEventListener('input', () => send(false));
      inp.addEventListener('change', () => send(true));
    }
  }
}
