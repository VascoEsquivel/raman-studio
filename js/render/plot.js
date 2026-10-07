// Interactive spectrum plot: traces on a <canvas> (fast zoom/pan for large
// spectra), axes, labels, markers and the crosshair in an SVG overlay (crisp
// text, CSS theming, clickable labels, animatable).

import { computeFrame, lowerBound, interpAt } from './frame.js';
import { axesMarkup, windowsMarkup, spikesMarkup, labelsMarkup, esc } from './svg-parts.js';
import { revealLabels } from './label-anim.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** Resolve a colour token ('--laser') or literal against the document's CSS. */
export function makePalette(root = document.documentElement) {
  const cs = getComputedStyle(root);
  const cache = new Map();
  return c => {
    if (!c) return '#888';
    if (!c.startsWith('--')) return c;
    if (!cache.has(c)) cache.set(c, cs.getPropertyValue(c).trim() || '#888');
    return cache.get(c);
  };
}

export function cssFonts(root = document.documentElement) {
  const cs = getComputedStyle(root);
  return { ui: cs.getPropertyValue('--font-ui').trim(), mono: cs.getPropertyValue('--font-mono').trim() };
}

export class Plot {
  /**
   * @param {HTMLElement} host
   * @param {{onHover?, onLabel?, onLabelHover?, onDblClick?, onBackground?, onView?}} handlers
   */
  constructor(host, handlers = {}) {
    this.host = host;
    this.h = handlers;
    this.canvas = document.createElement('canvas');
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.classList.add('overlay');
    this.svg.setAttribute('role', 'img');
    this.svg.setAttribute('aria-label', 'Raman spectrum');
    host.append(this.canvas, this.svg);
    this.ctx = this.canvas.getContext('2d');
    this.mctx = document.createElement('canvas').getContext('2d');
    this.scene = null;
    this.domain = null;
    this.view = null;
    this.frame = null;
    this.selectedId = null;
    this.hoverPx = null;
    this.reveal = null;
    this.pendingReveal = false;
    this.minSpan = 5;
    this._raf = 0;
    this._wire();
    new ResizeObserver(() => this.render()).observe(host);
  }

  /** Replace the scene. `domain` = [xmin, xmax] of the data; keeps the view unless resetView. */
  setScene(scene, { resetView = false } = {}) {
    const changedDomain = !this.domain || !scene.domain ||
      Math.abs(this.domain[0] - scene.domain[0]) > 1e-9 || Math.abs(this.domain[1] - scene.domain[1]) > 1e-9;
    this.scene = scene;
    this.domain = scene.domain || this.domain;
    this.minSpan = scene.minSpan || 5;
    if (resetView || changedDomain || !this.view) this.view = { x0: this.domain[0], x1: this.domain[1] };
    this.requestRender();
  }

  setSelected(id) { this.selectedId = id; this.requestRender(); }

  setView(x0, x1, { silent = false } = {}) {
    if (!this.domain) return;
    const [d0, d1] = this.domain, full = d1 - d0, pad = full * 0.02;
    let span = Math.max(this.minSpan, Math.min(full + 2 * pad, x1 - x0));
    let c = (x0 + x1) / 2;
    x0 = c - span / 2; x1 = c + span / 2;
    if (x0 < d0 - pad) { x1 += d0 - pad - x0; x0 = d0 - pad; }
    if (x1 > d1 + pad) { x0 -= x1 - d1 - pad; x1 = d1 + pad; }
    this.view = { x0, x1 };
    this.cancelReveal();
    this.requestRender();
    if (!silent && this.h.onView) this.h.onView(this.view);
  }

  resetView() { if (this.domain) this.setView(this.domain[0], this.domain[1]); }

  zoomBy(factor, cx) {
    if (!this.view) return;
    const { x0, x1 } = this.view;
    const c = cx == null ? (x0 + x1) / 2 : cx;
    this.setView(c - (c - x0) * factor, c + (x1 - c) * factor);
  }

  panBy(dxData) { if (this.view) this.setView(this.view.x0 + dxData, this.view.x1 + dxData); }

  /** Run the label reveal animation after the next render. */
  revealOnNextRender() { this.pendingReveal = true; this.requestRender(); }

  cancelReveal() { if (this.reveal) { this.reveal.cancel(); this.reveal = null; } }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  measure(text, font) { this.mctx.font = font; return this.mctx.measureText(text).width; }

