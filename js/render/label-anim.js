// The demo moment: a laser scan line sweeps the spectrum and each label
// appears as the beam crosses its peak. The apex dot flashes, a ring pings
// outward, the leader line draws up from the peak and the callout snaps in.
// Uses the Web Animations API with fill:'backwards', so every element is held
// at its first keyframe until its own delay elapses: no flash of final state.

const SCAN_EASE = 'linear';           // linear keeps beam position ↔ time trivially in sync
const CARD_EASE = 'cubic-bezier(.3, 1.4, .5, 1)';

/**
 * Animate every `.lbl` group in the overlay SVG.
 * @param {SVGSVGElement} svg
 * @param {object} frame  computeFrame() result (margin, pw, panels)
 * @returns {{cancel: () => void, done: Promise<void>}}
 */
export function revealLabels(svg, frame) {
  const groups = [...svg.querySelectorAll('g.lbl')];
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!groups.length || reduce) return { cancel() {}, done: Promise.resolve() };

  const left = frame.margin.l, right = left + frame.pw;
  const D = Math.max(1300, Math.min(2700, 1050 + 75 * groups.length));
  const anims = [];

  // ---- the beam
  const scan = svg.querySelector('g.scan');
  if (scan && frame.panels.length) {
    const top = frame.panels[0].rect.y - 6, last = frame.panels[frame.panels.length - 1];
    const bottom = last.rect.y + last.rect.h;
    scan.innerHTML =
      `<rect class="scanglow" x="-46" y="${top}" width="46" height="${bottom - top}"/>` +
      `<line class="scanline" x1="0" y1="${top}" x2="0" y2="${bottom}"/>`;
    const sweep = scan.animate(
      [{ transform: `translateX(${left}px)`, opacity: 0 }, { opacity: 1, offset: 0.04 },
        { opacity: 1, offset: 0.92 }, { transform: `translateX(${right}px)`, opacity: 0 }],
      { duration: D, easing: SCAN_EASE, fill: 'both' });
    anims.push(sweep);
    sweep.finished.then(() => { scan.innerHTML = ''; }).catch(() => {});
  }

  // ---- labels, staggered by where the beam crosses each anchor
  for (const g of groups) {
    const ax = +g.dataset.ax;
    const delay = Math.max(0, D * (ax - left) / (right - left || 1));
    const apex = g.querySelector('.apex');
    const ping = g.querySelector('.ping');
    const lead = g.querySelector('.lead');
    const card = g.querySelector('.card');
    if (apex) anims.push(apex.animate(
      [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.9)', opacity: 1, offset: 0.45 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 360, delay, easing: 'ease-out', fill: 'backwards' }));
    if (ping) anims.push(ping.animate(
      [{ transform: 'scale(1)', opacity: 0.95 }, { transform: 'scale(5.5)', opacity: 0 }],
      { duration: 700, delay, easing: 'cubic-bezier(.1,.6,.3,1)', fill: 'both' }));
    if (lead) {
      const dashed = g.classList.contains('fit');
      anims.push(dashed
        ? lead.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: delay + 90, fill: 'backwards' })
        : lead.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
          { duration: 280, delay: delay + 60, easing: 'ease-out', fill: 'backwards' }));
    }
    if (card) anims.push(card.animate(
      [{ opacity: 0, transform: 'translateY(9px) scale(.86)' }, { opacity: 1, transform: 'none' }],
      { duration: 340, delay: delay + 200, easing: CARD_EASE, fill: 'backwards' }));
  }

  const done = Promise.allSettled(anims.map(a => a.finished)).then(() => {});
  return {
    cancel() { for (const a of anims) { try { a.finish(); } catch { /* already gone */ } } },
    done,
  };
}
