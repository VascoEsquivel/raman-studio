// Small DOM helpers shared by the UI modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Band libraries carry short inline-HTML fragments copied verbatim from the
   atlas (<b>, <i>, <sub>, <span class='mono'>, entities). A library file can be
   dropped in by anyone, so render through an allowlist instead of innerHTML. */
const ALLOWED = new Set(['B', 'I', 'EM', 'STRONG', 'SUB', 'SUP', 'BR', 'SPAN', 'SMALL', 'CODE']);
export function richText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html == null ? '' : html);
  const walk = node => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 1) {
        if (!ALLOWED.has(ch.tagName)) { ch.replaceWith(document.createTextNode(ch.textContent)); continue; }
        const cls = ch.getAttribute('class');
        for (const a of [...ch.attributes]) ch.removeAttribute(a.name);
        if (ch.tagName === 'SPAN' && cls === 'mono') ch.setAttribute('class', 'mono');
        walk(ch);
      } else if (ch.nodeType !== 3) {
        ch.remove();
      }
    }
  };
  walk(tpl.content);
  const div = document.createElement('div');
  div.appendChild(tpl.content);
  return div.innerHTML;
}

/** Plain text of an atlas HTML fragment (for SVG text, CSV, captions). */
export function plainText(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html == null ? '' : html);
  return tpl.content.textContent.replace(/\s+/g, ' ').trim();
}

/** Number formatting for the UI: significant digits, no trailing zeros. */
export function fmt(v, sig = 4) {
  if (v == null || !isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2);
  const s = v.toPrecision(sig);
  return s.includes('.') && !s.includes('e') ? s.replace(/\.?0+$/, '') : s;
}
export const fmtX = v => (v == null || !isFinite(v)) ? '—' : v.toFixed(1);
export const fmtSigned = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d);

let toastTimer = 0;
export function toast(msg, { warn = false, ms = 2400 } = {}) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('warn', warn);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function download(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/** Close a popover/menu when clicking outside or pressing Escape. */
export function dismissable(el, onClose, ignore = []) {
  const away = e => { if (!el.contains(e.target) && !ignore.some(i => i && i.contains(e.target))) close(); };
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); onClose(); }
  setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', key, true); }, 0);
  return close;
}

/** Fill a range input's track up to its value (WebKit has no progress pseudo). */
export function paintRange(input) {
  const min = +input.min || 0, max = +input.max || 100, v = +input.value;
  input.style.setProperty('--p', ((v - min) / ((max - min) || 1) * 100) + '%');
}
