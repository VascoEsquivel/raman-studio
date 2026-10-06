/* Label placement for peak annotations — the layout behind the label reveal.

   A label wants to sit centred just above its peak, `lift` px clear of both the
   apex and the trace beneath the box, with a leader dropping straight to the
   apex. When peaks crowd together (the D / D″ / G / D′ cluster of graphene
   oxide is the hard case) that is impossible for everyone, so each label picks
   among candidate slots — small sideways nudges, snug spots beside labels that
   are already placed, then higher tiers — the one with the lowest cost:

       displacement from the ideal spot + leader length
       + heavy penalties for a leader through another box, a box over another
         leader, two leaders crossing, and labels out of left-to-right order.

   Hard constraints, never traded against cost: boxes do not overlap (with
   `gap`), stay inside the bounds, and sit above the trace beneath them. If a
   label cannot be placed that way it is returned with `overflow: true` so the
   renderer can hide or fade it.

   Higher-priority labels are placed first (they get the best spots), then one
   refinement sweep re-places every label knowing where all the others ended up,
   which fixes crossings that greedy placement could not see coming. No
   randomness and fully specified tie-breaks: the same input always gives the
   same layout, so labels never jitter between redraws.

   Pure: numbers in, numbers out. Screen coordinates, y grows downwards. */

const EPS = 1e-9;
const INSET = 0.5;        // px: a leader grazing a box edge does not count as crossing it
const TIER_CAP = 256;     // hard stop for the open-ended searches

// Sideways nudges tried in the first pass, as fractions of the label width.
const OFFSETS = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1, 1.5, -1.5, 2, -2];

// Cost weights, in px-equivalents. Shifting is a little cheaper than rising, so a
// half-width nudge beats a new tier but a full-width shove does not. Penalties are
// large enough that any clean slot beats any slot with a crossing.
const W_SHIFT = 1;
const W_RISE = 0.8;
const W_LEADER = 0.15;
const W_HIT = 800;        // leader through a box, or box over a leader
const W_CROSS = 400;      // leader crossing leader
const W_ORDER = 150;      // label order disagrees with anchor order

/**
 * Place peak labels so they do not collide, stay in bounds and sit above the trace.
 * @param {Array<{id:*, ax:number, ay:number, w:number, h:number, priority?:number}>} items
 *   anchor (peak apex, px) and label box size (px); higher priority is placed first
 * @param {object} opts
 * @param {number} opts.left   plot bounds, px (boxes stay inside)
 * @param {number} opts.right
 * @param {number} opts.top
 * @param {number} opts.bottom
 * @param {number} [opts.gap=4]       minimum clearance between boxes, px
 * @param {number} [opts.lift=14]     clearance between a box and the apex / trace below it, px
 * @param {(xa:number, xb:number) => number} [opts.ceiling] topmost (smallest) screen y of the
 *   trace over [xa, xb]; without it only the apex is avoided
 * @param {number} [opts.maxTiers=6]  tiers tried before the wider fallback searches
 * @returns {Array<{id:*, x:number, y:number, cx:number, anchorX:number, anchorY:number, tier:number,
 *   leader:number[][], overflow:boolean}>} one placement per item, in input order; x, y is the
 *   box's top-left corner, cx its centre; leader runs from the anchor to the box
 */
export function layoutLabels(items, opts = {}) {
  const list = items ? Array.from(items) : [];
  if (!list.length) return [];
  const o = options(opts || {});
  const recs = list.map((it, i) => record(it || {}, i));
  const order = recs.filter(r => r.ok).sort((a, b) => b.pr - a.pr || a.ax - b.ax || a.i - b.i);

  const placed = [];
  for (const r of order) {
    const best = place(r, placed, o);
    if (best) { commit(r, best); placed.push(r); }
  }

  // Greedy placement cannot see labels that come later; one sweep with everyone
  // known removes most of the crossings and order swaps that causes.
  for (const r of order) {
    const others = placed.filter(p => p !== r);
    const best = place(r, others, o);
    if (!best) continue;
    if (!r.box) { commit(r, best); placed.push(r); continue; }
    if (best.cost < currentCost(r, others, o) - 1e-6) commit(r, best);
  }

  return recs.map(r => output(r, o));
}

