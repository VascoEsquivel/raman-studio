// Label layout: hard guarantees checked as properties over many random plots,
// plus the crowded graphene-oxide D/G cluster that the layout exists for.
// Traces are synthetic; the cluster's band positions and schematic shapes come
// from the library, never typed in.
import { test, assert, assertEqual, assertClose, assertDeepEqual, rng, gauss } from './harness.js';
import { layoutLabels } from '../js/render/label-layout.js';
import { peakY } from '../js/fit/profile.js';

const lib = await (await fetch(new URL('../data/libraries/graphene-go.json', import.meta.url))).json();

const TOL = 1e-6;

/** ceiling(xa, xb) over a per-pixel profile whose column 0 sits at screen x = x0. */
function ceilingOf(profile, x0, fallback) {
  return (xa, xb) => {
    const a = Math.max(0, Math.floor(xa - x0)), b = Math.min(profile.length - 1, Math.ceil(xb - x0));
    let m = Infinity;
    for (let i = a; i <= b; i++) if (profile[i] < m) m = profile[i];
    return Number.isFinite(m) ? m : fallback;
  };
}

function segHitsBox(p, q, B) {
  // Inset by half a pixel: touching an edge is not crossing it.
  const L = B.x + 0.5, R = B.x + B.w - 0.5, T = B.y + 0.5, D = B.y + B.h - 0.5;
  let t0 = 0, t1 = 1;
  const dx = q[0] - p[0], dy = q[1] - p[1];
  for (const [d, a, lo, hi] of [[dx, p[0], L, R], [dy, p[1], T, D]]) {
    if (d === 0) { if (a <= lo || a >= hi) return false; continue; }
    let ta = (lo - a) / d, tb = (hi - a) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 >= t1) return false;
  }
  return t0 < t1;
}

function segsCross(p1, p2, q1, q2) {
  const o = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return o(q1, q2, p1) * o(q1, q2, p2) < 0 && o(p1, p2, q1) * o(p1, p2, q2) < 0;
}

/** Assert every hard guarantee for the placed (non-overflow) labels; returns the boxes. */
function checkLayout(items, out, opts, tag) {
  assertEqual(out.length, items.length, `${tag}: one placement per item`);
  const boxes = [];
  out.forEach((p, i) => {
    const it = items[i];
    assertEqual(p.id, it.id, `${tag}: input order kept`);
    assertEqual(p.anchorX, it.ax, `${tag}: anchorX`);
    assertEqual(p.anchorY, it.ay, `${tag}: anchorY`);
    assertClose(p.cx, p.x + it.w / 2, TOL, `${tag}: cx is the box centre`);
    for (const k of ['x', 'y', 'cx', 'tier']) assert(Number.isFinite(p[k]), `${tag}: finite ${k}`);
    assertEqual(typeof p.overflow, 'boolean', `${tag}: overflow flag`);
    if (p.overflow) return;
    const B = { x: p.x, y: p.y, w: it.w, h: it.h, i };
    assert(p.x >= opts.left - TOL && p.x + it.w <= opts.right + TOL, `${tag}: ${it.id} inside left/right`);
    assert(p.y >= opts.top - TOL && p.y + it.h <= opts.bottom + TOL, `${tag}: ${it.id} inside top/bottom`);
    if (opts.ceiling) {
      const c = opts.ceiling(p.x, p.x + it.w);
      assert(p.y + it.h <= c - (opts.lift ?? 14) + TOL, `${tag}: ${it.id} above the trace (bottom ${p.y + it.h}, ceiling ${c})`);
    }
    assert(p.tier >= 0 && Number.isInteger(p.tier), `${tag}: integer tier`);
    // Leader: starts at the anchor and ends on the box outline.
    assert(p.leader.length >= 2, `${tag}: leader has points`);
    assertDeepEqual(p.leader[0], [it.ax, it.ay], `${tag}: leader starts at the anchor`);
    const [ex, ey] = p.leader[p.leader.length - 1];
    const onBottom = Math.abs(ey - (p.y + it.h)) < TOL && Math.abs(ex - p.cx) < TOL;
    const onSide = (Math.abs(ex - p.x) < TOL || Math.abs(ex - p.x - it.w) < TOL) && ey >= p.y - TOL && ey <= p.y + it.h + TOL;
    assert(onBottom || onSide, `${tag}: leader ends on the box`);
    if (p.y + it.h <= it.ay - 0.5) assert(onBottom, `${tag}: above the apex the leader meets the bottom centre`);
    boxes.push(B);
  });
  const gap = opts.gap ?? 4;
  for (let a = 0; a < boxes.length; a++) {
    for (let b = a + 1; b < boxes.length; b++) {
      const A = boxes[a], C = boxes[b];
      const sepX = Math.max(C.x - (A.x + A.w), A.x - (C.x + C.w));
      const sepY = Math.max(C.y - (A.y + A.h), A.y - (C.y + C.h));
      assert(sepX >= gap - TOL || sepY >= gap - TOL,
        `${tag}: boxes ${items[A.i].id} and ${items[C.i].id} closer than gap (${sepX.toFixed(3)}, ${sepY.toFixed(3)})`);
    }
  }
  return boxes;
}

