// Plot geometry shared by the on-screen plot and the SVG/PNG export, so a
// figure exported from the app is laid out exactly like the screen.
//
// A "scene" describes what to draw in data units; a "frame" is that scene
// resolved to pixels for a given size and x-range: panel rectangles, scales,
// ticks, and label placements (via label-layout.js).

import { layoutLabels } from './label-layout.js';

/** PeakForge's nice tick step. */
export function niceStep(range, target = 8) {
  const raw = Math.abs(range) / target;
  if (!(raw > 0) || !isFinite(raw)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

export function ticks(lo, hi, target) {
  const step = niceStep(hi - lo, target);
  const out = [];
  const start = Math.ceil(lo / step - 1e-9) * step;
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return { step, values: out };
}

/** Compact number for tick labels: 12000 → 12k, 0.25 → 0.25. */
export function fmtTick(v, step) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(step >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(step >= 1e3 ? 0 : 1).replace(/\.0$/, '') + 'k';
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(dec);
}

/** Index of the first element ≥ v in an ascending array. */
export function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/** Linear interpolation of y at x on ascending xs. */
export function interpAt(xs, ys, x) {
  const n = xs.length;
  if (!n) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  const i = lowerBound(xs, x);
  const t = (x - xs[i - 1]) / ((xs[i] - xs[i - 1]) || 1);
  return ys[i - 1] + t * (ys[i] - ys[i - 1]);
}

function traceRange(tr, x0, x1) {
  let lo = Infinity, hi = -Infinity;
  const xs = tr.x, ys = tr.y, off = tr.offset || 0;
  const a = Math.max(0, lowerBound(xs, x0) - 1), b = Math.min(xs.length, lowerBound(xs, x1) + 1);
  for (let i = a; i < b; i++) {
    const v = ys[i] + off;
    if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  return [lo, hi];
}

/**
 * Resolve a scene to pixels.
 * @param {object} scene  { panels: [{ id, weight, traces, labels?, yLabel?, tag?, zeroLine?, headroom? }], xLabel }
 * @param {{x0:number, x1:number}} view
 * @param {{width:number, height:number, scale?:number, measure:(text:string, font:string)=>number,
 *          margin?:object, fonts?:object, labels?:boolean}} opts
 */
export function computeFrame(scene, view, opts) {
  const s = opts.scale || 1;
  const W = opts.width, H = opts.height;
  const M = Object.assign({ l: 62 * s, r: 18 * s, t: 46 * s, b: 46 * s }, opts.margin || {});
  const gap = 16 * s;
  const panels = scene.panels.filter(p => p.traces && p.traces.length);
  const totalW = panels.reduce((a, p) => a + (p.weight || 1), 0) || 1;
  const usableH = Math.max(40, H - M.t - M.b - gap * Math.max(0, panels.length - 1));
  const pw = Math.max(40, W - M.l - M.r);
  const { x0, x1 } = view;
  const sx = x => M.l + (x - x0) / ((x1 - x0) || 1) * pw;
  const ix = px => x0 + (px - M.l) / pw * (x1 - x0);

  let y = M.t;
  const out = [];
  for (const p of panels) {
    const ph = usableH * (p.weight || 1) / totalW;
    let lo = Infinity, hi = -Infinity;
    for (const tr of p.traces) {
      if (tr.noScale) continue;
      const [a, b] = traceRange(tr, x0, x1);
      if (a < lo) lo = a; if (b > hi) hi = b;
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (p.symmetric) { const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1; lo = -m; hi = m; }
    let span = (hi - lo) || Math.abs(hi) || 1;
    const head = p.headroom != null ? p.headroom : 0.08;
    hi += span * head;
    lo -= span * (p.symmetric ? 0.08 : 0.05);
    if (!p.symmetric && lo > 0 && lo < span * 0.3) lo = 0;
    const tk = ticks(lo, hi, Math.max(2, Math.round(ph / (46 * s))));
    const rect = { x: M.l, y, w: pw, h: ph };
    const yLo = lo, yHi = hi;
    const sy = v => rect.y + rect.h - (v - yLo) / ((yHi - yLo) || 1) * rect.h;
    const iy = py => yLo + (rect.y + rect.h - py) / rect.h * (yHi - yLo);
    out.push({ ...p, rect, yLo, yHi, sx, sy, iy, yTicks: tk });
    y += ph + gap;
  }

  const xt = ticks(x0, x1, Math.max(3, Math.round(pw / (90 * s))));
  const frame = { width: W, height: H, scale: s, margin: M, pw, x0, x1, sx, ix, panels: out, xTicks: xt, placements: [] };

  // ---- labels: lay out once per frame, against the trace ceiling of their panel
  if (opts.labels !== false) {
    for (const p of out) {
      if (!p.labels || !p.labels.length) continue;
      const top = topProfile(p, frame);
      const ceiling = (xa, xb) => {
        const a = Math.max(0, Math.floor(xa - p.rect.x)), b = Math.min(top.length - 1, Math.ceil(xb - p.rect.x));
        let m = Infinity;
        for (let i = a; i <= b; i++) if (top[i] < m) m = top[i];
        return isFinite(m) ? m : p.rect.y + p.rect.h;
      };
      const fSym = `600 ${14 * s}px ${opts.fonts?.ui || 'sans-serif'}`;
      const fPos = `500 ${10 * s}px ${opts.fonts?.mono || 'monospace'}`;
      const items = [];
      for (const L of p.labels) {
        if (L.x < x0 || L.x > x1) continue;
        const ax = sx(L.x), ay = p.sy(L.y);
        if (!isFinite(ay)) continue;
        const symW = opts.measure(L.sym, fSym), subW = L.sub ? opts.measure(L.sub, fPos) : 0;
        const w = Math.ceil(Math.max(symW, subW) + 14 * s);
        const h = Math.round((L.sub ? 33 : 22) * s);
        items.push({ id: L.id, ax, ay: Math.max(p.rect.y, ay), w, h, priority: L.priority || 0, label: L });
      }
      const placed = layoutLabels(items.map(({ label, ...it }) => it), {
        left: p.rect.x + 2, right: p.rect.x + p.rect.w - 2,
        top: p.rect.y - 4 * s, bottom: p.rect.y + p.rect.h,
        gap: 5 * s, lift: 12 * s, ceiling, maxTiers: 7,
      });
      const byId = new Map(items.map(i => [i.id, i]));
      for (const pl of placed) {
        const it = byId.get(pl.id);
        if (it) frame.placements.push({ ...pl, w: it.w, h: it.h, label: it.label, panelId: p.id });
      }
    }
  }
  return frame;
}

/** Highest (smallest px y) point of the panel's traces in each pixel column. */
export function topProfile(p, frame) {
  const n = Math.max(1, Math.ceil(p.rect.w) + 1);
  const top = new Float64Array(n).fill(Infinity);
  for (const tr of p.traces) {
    if (tr.noCeiling) continue;
    const xs = tr.x, ys = tr.y, off = tr.offset || 0;
    const a = Math.max(0, lowerBound(xs, frame.x0) - 1), b = Math.min(xs.length, lowerBound(xs, frame.x1) + 1);
    let prevC = -1, prevY = NaN;
    for (let i = a; i < b; i++) {
      const v = ys[i] + off;
      if (!isFinite(v)) { prevC = -1; continue; }
      const c = Math.round(frame.sx(xs[i]) - p.rect.x), py = p.sy(v);
      if (c >= 0 && c < n && py < top[c]) top[c] = py;
      // fill columns skipped between sparse samples so the profile has no holes
      if (prevC >= 0 && c - prevC > 1) {
        for (let k = prevC + 1; k < c; k++) {
          if (k < 0 || k >= n) continue;
          const t = (k - prevC) / (c - prevC), yy = prevY + t * (py - prevY);
          if (yy < top[k]) top[k] = yy;
        }
      }
      prevC = c; prevY = py;
    }
  }
  return top;
}
