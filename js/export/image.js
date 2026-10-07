// Publication figure export: a standalone SVG built from the same frame
// geometry as the screen (render/frame.js), restyled on white "paper", with
// the fonts embedded so PNG rasterisation and other machines render it the same.

import { computeFrame } from '../render/frame.js';
import { axesMarkup, spikesMarkup, labelsMarkup, tracePathD, esc } from '../render/svg-parts.js';

const UI_FONT = "'IBM Plex Sans Condensed', 'Arial Narrow', Arial, sans-serif";
const MONO_FONT = "'IBM Plex Mono', Consolas, 'Courier New', monospace";

const LASER_INK = { 532: '#0b8a49', 633: '#cf3417', 785: '#b8124f' };
const PAPER = {
  bg: '#ffffff', ink: '#111111', ink2: '#3d3d3d', ink3: '#6f6f6f', grid: '#ececec', axis: '#1a1a1a',
  '--raw': '#8a8a8a', '--ink-2': '#3d3d3d', '--ink-3': '#8a8a8a', '--ink-4': '#b0b0b0', '--baseline': '#a8741b',
  '--fit': '#b86e00', '--fit-env': '#111111', '--spike': '#d81b45', '--unassigned': '#6d6d6d', '--region': '#0f8b7d',
};

function paperColor(token, laserNm) {
  if (!token) return PAPER.ink;
  if (token === '--laser') return LASER_INK[laserNm] || '#0b8a49';
  if (token.startsWith('--overlay')) return token.split('|')[1] || PAPER['--ink-3'];
  if (token.startsWith('--')) return PAPER[token] || PAPER.ink3;
  return token;
}

function styleBlock(laserNm, fontFaces) {
  const L = LASER_INK[laserNm] || '#0b8a49';
  return `${fontFaces || ''}
  text{font-family:${UI_FONT}}
  .ax-text{fill:${PAPER.ink2};font:500 11px ${MONO_FONT}}
  .ax-title{fill:${PAPER.ink2};font:500 12px ${UI_FONT};letter-spacing:.08em;text-transform:uppercase}
  .ax-line,.ax-tick{stroke:${PAPER.axis};stroke-width:1}
  .resid-zero{stroke:#bdbdbd;stroke-width:1}
  .panel-tag{fill:${PAPER.ink3};font:600 10px ${UI_FONT};letter-spacing:.16em;text-transform:uppercase}
  .lbl .ping{display:none}
  .lbl .box{fill:#ffffff;fill-opacity:.92;stroke:${L};stroke-width:1.4}
  .lbl .sym{fill:${PAPER.ink};font:600 14px ${UI_FONT}}
  .lbl .pos{fill:${PAPER.ink3};font:500 10px ${MONO_FONT}}
  .lbl .lead{fill:none;stroke:${L};stroke-opacity:.75;stroke-width:1.1}
  .lbl .apex{fill:${L}}
  .lbl.fit .box{stroke:${PAPER['--fit']};stroke-dasharray:4 3}
  .lbl.fit .lead{stroke:${PAPER['--fit']};stroke-dasharray:3 3}
  .lbl.fit .apex{fill:${PAPER['--fit']}}
  .lbl.unassigned .box,.lbl.unassigned .lead{stroke:${PAPER['--unassigned']}}
  .lbl.unassigned .apex{fill:${PAPER['--unassigned']}}
  .lbl.unassigned .sym{fill:${PAPER.ink2};font-size:12px}
  .lbl.region .box,.lbl.region .lead{stroke:${PAPER['--region']}}
  .lbl.region .apex{fill:${PAPER['--region']}}
  .lbl.region .sym{fill:${PAPER['--region']};font-size:12px;font-style:italic}
  .spike-mark{stroke:${PAPER['--spike']};stroke-width:1.4}
  .spike-ring{fill:none;stroke:${PAPER['--spike']};stroke-width:1.1;stroke-dasharray:2 2}
  .spike-tag{fill:${PAPER['--spike']};font:600 9.5px ${UI_FONT};letter-spacing:.08em;text-transform:uppercase}
  .legend text{fill:${PAPER.ink2};font:500 11px ${UI_FONT};letter-spacing:.03em}
  .title{fill:${PAPER.ink};font:600 16px ${UI_FONT};letter-spacing:.02em}
  .caption{fill:${PAPER.ink3};font:500 10.5px ${MONO_FONT}}`;
}

// ---- font embedding (Google Fonts subset for exactly the glyphs used) ----
const fontCache = new Map();
async function fetchWithTimeout(url, ms, as) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, mode: 'cors' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return as === 'text' ? await r.text() : await r.arrayBuffer();
  } finally { clearTimeout(t); }
}
function b64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Whole font step capped at 6 s: a slow or offline network falls back to system fonts. */
function embeddedFontFaces(chars) {
  return Promise.race([fetchFontFaces(chars), new Promise(r => setTimeout(() => r(''), 6000))]);
}
async function fetchFontFaces(chars) {
  const text = [...new Set(chars)].sort().join('');
  if (fontCache.has(text)) return fontCache.get(text);
  const fams = ['IBM+Plex+Sans+Condensed:ital,wght@0,500;0,600;1,600', 'IBM+Plex+Mono:wght@500'];
  try {
    let css = '';
    for (const f of fams) {
      css += await fetchWithTimeout(`https://fonts.googleapis.com/css2?family=${f}&text=${encodeURIComponent(text)}&display=block`, 4000, 'text');
    }
    const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
    for (const u of urls) {
      const buf = await fetchWithTimeout(u, 5000, 'buf');
      const fmt = /\.woff2(\?|$)/.test(u) || /woff2/.test(css) ? 'woff2' : 'truetype';
      css = css.split(u).join(`data:font/${fmt};base64,${b64(buf)}`);
    }
    fontCache.set(text, css);
    return css;
  } catch {
    fontCache.set(text, '');   // offline: fall back to system fonts
    return '';
  }
}

