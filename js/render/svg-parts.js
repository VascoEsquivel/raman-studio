// SVG markup builders shared by the live overlay and the exported figure.
// They emit class names only; the live page styles them with app.css and the
// export embeds an equivalent <style> block with resolved colours.

import { fmtTick, lowerBound } from './frame.js';

export const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = v => (Math.round(v * 10) / 10).toString();

/** Axes: tick marks, tick labels, panel tags and axis titles. */
export function axesMarkup(frame, scene) {
  const s = frame.scale;
  let out = '';
  const last = frame.panels[frame.panels.length - 1];
  for (const p of frame.panels) {
    const { x, y, w, h } = p.rect;
    out += `<line class="ax-line" x1="${f1(x)}" y1="${f1(y + h)}" x2="${f1(x + w)}" y2="${f1(y + h)}"/>`;
    for (const v of p.yTicks.values) {
      const py = p.sy(v);
      if (py < y - 0.5 || py > y + h + 0.5) continue;
      out += `<line class="ax-tick" x1="${f1(x - 5 * s)}" y1="${f1(py)}" x2="${f1(x)}" y2="${f1(py)}"/>`;
      out += `<text class="ax-text" x="${f1(x - 8 * s)}" y="${f1(py + 3.6 * s)}" text-anchor="end">${esc(fmtTick(v, p.yTicks.step))}</text>`;
    }
    if (p.zeroLine && 0 > p.yLo && 0 < p.yHi) {
      out += `<line class="resid-zero" x1="${f1(x)}" y1="${f1(p.sy(0))}" x2="${f1(x + w)}" y2="${f1(p.sy(0))}"/>`;
    }
    if (p.tag) out += `<text class="panel-tag" x="${f1(x + 10 * s)}" y="${f1(y + 15 * s)}">${esc(p.tag)}</text>`;
    if (p !== last) continue;
    for (const v of frame.xTicks.values) {
      const px = frame.sx(v);
      if (px < x - 0.5 || px > x + w + 0.5) continue;
      out += `<line class="ax-tick" x1="${f1(px)}" y1="${f1(y + h)}" x2="${f1(px)}" y2="${f1(y + h + 5 * s)}"/>`;
      out += `<text class="ax-text" x="${f1(px)}" y="${f1(y + h + 18 * s)}" text-anchor="middle">${esc(fmtTick(v, frame.xTicks.step))}</text>`;
    }
  }
  if (last) {
    const { x, y, w, h } = last.rect;
    out += `<text class="ax-title" x="${f1(x + w / 2)}" y="${f1(y + h + 36 * s)}" text-anchor="middle">${esc(scene.xLabel || 'Raman shift (cm⁻¹)')}</text>`;
  }
  const first = frame.panels[0];
  if (first && first.yLabel) {
    const cy = first.rect.y + first.rect.h / 2;
    out += `<text class="ax-title" transform="translate(${f1(14 * s)} ${f1(cy)}) rotate(-90)" text-anchor="middle">${esc(first.yLabel)}</text>`;
  }
  return out;
}

/** Shaded band windows (e.g. the hovered or selected band's match window). */
export function windowsMarkup(frame, windows) {
  if (!windows || !windows.length || !frame.panels.length) return '';
  const top = frame.panels[0].rect.y, last = frame.panels[frame.panels.length - 1];
  const bottom = last.rect.y + last.rect.h, s = frame.scale;
  let out = '';
  for (const wdw of windows) {
    const a = Math.max(frame.margin.l, frame.sx(wdw.lo)), b = Math.min(frame.margin.l + frame.pw, frame.sx(wdw.hi));
    if (!(b > a)) continue;
    out += `<rect class="bandwin" x="${f1(a)}" y="${f1(top)}" width="${f1(b - a)}" height="${f1(bottom - top)}"/>`;
    out += `<line class="bandwin-edge" x1="${f1(a)}" y1="${f1(top)}" x2="${f1(a)}" y2="${f1(bottom)}"/>`;
    out += `<line class="bandwin-edge" x1="${f1(b)}" y1="${f1(top)}" x2="${f1(b)}" y2="${f1(bottom)}"/>`;
    if (wdw.label) out += `<text class="bandwin-label" x="${f1((a + b) / 2)}" y="${f1(bottom - 8 * s)}" text-anchor="middle">${esc(wdw.label)}</text>`;
  }
  return out;
}

