// Overview strip under the plot: the whole spectrum with the current view
// window. Click or drag to move the view; double-click to show everything.

import { makePalette } from './plot.js';
import { lowerBound } from './frame.js';

export class Minimap {
  constructor(host, { onView } = {}) {
    this.host = host;
    this.onView = onView;
    this.canvas = document.createElement('canvas');
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.data = null;
    this.view = null;
    this._wire();
    new ResizeObserver(() => this.render()).observe(host);
  }

  setData(x, y) { this.data = x && x.length ? { x, y } : null; this.render(); }
  setView(view) { this.view = view; this.render(); }

  render() {
    const W = this.host.clientWidth, H = this.host.clientHeight;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.data || W < 20) return;
    const pal = makePalette();
    const { x, y } = this.data;
    const x0 = x[0], x1 = x[x.length - 1];
    let lo = Infinity, hi = -Infinity;
    for (const v of y) if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const sx = v => (v - x0) / ((x1 - x0) || 1) * W;
    const sy = v => H - 3 - (v - lo) / ((hi - lo) || 1) * (H - 6);
    ctx.fillStyle = pal('--panel'); ctx.globalAlpha = 0.85; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    ctx.beginPath();
    const step = Math.max(1, Math.floor(x.length / (W * 2)));
    for (let i = 0; i < x.length; i += step) { const X = sx(x[i]), Y = sy(y[i]); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }
    ctx.strokeStyle = pal('--ink-3'); ctx.lineWidth = 1; ctx.stroke();
    if (this.view) {
      const a = Math.max(0, sx(this.view.x0)), b = Math.min(W, sx(this.view.x1));
      ctx.fillStyle = pal('--laser'); ctx.globalAlpha = 0.14; ctx.fillRect(a, 0, b - a, H);
      ctx.globalAlpha = 1; ctx.strokeStyle = pal('--laser'); ctx.lineWidth = 1.2;
      ctx.strokeRect(a + 0.5, 0.5, Math.max(1, b - a - 1), H - 1);
      // re-stroke the spectrum inside the window in the laser colour
      ctx.save(); ctx.beginPath(); ctx.rect(a, 0, b - a, H); ctx.clip();
      ctx.beginPath();
      const i0 = Math.max(0, lowerBound(x, this.view.x0) - 1), i1 = Math.min(x.length, lowerBound(x, this.view.x1) + 1);
      for (let i = i0; i < i1; i += step) { const X = sx(x[i]), Y = sy(y[i]); if (i > i0) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }
      ctx.strokeStyle = pal('--laser'); ctx.stroke(); ctx.restore();
    }
  }

  _wire() {
    let dragging = false, grabOffset = 0;
    const toX = e => {
      const r = this.canvas.getBoundingClientRect();
      const { x } = this.data; const x0 = x[0], x1 = x[x.length - 1];
      return x0 + (e.clientX - r.left) / r.width * (x1 - x0);
    };
    this.canvas.addEventListener('pointerdown', e => {
      if (!this.data || !this.view) return;
      dragging = true; this.canvas.setPointerCapture(e.pointerId);
      const xv = toX(e), { x0, x1 } = this.view;
      grabOffset = xv >= x0 && xv <= x1 ? xv - (x0 + x1) / 2 : 0;
      this._moveTo(xv - grabOffset);
    });
    this.canvas.addEventListener('pointermove', e => { if (dragging) this._moveTo(toX(e) - grabOffset); });
    const stop = () => { dragging = false; };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
    this.canvas.addEventListener('dblclick', () => {
      if (this.data && this.onView) this.onView(this.data.x[0], this.data.x[this.data.x.length - 1]);
    });
  }

  _moveTo(center) {
    if (!this.view || !this.onView) return;
    const half = (this.view.x1 - this.view.x0) / 2;
    this.onView(center - half, center + half);
  }
}