/** Random plot: a baseline with Gaussian peaks, one label per peak at its apex column. */
function randomScene(seed) {
  const r = rng(seed);
  const left = 30 + Math.floor(r() * 40), width = 300 + Math.floor(r() * 1100);
  const top = 10 + Math.floor(r() * 30), height = 180 + Math.floor(r() * 320);
  const right = left + width, bottom = top + height;
  const base = bottom - 8;
  const nPk = 1 + Math.floor(r() * 32);
  const peaks = Array.from({ length: nPk }, () => ({
    c: left + r() * width, s: 2 + r() * 30, a: (0.15 + 0.6 * r()) * height,
  }));
  const prof = new Float64Array(width + 1);
  for (let k = 0; k <= width; k++) {
    let y = base + 0.6 * gauss(r);
    for (const p of peaks) { const d = (left + k - p.c) / p.s; y -= p.a * Math.exp(-0.5 * d * d); }
    prof[k] = Math.max(top - 20, y);
  }
  const items = peaks.map((p, i) => {
    // Anchor on the highest column near the nominal centre, like a detected apex.
    let k = Math.round(p.c - left), best = Math.max(0, Math.min(width, k));
    for (let j = Math.max(0, k - 2); j <= Math.min(width, k + 2); j++) if (prof[j] < prof[best]) best = j;
    return {
      id: 'p' + i, ax: left + best, ay: prof[best],
      w: Math.round(18 + r() * 50), h: r() < 0.5 ? 22 : 33, priority: Math.floor(r() * 4),
    };
  });
  const opts = { left, right, top, bottom, gap: 3 + Math.floor(r() * 4), lift: 8 + Math.floor(r() * 10), maxTiers: 6 };
  opts.ceiling = ceilingOf(prof, left, bottom);
  return { items, opts, prof };
}

test('empty input gives an empty layout', () => {
  assertDeepEqual(layoutLabels([], { left: 0, right: 100, top: 0, bottom: 100 }), []);
  assertDeepEqual(layoutLabels(null, {}), []);
});

test('a single label sits centred, lift px above apex and trace, with a vertical leader', () => {
  const prof = new Float64Array(201).map((_, k) => 180 - 120 * Math.exp(-0.5 * ((k - 100) / 6) ** 2));
  const opts = { left: 0, right: 200, top: 0, bottom: 200, ceiling: ceilingOf(prof, 0, 200) };
  const [p] = layoutLabels([{ id: 'G', ax: 100, ay: prof[100], w: 30, h: 20, priority: 1 }], opts);
  assertEqual(p.overflow, false);
  assertEqual(p.tier, 0);
  assertClose(p.cx, 100, 1e-9, 'centred');
  assertClose(p.y + 20, prof[100] - 14, 1e-9, 'default lift 14 above the apex');
  assertDeepEqual(p.leader, [[100, prof[100]], [100, prof[100] - 14]]);
});