/**
 * Build the export SVG string.
 * @param {object} scene  scene used by the on-screen plot
 * @param {{x0:number,x1:number}} view
 * @param {{width?:number, height?:number, laserNm:number, title?:string, caption?:string, embedFonts?:boolean, legend?:Array}} o
 */
export async function buildFigureSVG(scene, view, o) {
  const W = o.width || 1400, H = o.height || 780;
  const mctx = document.createElement('canvas').getContext('2d');
  const measure = (t, f) => { mctx.font = f; return mctx.measureText(t).width; };
  const exportScene = { ...scene, panels: scene.panels.map(p => ({ ...p, tag: p.exportTag !== undefined ? p.exportTag : p.tag })) };
  const frame = computeFrame(exportScene, view, {
    width: W, height: H, scale: 1, measure,
    fonts: { ui: UI_FONT, mono: MONO_FONT },
    margin: { l: 70, r: 22, t: o.title ? 62 : 34, b: o.caption ? 70 : 52 },
  });
  const L = o.laserNm;
  let body = `<rect width="${W}" height="${H}" fill="${PAPER.bg}"/>`;
  let defs = '';
  frame.panels.forEach((p, i) => {
    const { x, y, w, h } = p.rect;
    defs += `<clipPath id="cp${i}"><rect x="${x}" y="${y - 1}" width="${w}" height="${h + 2}"/></clipPath>`;
    // light major grid
    let grid = '';
    for (const v of frame.xTicks.values) { const px = frame.sx(v); if (px >= x && px <= x + w) grid += `M${px.toFixed(1)} ${y}V${y + h}`; }
    for (const v of p.yTicks.values) { const py = p.sy(v); if (py >= y && py <= y + h) grid += `M${x} ${py.toFixed(1)}H${x + w}`; }
    body += `<path d="${grid}" stroke="${PAPER.grid}" stroke-width="1" fill="none"/>`;
    body += `<g clip-path="url(#cp${i})">`;
    for (const tr of [...p.traces].sort((a, b) => (a.z || 0) - (b.z || 0))) {
      const d = tracePathD(tr, p, frame);
      if (!d) continue;
      const col = paperColor(tr.color, L);
      if (tr.fill) {
        const base = p.sy(Math.max(p.yLo, Math.min(p.yHi, tr.fill.to || 0)));
        const first = d.match(/^M([-\d.]+)/), lastX = d.match(/([-\d.]+) [-\d.]+$/);
        if (first && lastX) body += `<path d="${d}L${lastX[1]} ${base.toFixed(1)}L${first[1]} ${base.toFixed(1)}Z" fill="${col}" fill-opacity="${Math.min(0.08, tr.fill.alpha ?? 0.06)}" stroke="none"/>`;
      }
      body += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${(tr.width || 1.2) * (tr.primary ? 1.05 : 1)}"` +
        `${tr.dash ? ` stroke-dasharray="${tr.dash.join(' ')}"` : ''}${tr.alpha != null && tr.alpha < 1 ? ` stroke-opacity="${tr.alpha}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    body += '</g>';
  });
  body += axesMarkup(frame, exportScene) + spikesMarkup(frame, scene.spikes) + labelsMarkup(frame, {});

  // legend
  const legend = o.legend || [];
  if (legend.length) {
    const lw = 18, rowH = 17, colW = legend.map(it => measure(it.text, `500 11px ${UI_FONT}`) + lw + 28);
    const total = colW.reduce((a, b) => a + b, 0);
    let lx = W - 22 - total, ly = (o.title ? 30 : 12);
    body += '<g class="legend">';
    legend.forEach((it, i) => {
      const col = paperColor(it.color, L), cy = ly + rowH / 2;
      if (it.box) body += `<rect x="${lx}" y="${cy - 6}" width="${lw}" height="12" rx="3" fill="#fff" stroke="${col}" stroke-width="1.4"${it.dash ? ' stroke-dasharray="4 3"' : ''}/>`;
      else body += `<line x1="${lx}" y1="${cy}" x2="${lx + lw}" y2="${cy}" stroke="${col}" stroke-width="2"${it.dash ? ' stroke-dasharray="4 3"' : ''}/>`;
      body += `<text x="${lx + lw + 6}" y="${cy + 4}">${esc(it.text)}</text>`;
      lx += colW[i];
    });
    body += '</g>';
  }
  if (o.title) body += `<text class="title" x="70" y="30">${esc(o.title)}</text>`;
  if (o.caption) body += `<text class="caption" x="70" y="${H - 12}">${esc(o.caption)}</text>`;

  const chars = (body.match(/>([^<>]+)</g) || []).map(s => s.slice(1, -1)).join('') + '0123456789.−-+cm⁻¹';
  const faces = o.embedFonts === false ? '' : await embeddedFontFaces(chars);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<style>${styleBlock(L, faces)}</style><defs>${defs}</defs>${body}</svg>`;
}

/** Rasterise an SVG string to a PNG Blob at `scale`× resolution. */
export function svgToPng(svg, scale = 3) {
  return new Promise((resolve, reject) => {
    const W = +(svg.match(/width="(\d+)/) || [])[1] || 1400, H = +(svg.match(/height="(\d+)/) || [])[1] || 780;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? resolve(b) : reject(new Error('PNG encoding failed')), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not rasterise the figure'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}