function options(opts) {
  const n = (v, d) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    left: n(opts.left, 0), right: n(opts.right, Infinity),
    top: n(opts.top, 0), bottom: n(opts.bottom, Infinity),
    gap: Math.max(0, n(opts.gap, 4)), lift: Math.max(0, n(opts.lift, 14)),
    maxTiers: Math.max(1, Math.floor(n(opts.maxTiers, 6))),
    ceiling: typeof opts.ceiling === 'function' ? opts.ceiling : null,
  };
}

function record(it, i) {
  const ax = Number(it.ax), ay = Number(it.ay), w = Number(it.w), h = Number(it.h), pr = Number(it.priority);
  return {
    i, id: it.id, ax, ay, w: Math.max(0, w), h: Math.max(0, h), pr: Number.isFinite(pr) ? pr : 0,
    ok: [ax, ay, w, h].every(Number.isFinite),
    cache: new Map(), ideal: undefined,
    box: null, leader: null, cx: NaN, ext: null,
  };
}

function clampX(r, x, o) { return Math.min(Math.max(x, o.left), o.right - r.w); }

/** Trace ceiling under a box starting at x, cached per label (the callback may scan pixels). */
function ceilAt(r, x, o) {
  if (!o.ceiling) return Infinity;
  let v = r.cache.get(x);
  if (v === undefined) {
    v = Number(o.ceiling(x, x + r.w));
    if (Number.isNaN(v)) v = Infinity;
    r.cache.set(x, v);
  }
  return v;
}

/**
 * Lowest allowed box bottom for a box at x: `lift` above the trace beneath it,
 * and above the apex too unless this is the "beside the peak" fallback (a box
 * that spans the anchor column is always kept above the apex).
 */
function floorAt(r, x, o, above) {
  let f = Math.min(ceilAt(r, x, o) - o.lift, o.bottom);
  if (above || (x < r.ax + o.gap && x + r.w > r.ax - o.gap)) f = Math.min(f, r.ay - o.lift);
  return Number.isFinite(f) ? f : r.ay - o.lift;
}

function idealFloor(r, o) {
  if (r.ideal === undefined) r.ideal = floorAt(r, clampX(r, r.ax - r.w / 2, o), o, true);
  return r.ideal;
}

/** Phase 0 is the normal search; 1 widens it to the whole plot and any height; 2 also allows boxes beside the apex. */
function place(r, others, o) {
  for (let phase = 0; phase < 3; phase++) {
    const best = search(r, others, o, phase);
    if (best) return best;
  }
  return null;
}

function candidateXs(r, others, o, phase) {
  const xs = [], seen = new Set();
  const add = x => {
    const c = clampX(r, x, o), k = Math.round(c * 1024);
    if (!seen.has(k)) { seen.add(k); xs.push(c); }
  };
  const x0 = r.ax - r.w / 2;
  for (const f of OFFSETS) add(x0 + f * r.w);
  // Snug spots touching a neighbour (exactly `gap` away) let a crowded label stay
  // on tier 0 with the smallest possible shift.
  const reach = 2.5 * r.w;
  for (const p of others) {
    const B = p.box;
    if (B.x2 + o.gap < x0 - reach || B.x - o.gap > x0 + r.w + reach) continue;
    add(B.x2 + o.gap);
    add(B.x - o.gap - r.w);
  }
  if (phase > 0) {
    let a = o.left, b = o.right - r.w;
    if (!Number.isFinite(a)) a = x0 - 10 * r.w;
    if (!Number.isFinite(b)) b = x0 + 10 * r.w;
    const step = Math.max(1, Math.min(r.w / 2, (b - a) / 128));
    for (let k = 0, m = Math.ceil((b - a) / step); k <= m; k++) add(Math.min(a + k * step, b));
  }
  return xs;
}