test('a box over a broad shoulder clears the trace beneath it, not just the apex', () => {
  // The apex is low but the trace rises to the right, under the box.
  const prof = new Float64Array(201).map((_, k) => 150 - 0.5 * Math.max(0, k - 95));
  const opts = { left: 0, right: 200, top: 0, bottom: 200, lift: 10, ceiling: ceilingOf(prof, 0, 200) };
  const [p] = layoutLabels([{ id: 'a', ax: 95, ay: 150, w: 40, h: 16 }], opts);
  assertEqual(p.overflow, false);
  assert(p.y + 16 <= opts.ceiling(p.x, p.x + 40) - 10 + 1e-9, 'lift above the highest trace point under the box');
});

test('higher priority wins the spot above a shared peak', () => {
  const opts = { left: 0, right: 300, top: 0, bottom: 300 };
  const out = layoutLabels([
    { id: 'low', ax: 150, ay: 200, w: 40, h: 20, priority: 0 },
    { id: 'high', ax: 150, ay: 200, w: 40, h: 20, priority: 5 },
  ], opts);
  const high = out.find(p => p.id === 'high'), low = out.find(p => p.id === 'low');
  assertClose(high.cx, 150, 1e-9, 'high priority centred');
  assertEqual(high.tier, 0);
  assertClose(high.y + 20, 186, 1e-9, 'high priority at its resting height');
  assert(low.y + 20 <= high.y - 4 + 1e-9 || Math.abs(low.cx - 150) > 20, 'low priority moved out of the way');
});

test('neighbours keep their left-to-right order and do not cross leaders', () => {
  const opts = { left: 0, right: 400, top: 0, bottom: 300 };
  const items = [0, 1, 2, 3, 4].map(k => ({ id: 'n' + k, ax: 170 + 15 * k, ay: 220 - 10 * (k % 2), w: 40, h: 20, priority: k % 2 }));
  const out = layoutLabels(items, opts);
  checkLayout(items, out, opts, 'order');
  for (let k = 1; k < out.length; k++) assert(out[k].cx > out[k - 1].cx, `label ${k} right of label ${k - 1}`);
  for (let a = 0; a < out.length; a++) {
    for (let b = a + 1; b < out.length; b++) {
      const A = out[a].leader, B = out[b].leader;
      for (let i = 1; i < A.length; i++) for (let j = 1; j < B.length; j++) {
        assert(!segsCross(A[i - 1], A[i], B[j - 1], B[j]), `leaders ${a} and ${b} cross`);
      }
    }
  }
});

test('random plots: no overlaps, inside bounds, above the trace, valid leaders (200 seeds)', () => {
  // Every scene must satisfy the hard constraints. Overflow is only judged on
  // scenes where the labels could physically fit: "crowding" = total label area
  // (with gaps) / free area above the trace. Many random scenes need more room
  // than exists (crowding > 1), and there overflow is the correct answer.
  let placed = 0, overflow = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const { items, opts, prof } = randomScene(seed);
    const out = layoutLabels(items, opts);
    checkLayout(items, out, opts, 'seed ' + seed);
    let free = 0;
    for (let k = 0; k < prof.length; k++) free += Math.max(0, prof[k] - (opts.lift ?? 14) - opts.top);
    const need = items.reduce((a, it) => a + (it.w + opts.gap) * (it.h + opts.gap), 0);
    if (need / free >= 0.5) continue;
    for (const p of out) p.overflow ? overflow++ : placed++;
  }
  assert(placed + overflow > 1500, 'enough feasible labels to judge');
  assert(overflow <= 0.02 * (placed + overflow), `overflow ${overflow} of ${placed + overflow} in feasible scenes`);
});