/** Removed cosmic-ray spikes: ring + cross at the original point, optional tag. */
export function spikesMarkup(frame, spikes) {
  if (!spikes || !spikes.length) return '';
  const s = frame.scale;
  const tag = spikes.length <= 4;
  const tagW = 84 * s;
  let lastTagRight = -Infinity;
  let out = '';
  for (const sp of [...spikes].sort((a, b) => a.x - b.x)) {
    const p = frame.panels.find(q => q.id === sp.panelId);
    if (!p || sp.x < frame.x0 || sp.x > frame.x1) continue;
    const px = frame.sx(sp.x);
    const yBot = Math.min(p.rect.y + p.rect.h, p.sy(sp.yBottom));
    // Cosmic rays can be many times taller than the bands; a full-height mark
    // would read as a cursor. Cap it and point an arrow up when clipped.
    const cap = 56 * s;
    let yTop = Math.max(p.rect.y + 8 * s, p.sy(sp.yTop));
    const clipped = yBot - yTop > cap;
    if (clipped) yTop = yBot - cap;
    out += `<line class="spike-mark" x1="${f1(px)}" y1="${f1(yBot)}" x2="${f1(px)}" y2="${f1(yTop)}" stroke-dasharray="2 2"/>`;
    const d = 3 * s;
    if (clipped) {
      out += `<path class="spike-mark" fill="none" d="M${f1(px - 4 * s)} ${f1(yTop + 4 * s)}L${f1(px)} ${f1(yTop)}L${f1(px + 4 * s)} ${f1(yTop + 4 * s)}"/>`;
    } else {
      out += `<circle class="spike-ring" cx="${f1(px)}" cy="${f1(yTop)}" r="${f1(6 * s)}"/>`;
      out += `<path class="spike-mark" d="M${f1(px - d)} ${f1(yTop - d)}L${f1(px + d)} ${f1(yTop + d)}M${f1(px + d)} ${f1(yTop - d)}L${f1(px - d)} ${f1(yTop + d)}"/>`;
    }
    out += `<circle class="spike-ring" cx="${f1(px)}" cy="${f1(yBot)}" r="${f1(3.2 * s)}"/>`;
    // tag only where it fits: on a narrow plot neighbouring tags would collide
    if (tag && px + 8 * s > lastTagRight && px + 8 * s + tagW < p.rect.x + p.rect.w) {
      out += `<text class="spike-tag" x="${f1(px + 8 * s)}" y="${f1(yTop + 4 * s)}">cosmic ray${clipped ? ' ↑' : ''}</text>`;
      lastTagRight = px + 8 * s + tagW;
    }
  }
  return out;
}