function search(r, others, o, phase) {
  const { w, h, ax, ay } = r;
  if (w > o.right - o.left + EPS || h > o.bottom - o.top + EPS) return null;
  const above = phase < 2;
  const step = Math.max(h + o.gap, 1);
  const maxRise = phase === 0 ? (o.maxTiers - 1) * step + EPS : Infinity;
  const xs = candidateXs(r, others, o, phase);

  // Only labels whose box, leader or anchor reaches the candidate strip can collide,
  // cross or swap order with this one; skipping the rest keeps big layouts fast.
  let lo = ax, hi = ax;
  for (const x of xs) { if (x < lo) lo = x; if (x + w > hi) hi = x + w; }
  lo -= o.gap; hi += o.gap;
  const near = others.filter(p => p.ext[1] >= lo && p.ext[0] <= hi);

  const ideal = idealFloor(r, o);
  const cands = [];
  const push = (x, b) => cands.push({ x, b, cheap: cheapCost(r, x, b, ideal), seq: cands.length });
  for (const x of xs) {
    const floor = floorAt(r, x, o, above);
    if (!(floor - h >= o.top - EPS)) continue;
    for (let t = 0; t < TIER_CAP && t * step <= maxRise; t++) {
      const b = floor - t * step;
      if (b - h < o.top - EPS) break;
      push(x, b);
    }
    // Resting directly on top of a neighbour is often tighter than a whole tier.
    for (const p of near) {
      const B = p.box;
      if (!(B.x < x + w + o.gap - EPS && x < B.x2 + o.gap - EPS)) continue;
      const b = B.y - o.gap;
      if (b > floor + EPS || b - h < o.top - EPS || floor - b > maxRise) continue;
      push(x, b);
    }
  }
  cands.sort((a, b) => a.cheap - b.cheap || a.seq - b.seq);

  let best = null;
  for (const c of cands) {
    if (best && c.cheap >= best.cost - EPS) break;   // penalties only add: nothing later can win
    const box = { x: c.x, y: c.b - h, x2: c.x + w, y2: c.b };
    if (collides(box, near, o.gap)) continue;
    for (const L of leaders(r, box)) {
      const cost = c.cheap + penalty(r, box, L, near);
      if (!best || cost < best.cost - EPS) best = { box, leader: L, cost };
    }
  }
  return best;
}

/** Displacement + leader length: the part of the cost that needs no neighbours. */
function cheapCost(r, x, b, ideal) {
  const cx = x + r.w / 2, adx = Math.abs(cx - r.ax);
  return W_SHIFT * adx + W_RISE * Math.max(0, ideal - b) + W_LEADER * leaderLength(r, x, b);
}

function leaderLength(r, x, b) {
  const cx = x + r.w / 2, adx = Math.abs(cx - r.ax);
  if (isBeside(r, x, x + r.w, b)) {
    const sx = cx < r.ax ? x + r.w : x;
    return Math.hypot(sx - r.ax, b - r.h / 2 - r.ay);
  }
  const rise = r.ay - b;
  return adx < 1 || adx >= rise ? Math.hypot(adx, rise) : rise - adx + adx * Math.SQRT2;
}

/** A box beside the apex (fallback phase) rather than above it: the leader goes to its side. */
function isBeside(r, x, x2, b) { return b > r.ay - 0.5 && !(x <= r.ax && r.ax <= x2); }

/**
 * Leader variants for a box. Above the apex: straight when the box is (nearly)
 * centred or far off to the side; otherwise a 45° elbow, either stem-first (the
 * usual callout look) or diagonal-first (dodges a box sitting right above the
 * apex). Beside the apex: one straight segment to the nearer side's middle.
 */
function leaders(r, box) {
  const { ax, ay } = r, cx = (box.x + box.x2) / 2, by = box.y2;
  if (isBeside(r, box.x, box.x2, by)) return [[[ax, ay], [cx < ax ? box.x2 : box.x, (box.y + box.y2) / 2]]];
  const adx = Math.abs(cx - ax), rise = ay - by;
  if (adx < 1 || adx >= rise) return [[[ax, ay], [cx, by]]];
  return [
    [[ax, ay], [ax, by + adx], [cx, by]],
    [[ax, ay], [cx, ay - adx], [cx, by]],
  ];
}

function collides(a, others, gap) {
  for (const p of others) {
    const b = p.box;
    if (a.x < b.x2 + gap - EPS && b.x < a.x2 + gap - EPS && a.y < b.y2 + gap - EPS && b.y < a.y2 + gap - EPS) return true;
  }
  return false;
}

function penalty(r, box, L, near) {
  const cx = (box.x + box.x2) / 2;
  let pen = 0;
  for (const p of near) {
    if (polyHitsRect(L, p.box)) pen += W_HIT;
    if (polyHitsRect(p.leader, box)) pen += W_HIT;
    if (polysCross(L, p.leader)) pen += W_CROSS;
    const da = p.ax - r.ax, dc = p.cx - cx;
    if ((da > 0.5 && dc < -0.5) || (da < -0.5 && dc > 0.5)) pen += W_ORDER;
  }
  return pen;
}