test('random plots: deterministic (same input, same layout)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const a = randomScene(seed), b = randomScene(seed);
    assertEqual(JSON.stringify(layoutLabels(a.items, a.opts)), JSON.stringify(layoutLabels(b.items, b.opts)), 'seed ' + seed);
  }
});

test('random plots with ample headroom: nothing overflows', () => {
  for (let seed = 300; seed < 360; seed++) {
    const { items, opts } = randomScene(seed);
    const few = items.slice(0, 6);
    const roomy = { ...opts, top: opts.top - 400 };
    const out = layoutLabels(few, roomy);
    checkLayout(few, out, roomy, 'roomy ' + seed);
    assert(out.every(p => !p.overflow), 'seed ' + seed + ' overflowed');
  }
});

/** The graphene-oxide first-order region from the atlas schematic, drawn into a 440-px plot. */
function goCluster() {
  const left = 40, width = 440, top = 20, height = 300, bottom = top + height;
  const x0 = 1000, x1 = 1800, sx = v => left + (v - x0) / (x1 - x0) * width;
  const comps = lib.bands.filter(b => b.region === 'first').map(b => ({
    id: b.id, label: b.label, x0: b.plot.mu, w: b.plot.sig * 2.3548, h: b.plot.A, g: 50,
  }));
  const sum = cm => comps.reduce((a, c) => a + peakY(c, cm), 0);
  let peakMax = 0;
  for (let k = 0; k <= width; k++) peakMax = Math.max(peakMax, sum(x0 + k / width * (x1 - x0)));
  // Trace fills 70 % of the panel, leaving the top 30 % as label headroom.
  const sy = v => bottom - 6 - v / peakMax * 0.7 * height;
  const prof = new Float64Array(width + 1);
  for (let k = 0; k <= width; k++) prof[k] = sy(sum(x0 + k / width * (x1 - x0)));
  const items = comps.map((c, i) => ({
    id: c.id, ax: sx(c.x0), ay: sy(sum(c.x0)), w: 30 + 6 * c.label.length, h: 33, priority: Math.round(10 * c.h), label: c.label,
  }));
  // A sixth label: the apparent maximum of the G envelope (a detected peak), which
  // in GO sits close to — but not exactly at — the G centre, so it competes with G and D′.
  const Gc = comps.find(c => c.id === 'G');
  let kMax = Math.round(sx(Gc.x0) - left);
  for (let k = kMax - 30; k <= kMax + 30; k++) if (prof[k] < prof[kMax]) kMax = k;
  items.push({ id: 'Gapex', ax: left + kMax, ay: prof[kMax], w: 52, h: 33, priority: 1, label: 'G max' });
  const opts = { left, right: left + width, top, bottom, gap: 5, lift: 12, maxTiers: 7, ceiling: ceilingOf(prof, left, bottom) };
  return { items: items.map(({ label, ...it }) => it), labels: items.map(i => i.label), opts };
}

test('GO D/G cluster: six labels within ~250 px all fit, cleanly', () => {
  const { items, opts } = goCluster();
  assertEqual(items.length, 6);
  const span = Math.max(...items.map(i => i.ax)) - Math.min(...items.map(i => i.ax));
  assert(span <= 260, `anchors span ${span.toFixed(0)} px`);
  const out = layoutLabels(items, opts);
  const boxes = checkLayout(items, out, opts, 'cluster');
  assert(out.every(p => !p.overflow), 'no overflow in the cluster');
  // No leader passes through another label's box.
  out.forEach((p, i) => {
    for (const B of boxes) {
      if (B.i === i) continue;
      for (let k = 1; k < p.leader.length; k++) {
        assert(!segHitsBox(p.leader[k - 1], p.leader[k], B), `leader of ${p.id} crosses box of ${items[B.i].id}`);
      }
    }
  });
  // And no two leaders cross.
  for (let a = 0; a < out.length; a++) {
    for (let b = a + 1; b < out.length; b++) {
      const A = out[a].leader, B = out[b].leader;
      for (let i = 1; i < A.length; i++) for (let j = 1; j < B.length; j++) {
        assert(!segsCross(A[i - 1], A[i], B[j - 1], B[j]), `leaders of ${out[a].id} and ${out[b].id} cross`);
      }
    }
  }
  // Stays compact: nothing needs more than three tiers here.
  assert(out.every(p => p.tier <= 3), 'tiers ' + out.map(p => p.tier).join(','));
  assertEqual(JSON.stringify(layoutLabels(items, opts)), JSON.stringify(out), 'deterministic');
});