  render() {
    const host = this.host;
    const W = Math.max(0, Math.floor(host.clientWidth)), H = Math.max(0, Math.floor(host.clientHeight));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    }
    this.svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.scene || !this.view || W < 120 || H < 120) { this.svg.innerHTML = ''; this.frame = null; return; }

    const root = document.documentElement;
    const scale = parseFloat(getComputedStyle(root).getPropertyValue('--scale')) || 1;
    const fonts = cssFonts(root);
    const margin = this.scene.margin || (this.scene.bottomPad ? { b: 46 * scale + this.scene.bottomPad } : undefined);
    const frame = computeFrame(this.scene, this.view, {
      width: W, height: H, scale, fonts, margin,
      measure: (t, f) => this.measure(t, f), labels: this.scene.showLabels !== false,
    });
    this.frame = frame;
    const pal = makePalette(root);
    const dark = root.dataset.theme !== 'light';

    for (const p of frame.panels) this._drawPanel(ctx, p, frame, pal, dark);

    // ---- overlay. A reveal in progress survives the rebuild: it resumes on the new
    // elements at the same point in time. Only a deliberate zoom/pan finishes it.
    const resumeAt = this.reveal ? performance.now() - this.revealT0 : null;
    this.reveal = null;
    this.svg.innerHTML =
      `<defs><linearGradient id="scanGrad" x1="0" x2="1"><stop offset="0" stop-color="${esc(pal('--laser'))}" stop-opacity="0"/><stop offset="1" stop-color="${esc(pal('--laser'))}" stop-opacity=".22"/></linearGradient></defs>` +
      `<g class="wins">${windowsMarkup(frame, this.scene.bandWindows)}</g>` +
      `<g class="axes">${axesMarkup(frame, this.scene)}</g>` +
      `<g class="spikes">${spikesMarkup(frame, this.scene.spikes)}</g>` +
      `<g class="labels">${labelsMarkup(frame, { selectedId: this.selectedId, dimOthers: this.scene.dimOthers })}</g>` +
      `<g class="cross"></g><g class="zoom"></g><g class="scan" style="pointer-events:none"></g>`;
    let rv = null;
    if (this.pendingReveal) {
      this.pendingReveal = false;
      this.revealT0 = performance.now();
      rv = revealLabels(this.svg, frame);
    } else if (resumeAt != null) {
      rv = revealLabels(this.svg, frame, { elapsed: resumeAt });
    }
    if (rv && rv.duration) {
      this.reveal = rv;
      rv.done.then(() => { if (this.reveal === rv) this.reveal = null; });
    }
    if (this.hoverPx) this._drawCross(this.hoverPx[0], this.hoverPx[1]);
  }

  _drawPanel(ctx, p, frame, pal, dark) {
    const { x, y, w, h } = p.rect;
    const s = frame.scale;
    // graticule
    ctx.save();
    ctx.lineWidth = 1;
    const xt = frame.xTicks, minor = xt.step / 5;
    ctx.strokeStyle = pal('--grid-minor');
    ctx.beginPath();
    for (let v = Math.ceil(frame.x0 / minor) * minor; v <= frame.x1; v += minor) {
      const px = Math.round(frame.sx(v)) + 0.5; if (px < x || px > x + w) continue;
      ctx.moveTo(px, y); ctx.lineTo(px, y + h);
    }
    ctx.stroke();
    ctx.strokeStyle = pal('--grid-major');
    ctx.beginPath();
    for (const v of xt.values) { const px = Math.round(frame.sx(v)) + 0.5; if (px < x || px > x + w) continue; ctx.moveTo(px, y); ctx.lineTo(px, y + h); }
    for (const v of p.yTicks.values) { const py = Math.round(p.sy(v)) + 0.5; if (py < y || py > y + h) continue; ctx.moveTo(x, py); ctx.lineTo(x + w, py); }
    ctx.stroke();
    ctx.restore();

    // traces
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y - 1, w, h + 2); ctx.clip();
    const order = [...p.traces].sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const tr of order) {
      if (tr.fill) this._fillTrace(ctx, tr, p, frame, pal);
      this._strokeTrace(ctx, tr, p, frame, pal, dark, s);
    }
    ctx.restore();
  }

  _visibleRange(tr, frame) {
    const n = tr.x.length;
    return [Math.max(0, lowerBound(tr.x, frame.x0) - 1), Math.min(n, lowerBound(tr.x, frame.x1) + 1)];
  }

  _pathTrace(ctx, tr, p, frame) {
    const xs = tr.x, ys = tr.y, off = tr.offset || 0;
    const [a, b] = this._visibleRange(tr, frame);
    let pen = false;
    if (b - a > frame.pw * 2.5) {
      let col = null, mn = 0, mx = 0, fy = 0, ly = 0;
      const flush = () => {
        if (col === null) return;
        if (pen) ctx.lineTo(col, fy); else { ctx.moveTo(col, fy); pen = true; }
        ctx.lineTo(col, mn); ctx.lineTo(col, mx); ctx.lineTo(col, ly);
      };
      for (let i = a; i < b; i++) {
        const v = ys[i] + off;
        if (!isFinite(v)) { flush(); col = null; pen = false; continue; }
        const c = Math.round(frame.sx(xs[i])), py = p.sy(v);
        if (c !== col) { flush(); col = c; mn = mx = fy = ly = py; }
        else { if (py < mn) mn = py; if (py > mx) mx = py; ly = py; }
      }
      flush();
    } else {
      for (let i = a; i < b; i++) {
        const v = ys[i] + off;
        if (!isFinite(v)) { pen = false; continue; }
        const X = frame.sx(xs[i]), Y = p.sy(v);
        if (pen) ctx.lineTo(X, Y); else { ctx.moveTo(X, Y); pen = true; }
      }
    }
  }

  _strokeTrace(ctx, tr, p, frame, pal, dark, s) {
    ctx.save();
    ctx.beginPath();
    this._pathTrace(ctx, tr, p, frame);
    ctx.strokeStyle = pal(tr.color);
    ctx.globalAlpha = tr.alpha == null ? 1 : tr.alpha;
    ctx.lineWidth = (tr.width || 1.2) * s;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (tr.dash) ctx.setLineDash(tr.dash.map(d => d * s));
    if (tr.glow && dark) { ctx.shadowColor = pal(tr.color); ctx.shadowBlur = 9 * s; }
    ctx.stroke();
    ctx.restore();
  }

  _fillTrace(ctx, tr, p, frame, pal) {
    const [a, b] = this._visibleRange(tr, frame);
    if (b - a < 2) return;
    const base = p.sy(Math.max(p.yLo, Math.min(p.yHi, tr.fill.to || 0)));
    ctx.save();
    ctx.beginPath();
    this._pathTrace(ctx, tr, p, frame);
    ctx.lineTo(frame.sx(tr.x[b - 1]), base);
    ctx.lineTo(frame.sx(tr.x[a]), base);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, p.rect.y, 0, p.rect.y + p.rect.h);
    const col = pal(tr.fill.color || tr.color);
    g.addColorStop(0, col); g.addColorStop(1, col);
    ctx.fillStyle = g;
    ctx.globalAlpha = tr.fill.alpha == null ? 0.08 : tr.fill.alpha;
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- crosshair
  _drawCross(px, py) {
    const frame = this.frame, g = this.svg.querySelector('g.cross');
    if (!frame || !g) return;
    const L = frame.margin.l, R = L + frame.pw;
    if (px < L || px > R) { g.innerHTML = ''; return; }
    const x = frame.ix(px), s = frame.scale;
    const top = frame.panels[0].rect.y, last = frame.panels[frame.panels.length - 1];
    const bottom = last.rect.y + last.rect.h;
    let out = `<line class="cross-v" x1="${px}" y1="${top}" x2="${px}" y2="${bottom}"/>`;
    let hit = null;
    for (const p of frame.panels) {
      const tr = p.traces.find(t => t.primary) || p.traces[0];
      if (!tr || !tr.x.length) continue;
      const v = interpAt(tr.x, tr.y, x) + (tr.offset || 0);
      if (!isFinite(v)) continue;
      const cy = p.sy(v);
      if (cy >= p.rect.y && cy <= p.rect.y + p.rect.h) out += `<circle class="cross-dot" cx="${px}" cy="${cy}" r="${3.6 * s}"/>`;
      if (!hit || (py >= p.rect.y && py <= p.rect.y + p.rect.h)) hit = { panelId: p.id, y: v };
    }
    const txt = x.toFixed(1);
    const tw = this.measure(txt, `500 ${10.5 * s}px ${cssFonts().mono}`) + 12 * s;
    out += `<g class="cross-tag"><rect x="${px - tw / 2}" y="${bottom + 3 * s}" width="${tw}" height="${16 * s}" rx="${4 * s}"/>` +
      `<text x="${px}" y="${bottom + 14.5 * s}" text-anchor="middle">${txt}</text></g>`;
    g.innerHTML = out;
    if (this.h.onHover) this.h.onHover({ x, y: hit ? hit.y : NaN, panelId: hit ? hit.panelId : null });
  }

  _clearCross() {
    this.hoverPx = null;
    const g = this.svg.querySelector('g.cross'); if (g) g.innerHTML = '';
    if (this.h.onHover) this.h.onHover(null);
  }

  // ------------------------------------------------------------- interaction
  _wire() {
    const host = this.host;
    host.tabIndex = 0;
    const pos = e => { const r = host.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const pointers = new Map();
    let drag = null, pinch = null, lastLabelHover = null;

    host.addEventListener('pointerdown', e => {
      if (!this.frame) return;
      host.focus({ preventScroll: true });
      const lbl = e.target.closest && e.target.closest('g.lbl');
      if (lbl && e.button === 0) { if (this.h.onLabel) this.h.onLabel(lbl.dataset.id); e.preventDefault(); return; }
      pointers.set(e.pointerId, pos(e));
      host.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), view: { ...this.view }, cx: this.frame.ix((a[0] + b[0]) / 2) };
        drag = null;
        return;
      }
      const [px, py] = pos(e);
      drag = { mode: e.shiftKey ? 'box' : 'pan', px, py, moved: false, view: { ...this.view } };
    });

    host.addEventListener('pointermove', e => {
      const [px, py] = pos(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [px, py]);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
        const f = pinch.d / d, c = pinch.cx, v = pinch.view;
        this.setView(c - (c - v.x0) * f, c + (v.x1 - c) * f);
        return;
      }
      if (drag && this.frame) {
        const dx = px - drag.px;
        if (Math.abs(dx) > 3 || Math.abs(py - drag.py) > 3) drag.moved = true;
        if (drag.mode === 'pan' && drag.moved) {
          host.classList.add('grab');
          const k = (drag.view.x1 - drag.view.x0) / this.frame.pw;
          this.setView(drag.view.x0 - dx * k, drag.view.x1 - dx * k);
        } else if (drag.mode === 'box') {
          const g = this.svg.querySelector('g.zoom');
          const p0 = this.frame.panels[0], pl = this.frame.panels[this.frame.panels.length - 1];
          const a = Math.min(px, drag.px), w = Math.abs(dx);
          if (g) g.innerHTML = `<rect class="zoombox" x="${a}" y="${p0.rect.y}" width="${w}" height="${pl.rect.y + pl.rect.h - p0.rect.y}"/>`;
        }
        return;
      }
      if (e.pointerType !== 'touch') {
        this.hoverPx = [px, py];
        this._drawCross(px, py);
        const lbl = e.target.closest && e.target.closest('g.lbl');
        const id = lbl ? lbl.dataset.id : null;
        if (id !== lastLabelHover) { lastLabelHover = id; if (this.h.onLabelHover) this.h.onLabelHover(id); }
      }
    });

    const end = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) return;
      host.classList.remove('grab');
      const [px] = pos(e);
      if (drag.mode === 'box') {
        const g = this.svg.querySelector('g.zoom'); if (g) g.innerHTML = '';
        if (Math.abs(px - drag.px) > 6 && this.frame) {
          const a = this.frame.ix(Math.min(px, drag.px)), b = this.frame.ix(Math.max(px, drag.px));
          this.setView(a, b);
        }
      } else if (!drag.moved && this.frame && this.h.onBackground && e.type === 'pointerup') {
        this.h.onBackground(this.frame.ix(px));
      }
      drag = null;
    };
    host.addEventListener('pointerup', end);
    host.addEventListener('pointercancel', end);
    host.addEventListener('pointerleave', e => { if (!drag && e.pointerType !== 'touch') this._clearCross(); });

    host.addEventListener('dblclick', e => {
      if (!this.frame || (e.target.closest && e.target.closest('g.lbl'))) return;
      const [px, py] = pos(e);
      const p = this.frame.panels.find(q => py >= q.rect.y && py <= q.rect.y + q.rect.h) || this.frame.panels[0];
      if (px < this.frame.margin.l || px > this.frame.margin.l + this.frame.pw) return;
      if (this.h.onDblClick) this.h.onDblClick(this.frame.ix(px), p.id);
    });

    host.addEventListener('wheel', e => {
      if (!this.frame || !this.view) return;
      e.preventDefault();
      const [px] = pos(e);
      const k = (this.view.x1 - this.view.x0) / this.frame.pw;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        this.panBy((e.deltaX || e.deltaY) * k);
      } else {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const f = Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.006 : 0.0016));
        this.zoomBy(f, this.frame.ix(px));
      }
    }, { passive: false });
  }
}