/** Labels with leader lines; `animate` adds the elements the reveal animation drives. */
export function labelsMarkup(frame, { selectedId = null, dimOthers = false } = {}) {
  const s = frame.scale;
  let out = '';
  for (const pl of frame.placements) {
    const L = pl.label;
    const kind = L.kind || 'detected';
    const sel = L.id === selectedId;
    const cls = `lbl ${kind === 'detected' ? '' : kind}${sel ? ' sel' : ''}${dimOthers && selectedId && !sel ? ' dim' : ''}`;
    const pts = pl.leader && pl.leader.length >= 2 ? pl.leader : [[pl.anchorX, pl.anchorY], [pl.cx, pl.y + pl.h]];
    const ax = pl.anchorX, ay = pl.anchorY;
    const d = 'M' + pts.map(q => f1(q[0]) + ' ' + f1(q[1])).join('L');
    const dashed = kind === 'fit';
    const tbox = 'transform-box:fill-box;transform-origin:center';
    if (pl.overflow) {
      // No room for a callout without overlapping another: keep a clickable apex
      // marker so the peak is still visible (and listed in the Peaks panel).
      out += `<g class="${cls} overflow" data-id="${esc(L.id)}" data-ax="${f1(ax)}"><title>${esc(L.sym)} ${esc(L.sub || '')}</title>` +
        `<circle class="ping" cx="${f1(ax)}" cy="${f1(ay)}" r="${f1(3.5 * s)}" style="${tbox}"/>` +
        `<circle class="apex" cx="${f1(ax)}" cy="${f1(ay)}" r="${f1(3.4 * s)}" style="${tbox}"/></g>`;
      continue;
    }
    out += `<g class="${cls}" data-id="${esc(L.id)}" data-ax="${f1(ax)}" tabindex="-1">` +
      `<path class="lead" d="${d}"${dashed ? '' : ' pathLength="1" stroke-dasharray="1"'}/>` +
      `<circle class="ping" cx="${f1(ax)}" cy="${f1(ay)}" r="${f1(3.5 * s)}" style="${tbox}"/>` +
      `<circle class="apex" cx="${f1(ax)}" cy="${f1(ay)}" r="${f1(3 * s)}" style="${tbox}"/>` +
      `<g class="card" style="transform-box:fill-box;transform-origin:50% 100%">` +
      `<rect class="box" x="${f1(pl.x)}" y="${f1(pl.y)}" width="${f1(pl.w)}" height="${f1(pl.h)}" rx="${f1(6 * s)}"/>` +
      `<text class="sym" x="${f1(pl.cx)}" y="${f1(pl.y + 15.5 * s)}" text-anchor="middle">${esc(L.sym)}</text>` +
      (L.sub ? `<text class="pos" x="${f1(pl.cx)}" y="${f1(pl.y + 27.5 * s)}" text-anchor="middle">${esc(L.sub)}</text>` : '') +
      `</g></g>`;
  }
  return out;
}

/** SVG path `d` for a trace, min/max-decimated per pixel column when dense. */
export function tracePathD(tr, panel, frame) {
  const xs = tr.x, ys = tr.y, off = tr.offset || 0, n = xs.length;
  const a = Math.max(0, lowerBound(xs, frame.x0) - 1), b = Math.min(n, lowerBound(xs, frame.x1) + 1);
  const cols = frame.pw;
  let d = '', pen = false;
  if (b - a > cols * 2.5) {
    let col = null, mn = 0, mx = 0, firstY = 0, lastY = 0;
    const flush = () => {
      if (col === null) return;
      const X = f1(col);
      d += (pen ? 'L' : 'M') + X + ' ' + f1(firstY);
      if (mn !== firstY) d += 'L' + X + ' ' + f1(mn);
      if (mx !== mn) d += 'L' + X + ' ' + f1(mx);
      if (lastY !== mx) d += 'L' + X + ' ' + f1(lastY);
      pen = true;
    };
    for (let i = a; i < b; i++) {
      const v = ys[i] + off;
      if (!isFinite(v)) { flush(); col = null; pen = false; continue; }
      const c = Math.round(frame.sx(xs[i])), py = panel.sy(v);
      if (c !== col) { flush(); col = c; mn = mx = firstY = lastY = py; }
      else { if (py < mn) mn = py; if (py > mx) mx = py; lastY = py; }
    }
    flush();
  } else {
    for (let i = a; i < b; i++) {
      const v = ys[i] + off;
      if (!isFinite(v)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + f1(frame.sx(xs[i])) + ' ' + f1(panel.sy(v));
      pen = true;
    }
  }
  return d;
}