test('a clipped peak with no headroom above it gets a label beside it', () => {
  // Apex at the very top of the plot; the trace beside it is low.
  const prof = new Float64Array(301).map((_, k) => 290 - 280 * Math.exp(-0.5 * ((k - 150) / 4) ** 2));
  const opts = { left: 0, right: 300, top: 0, bottom: 300, lift: 10, ceiling: ceilingOf(prof, 0, 300) };
  const items = [{ id: 'tall', ax: 150, ay: prof[150], w: 40, h: 20 }];
  const out = layoutLabels(items, opts);
  checkLayout(items, out, opts, 'clipped');
  assertEqual(out[0].overflow, false);
  assert(out[0].x + 40 <= 150 || out[0].x >= 150, 'box does not cover the apex');
});

test('impossible labels are flagged as overflow, inside the bounds where possible', () => {
  const opts = { left: 0, right: 100, top: 0, bottom: 100 };
  const out = layoutLabels([
    { id: 'wide', ax: 50, ay: 80, w: 140, h: 10 },
    { id: 'bad', ax: NaN, ay: 10, w: 10, h: 10 },
  ], opts);
  assertEqual(out[0].overflow, true);
  assertEqual(out[1].overflow, true);
  assertDeepEqual(out[1].leader, []);
  // A flat trace touching the top leaves no room anywhere.
  const flat = layoutLabels([{ id: 'f', ax: 50, ay: 5, w: 20, h: 10 }], { ...opts, ceiling: () => 5 });
  assertEqual(flat[0].overflow, true);
  assert(flat[0].y >= 0 && flat[0].x >= 0 && flat[0].x + 20 <= 100, 'clamped into bounds');
});

test('120 labels lay out in under 50 ms', () => {
  const r = rng(2024);
  const left = 60, width = 1600, top = 20, height = 420, bottom = top + height;
  const peaks = Array.from({ length: 120 }, (_, i) => ({ c: left + 8 + (i + r() * 0.8) * (width - 16) / 120, s: 2 + r() * 6, a: (0.2 + 0.5 * r()) * height }));
  const prof = new Float64Array(width + 1);
  for (let k = 0; k <= width; k++) {
    let y = bottom - 8;
    for (const p of peaks) { const d = (left + k - p.c) / p.s; if (Math.abs(d) < 6) y -= p.a * Math.exp(-0.5 * d * d); }
    prof[k] = y;
  }
  const items = peaks.map((p, i) => {
    const k = Math.round(p.c - left);
    return { id: i, ax: left + k, ay: prof[k], w: 26 + Math.round(r() * 22), h: 22, priority: Math.floor(r() * 3) };
  });
  const opts = { left, right: left + width, top, bottom, gap: 4, lift: 12, maxTiers: 6, ceiling: ceilingOf(prof, left, bottom) };
  layoutLabels(items.slice(0, 40), opts);   // warm the JIT on a different input
  const t0 = performance.now();
  const out = layoutLabels(items, opts);
  const ms = performance.now() - t0;
  checkLayout(items, out, opts, 'perf');
  assert(ms < 50, `took ${ms.toFixed(1)} ms`);
  assert(out.filter(p => p.overflow).length <= 6, 'overflow ' + out.filter(p => p.overflow).length);
});