function currentCost(r, others, o) {
  return cheapCost(r, r.box.x, r.box.y2, idealFloor(r, o)) + penalty(r, r.box, r.leader, others);
}

function commit(r, best) {
  r.box = best.box;
  r.leader = best.leader;
  r.cx = (best.box.x + best.box.x2) / 2;
  let a = Math.min(best.box.x, r.ax), b = Math.max(best.box.x2, r.ax);
  for (const [x] of best.leader) { if (x < a) a = x; if (x > b) b = x; }
  r.ext = [a, b];
}

/** Does any segment of polyline L pass through the interior of box B (inset by INSET)? */
function polyHitsRect(L, B) {
  for (let k = 1; k < L.length; k++) {
    if (segHitsRect(L[k - 1][0], L[k - 1][1], L[k][0], L[k][1], B)) return true;
  }
  return false;
}

function segHitsRect(x1, y1, x2, y2, B) {
  const L = B.x + INSET, R = B.x2 - INSET, T = B.y + INSET, D = B.y2 - INSET;
  if (L >= R || T >= D) return false;
  if (Math.max(x1, x2) <= L || Math.min(x1, x2) >= R || Math.max(y1, y2) <= T || Math.min(y1, y2) >= D) return false;
  // Slab clipping (Liang–Barsky): the segment hits if its parameter interval inside both slabs is non-empty.
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  if (dx !== 0) {
    let ta = (L - x1) / dx, tb = (R - x1) / dx;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 >= t1) return false;
  } else if (x1 <= L || x1 >= R) return false;
  if (dy !== 0) {
    let ta = (T - y1) / dy, tb = (D - y1) / dy;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
  } else if (y1 <= T || y1 >= D) return false;
  return t0 < t1;
}

/** Do two polylines properly cross (touching at an endpoint, e.g. a shared anchor, does not count)? */
function polysCross(A, B) {
  for (let i = 1; i < A.length; i++) {
    for (let j = 1; j < B.length; j++) {
      if (segsCross(A[i - 1], A[i], B[j - 1], B[j])) return true;
    }
  }
  return false;
}

function segsCross(p1, p2, q1, q2) {
  if (Math.max(p1[0], p2[0]) < Math.min(q1[0], q2[0]) || Math.max(q1[0], q2[0]) < Math.min(p1[0], p2[0]) ||
      Math.max(p1[1], p2[1]) < Math.min(q1[1], q2[1]) || Math.max(q1[1], q2[1]) < Math.min(p1[1], p2[1])) return false;
  const d1 = orient(q1, q2, p1), d2 = orient(q1, q2, p2), d3 = orient(p1, p2, q1), d4 = orient(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function orient(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }

function output(r, o) {
  if (r.box) {
    const f = floorAt(r, r.box.x, o, true);
    const tier = Number.isFinite(f) ? Math.max(0, Math.round((f - r.box.y2) / Math.max(r.h + o.gap, 1))) : 0;
    return {
      id: r.id, x: r.box.x, y: r.box.y, cx: r.cx, anchorX: r.ax, anchorY: r.ay, tier,
      leader: r.leader.map(p => [p[0], p[1]]), overflow: false,
    };
  }
  // Best effort for a label that cannot be placed: centred over the anchor and
  // clamped into the bounds. It may overlap; the renderer decides whether to show it.
  let x = Number.isFinite(r.ax) ? r.ax - r.w / 2 : o.left;
  x = Math.max(Math.min(x, o.right - r.w), o.left);
  if (!Number.isFinite(x)) x = Number.isFinite(r.ax) ? r.ax - r.w / 2 : 0;
  let y = Number.isFinite(r.ay) ? r.ay - o.lift - r.h : o.top;
  y = Math.max(Math.min(y, o.bottom - r.h), o.top);
  if (!Number.isFinite(y)) y = Number.isFinite(r.ay) ? r.ay - o.lift - r.h : 0;
  const cx = x + r.w / 2;
  const leader = r.ok ? [[r.ax, r.ay], [cx, y + r.h]] : [];
  return { id: r.id, x, y, cx, anchorX: r.ax, anchorY: r.ay, tier: 0, leader, overflow: true };
}
