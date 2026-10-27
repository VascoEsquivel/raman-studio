/* Cosmic-ray (spike) removal.

   A cosmic ray dumps charge into one or a few detector pixels, sometimes along
   a track that crosses many of them. What gives it away is not its width but
   its shape: real Raman bands are smooth and at least as wide as the
   instrument line shape, a cosmic ray is not. So the question asked of every
   suspicious feature is "could a real band have produced this?", never "is it
   narrow?" (an earlier version used a 3-point width cap: it missed wide tracks
   on real data and removed narrow real bands in noisy map spectra).

   1. Candidates. Each point is compared with a prediction that leaves a HOLE
      over it: a quadratic through the points hw+1 … hw+5 away on each side,
      for hole half-widths hw from 1 up to maxWidth. Runs standing more than
      `threshold` σ above the prediction (σ × the predictor's noise gain), no
      wider than hw and not lifting their neighbours (excess < half the run's),
      become candidates. σ is the Whitaker–Hayes noise: the median absolute
      deviation of the point-to-point differences, scaled to a Gaussian σ.
   2. Classification. In a window around the candidate a smooth model is
      fitted by least squares: a quadratic background (a broad band's flank or
      top, a fluorescence slope) plus one, or failing that two, non-negative
      pseudo-Voigt bands with FWHM between `minBand` and half the window.
      minBand is the narrowest real band: `minBandCm`, or by default
      AUTO_MIN_BAND_PTS sample spacings. The noise per point grows with the
      signal (shot noise, estimated from the spectrum itself) and is widened by
      SHAPE_TOL of the band signal, because real line shapes are not perfect
      pseudo-Voigts. A candidate is a spike only if the best model fails both
      statistically (χ² Wilson–Hilferty deviate > Z_CRIT, over the window or
      over the candidate and its neighbours) and materially (misses the feature
      by more than REL_MIN of its height), or misses it grossly (REL_GROSS) at
      the lower significance Z_GROSS: then no real band can be there. The
      background may include a step where the window holds a real jump outside
      the candidate. Otherwise the candidate stays.
   3. Removal is greedy, tallest spike first; after each removal the
      candidates whose windows it touched are judged again, so one spike cannot
      make a nearby band look wrong. A wide candidate containing a smaller
      spike is removed whole only if what remains once the small spike is gone
      is still not a band standing on both sides of it: a band with a spike on
      top keeps its band. A removal is trimmed to where it breaks away from the
      surrounding data, so it keeps a spike's shoulders but not the band under it.
   4. Companion spectra (the other spectra of the same map or series, on the
      same axis) are a second opinion. A removed feature that the companions
      show too (same peak point, similar profile) in at least RECUR of them is
      not random: if it is one point wide it is a fixed-pattern detector
      artifact (removed, and labelled as such), otherwise it is a real band and
      is put back.
   5. User edits: `keep` positions restore automatic removals; `zaps` ranges
      are interpolated by hand.
   Features that were left alone but look questionable (close to the spike
   criteria, or with companions: unique to this spectrum and tall, or a
   one-point artifact) are returned as `suspects` for a person to judge.

   Removed runs of up to 3 points are replaced by a quadratic through the 2
   clean points on each side (it follows a band top); longer runs and hand zaps
   by linear interpolation between the nearest clean neighbours (at an array
   edge: the nearest clean value). */

const NEIGHBOUR_FRACTION = 0.5;
const SCALES = [1, 2, 3, 5, 8, 12, 16, 20, 25];
const AUTO_MIN_BAND_PTS = 3;
const Z_CRIT = 4;          // χ² tail deviate above which no band explains a feature …
const REL_MIN = 0.15;      // … provided the best band model also misses it by this share of its height
const Z_GROSS = 3, REL_GROSS = 0.3;   // a gross miss (≥ 30 % of the height) needs less statistical weight
const INNER_SIGMA = 4;     // points this many σ above the best band model form the spike inside a wider candidate
const PROM_SIGMA = 3;      // a spike rises at least this many σ above the higher of its two neighbours
const Z_SUSPECT = 2.5;     // kept, but close enough to Z_CRIT to show the user
const SHAPE_TOL = 0.05;    // relative line-shape mismatch tolerated for real bands
const RECUR = 0.2;         // share of companion spectra that makes a feature recurring
const STEP_SIGMA = 6;      // a jump this many σ (of a difference) is a step the background may follow
const PRESENT_SIGMA = 4;   // a companion "has" a feature if it stands this many σ above its background
const LN2 = Math.LN2;

/**
 * Remove cosmic-ray spikes.
 * @param {ArrayLike<number>} x ascending Raman shift
 * @param {ArrayLike<number>} y intensity
 * @param {{threshold?:number, maxWidth?:number, minBandCm?:number|null,
 *   companions?:ArrayLike<number>[]|null, edits?:{keep?:number[], zaps?:[number,number][]}|null}} [opts]
 *   threshold: candidate excess over the local prediction in noise σ; maxWidth: widest spike in
 *   points (1–25); minBandCm: narrowest real band FWHM in cm⁻¹ (null/0 = AUTO_MIN_BAND_PTS spacings);
 *   companions: other spectra on the same x (≥ 4 used); edits: user keeps and zaps (cm⁻¹)
 * @returns {{y:Float64Array, removed:Array<{index:number,x:number,y:number,replacedY:number}>,
 *   spikes:Array<{start:number,end:number,xStart:number,xEnd:number,height:number,kind:string,misfit:number|null,share:number|null}>,
 *   suspects:Array<{start:number,end:number,xStart:number,xEnd:number,height:number,kind:string,misfit:number,share:number|null}>,
 *   restored:Array<{start:number,end:number,xStart:number,xEnd:number,height:number,kind:string,share:number|null}>,
 *   info:{sigma:number, shotNoise:number, spacing:number, minBandPts:number, minBandCm:number, minBandAuto:boolean,
 *     maxWidth:number, threshold:number, companions:number}}}
 *   spike kind: 'cosmic' | 'artifact' (one point, recurs in the companions) | 'manual' (zapped);
 *   suspect kind: 'suspect' | 'artifact'; restored kind: 'kept' (user) | 'recurring' (companions
 *   show the same feature); misfit: χ² deviate of the best real-band model; share: fraction of
 *   companions showing the feature (null without companions); companions: number used (0 if < 4).
 */
export function despike(x, y, { threshold = 6, maxWidth = 15, minBandCm = null, companions = null, edits = null } = {}) {
  const n = y ? y.length : 0;
  const Y = Float64Array.from(y || []);
  const X = Float64Array.from(x && x.length === n ? x : Array.from({ length: n }, (_, i) => i));
  const out = Float64Array.from(Y);
  const spacing = medianSpacing(X);
  const auto = !(minBandCm > 0);
  const minBandPts = Math.max(1, Math.min(50, auto ? AUTO_MIN_BAND_PTS : minBandCm / spacing));
  const mw = Math.max(1, Math.min(25, Math.round(maxWidth) || 15));
  const comps = (companions || []).filter(c => c && c.length === n);
  const info = { sigma: 0, spacing, minBandPts, minBandCm: minBandPts * spacing, minBandAuto: auto,
    maxWidth: mw, threshold, companions: comps.length >= 4 ? comps.length : 0 };
  const result = { y: out, removed: [], spikes: [], suspects: [], restored: [], info };
  const scales = SCALES.filter(h => h < mw).concat(mw).filter(h => n >= 2 * (h + SYM) + 1);
  for (let i = 0; i < n; i++) if (!Number.isFinite(Y[i])) return result;

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { if (Y[i] < lo) lo = Y[i]; if (Y[i] > hi) hi = Y[i]; }
  // A noiseless spectrum has σ = 0; a floor keeps rounding error from ever counting as a spike.
  const sigma = n > 2 ? Math.max(noiseSigma(Y), 1e-4 * (hi - lo), 1e-300) : 1;
  info.sigma = sigma;
  const nm = noiseModel(Y, sigma);
  info.shotNoise = nm.alpha;
  const ctx = { n, sigma, threshold, minBandPts, pad: Math.max(5, Math.ceil(2 * minBandPts) + 2), nm, mw };

  const accepted = [];                       // removed spans { a, b, misfit, height }
  const work = Float64Array.from(Y);
  let last = [];                             // the final pass's candidates, judged on the cleaned data
  if (scales.length) {
    for (let pass = 0; pass < 4; pass++) {
      // Later passes skip candidates touching a removal: what they see there is
      // the join of the interpolation, not data (a spike's own shoulders were
      // already kept by trim()).
      const gap = pass ? 1 : 0;
      const cands = candidates(work, nm, threshold, scales)
        .filter(([a, b]) => !accepted.some(s => a <= s.b + gap && b >= s.a - gap))
        .map(([a, b]) => ({ a, b, ...classify(work, a, b, ctx) }));
      // A spike on a band top often only shows up inside a wider candidate that
      // takes in the band: the runs standing clear above that candidate's best
      // band model are judged as candidates of their own.
      for (const c of cands.slice()) {
        for (const [p, q] of c.outliers || []) {
          if (q - p >= c.b - c.a || cands.some(d => d.a === p && d.b === q)) continue;
          cands.push({ a: p, b: q, ...classify(work, p, q, ctx) });
        }
      }
      last = cands;
      const before = accepted.length;
      greedy(work, cands, accepted, ctx);
      if (accepted.length === before) break;
    }
  }

  // spans found in different passes may touch (a spike's edge found once its top was gone)
  accepted.sort((p, q) => p.a - q.a);
  for (let i = accepted.length - 1; i > 0; i--) {
    const p = accepted[i - 1], q = accepted[i];
    if (q.a <= p.b + 1) {
      p.b = Math.max(p.b, q.b); p.misfit = Math.max(p.misfit, q.misfit); p.height = Math.max(p.height, q.height);
      accepted.splice(i, 1);
    }
  }

  // second opinion from companion spectra
  for (const s of accepted) s.kind = 'cosmic';
  if (info.companions) {
    for (let i = accepted.length - 1; i >= 0; i--) {
      const s = accepted[i];
      s.share = presence(Y, comps, s.a, s.b, ctx.pad);
      if (s.share < RECUR) continue;
      if (s.b === s.a) s.kind = 'artifact';
      else {
        result.restored.push(event(X, s.a, s.b, s.height, { kind: 'recurring', share: s.share }));
        accepted.splice(i, 1);
      }
    }
  }

  // user keeps
  const keep = (edits && edits.keep || []).filter(Number.isFinite);
  for (let i = accepted.length - 1; i >= 0; i--) {
    const s = accepted[i];
    if (keep.some(k => k >= X[s.a] - spacing && k <= X[s.b] + spacing)) {
      result.restored.push(event(X, s.a, s.b, s.height, { kind: 'kept', share: s.share ?? null }));
      accepted.splice(i, 1);
    }
  }

  accepted.sort((p, q) => p.a - q.a);
  for (const s of accepted) fillSmooth(out, s.a, s.b);
  for (const s of accepted) result.spikes.push(event(X, s.a, s.b, s.height, { kind: s.kind, misfit: s.misfit, share: s.share ?? null }));

  // user zaps, on top of the automatic result
  for (const z of (edits && edits.zaps) || []) {
    if (!Array.isArray(z) || !Number.isFinite(z[0]) || !Number.isFinite(z[1])) continue;
    const zl = Math.min(z[0], z[1]), zh = Math.max(z[0], z[1]);
    let a = -1, b = -1;
    for (let i = 0; i < n; i++) if (X[i] >= zl && X[i] <= zh) { if (a < 0) a = i; b = i; }
    if (a < 0) continue;
    const sp = result.spikes;
    for (let i = sp.length - 1; i >= 0; i--) if (sp[i].start >= a && sp[i].end <= b) sp.splice(i, 1);
    const h = height(Y, a, b, ctx);
    fill(out, a, b);
    sp.push(event(X, a, b, h, { kind: 'manual' }));
  }
  result.spikes.sort((p, q) => p.start - q.start);
  const seen = new Set();
  for (const s of result.spikes) for (let k = s.start; k <= s.end; k++) {
    if (seen.has(k) || out[k] === Y[k]) continue;
    seen.add(k);
    result.removed.push({ index: k, x: X[k], y: Y[k], replacedY: out[k] });
  }
  result.removed.sort((p, q) => p.index - q.index);

  // candidates left in place that a person should look at
  const sus = [];
  for (const c of last) {
    const { a, b } = c;
    if (!c.event || result.spikes.some(s => a <= s.end && b >= s.start) || result.restored.some(s => a <= s.end && b >= s.start)) continue;
    const share = info.companions ? presence(Y, comps, a, b, ctx.pad) : null;
    const recurring = share != null && share >= RECUR;
    if (recurring && a !== b) continue;                     // the same feature in many spectra: a real band
    const unique = share === 0 && c.height > 10 * localSigma(Y, a, b, ctx);
    const fixed = recurring && a === b;
    if ((c.misfit > Z_SUSPECT && c.rel > REL_MIN) || unique || fixed) {
      sus.push(event(X, a, b, c.height, { kind: fixed ? 'artifact' : 'suspect', misfit: c.misfit, share }));
    }
  }
  sus.sort((p, q) => (q.end - q.start) - (p.end - p.start));
  for (const s of sus) if (!result.suspects.some(t => s.start <= t.end && s.end >= t.start)) result.suspects.push(s);
  result.suspects.sort((p, q) => p.start - q.start);
  result.restored.sort((p, q) => p.start - q.start);
  return result;
}

function event(X, a, b, h, extra) {
  return { start: a, end: b, xStart: X[a], xEnd: X[b], height: h, kind: 'cosmic', misfit: null, share: null, ...extra };
}

/** Remove spikes, tallest first; re-judge the candidates a removal touched. */
function greedy(work, cands, accepted, ctx) {
  let pool = cands.filter(c => c.event);
  while (pool.length) {
    // Tallest first: a big spike distorts the predictions and windows of
    // everything within a few points, so those are judged again without it.
    let best = null;
    for (const c of pool) if (c.spike && (!best || c.height > best.height)) best = c;
    if (!best) break;
    let take = [best];
    // A wide candidate with smaller spikes inside: is it still not a band without them?
    const inner = pool.filter(c => c !== best && c.spike && c.a >= best.a && c.b <= best.b && (c.b - c.a) < (best.b - best.a));
    if (inner.length && keepsRest(work, best, inner, ctx)) take = inner;
    // Then each span is cut down to its spike core where it can be: the runs
    // standing clear above its best band model, if what is left is a band
    // carrying them. On a strong narrow band no smaller candidate may exist at
    // all (the band top beats the small-scale predictors too), so this is the
    // only way a spike on its apex comes off without the band.
    take = take.flatMap(c => {
      const core = (c.outliers || []).filter(([p, q]) => q - p < c.b - c.a && prominent(work, p, q, ctx))
        .map(([p, q]) => ({ a: p, b: q, misfit: c.misfit, height: c.height }));
      return core.length && keepsRest(work, c, core, ctx) ? core : [c];
    });
    // trim to the raised points, then merge overlaps (inner candidates may nest)
    const spans = take.map(c => { const t = trim(work, c.a, c.b, ctx); return t && { a: t[0], b: t[1], misfit: c.misfit, height: c.height }; })
      .filter(Boolean).sort((p, q) => p.a - q.a);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s.a <= last.b + 1) { last.b = Math.max(last.b, s.b); last.misfit = Math.max(last.misfit, s.misfit); last.height = Math.max(last.height, s.height); }
      else merged.push({ ...s });
    }
    for (const s of merged) fillSmooth(work, s.a, s.b);
    accepted.push(...merged);
    if (!merged.length) { pool = pool.filter(c => c !== best && !take.includes(c)); continue; }
    const lo = Math.min(...merged.map(t => t.a)) - ctx.pad, hi = Math.max(...merged.map(t => t.b)) + ctx.pad;
    pool = pool.filter(c => c !== best && !take.includes(c) && !merged.some(s => c.a <= s.b && c.b >= s.a));
    pool = pool.map(c => (c.b >= lo && c.a <= hi ? { a: c.a, b: c.b, ...classify(work, c.a, c.b, ctx) } : c)).filter(c => c.event);
  }
}

/** Once the inner spans are filled, is what is left of `outer` either nothing at
 *  all or a band carrying them (band-like, raised on both sides)? Then only the
 *  inner spans are spikes. */
function keepsRest(work, outer, inner, ctx) {
  const tmp = Float64Array.from(work);
  for (const c of inner) fillSmooth(tmp, c.a, c.b);
  const rest = classify(tmp, outer.a, outer.b, ctx);
  return !rest.event || (!rest.spike && carries(tmp, outer, inner, rest, ctx));
}

/** Does what is left of `outer` once `inner` is filled rise above the background on both sides of it? */
function carries(tmp, outer, inner, rest, ctx) {
  const { n, pad, minBandPts } = ctx;
  const lo = Math.max(0, outer.a - pad), hi = Math.min(n - 1, outer.b + pad);
  const base = baseLine(tmp, outer.a, outer.b, lo, hi);
  const floor = Math.max(3 * localSigma(tmp, outer.a, outer.b, ctx), 0.1 * rest.height);
  const iLo = Math.min(...inner.map(c => c.a)), iHi = Math.max(...inner.map(c => c.b));
  let L = 0, R = 0;
  for (let i = iLo - 1; i >= lo && tmp[i] - base(i) > floor; i--) L++;
  for (let i = iHi + 1; i <= hi && tmp[i] - base(i) > floor; i++) R++;
  const need = Math.max(1, Math.ceil(minBandPts / 2));
  return L >= need && R >= need;
}

/** Hole-predictor candidates at every scale: [start, end] runs. */
function candidates(W, nm, threshold, scales) {
  const n = W.length, found = new Map();
  for (const hw of scales) {
    const P = predictorWeights(hw);
    const r = new Float64Array(n), z = new Float64Array(n);
    // z = excess / (σ · gain): the prediction carries noise of its own, so the
    // residual's spread is σ·gain, not σ. σ is taken at the predicted level
    // (shot noise): on a strong band top the noise is larger than on the floor,
    // and against the floor's σ the whole top would stand out, hiding a spike on it.
    for (let k = 0; k < n; k++) {
      const [pred, gain] = predict(W, k, hw, P);
      r[k] = W[k] - pred;
      z[k] = r[k] / (Math.sqrt(nm.s2 + nm.alpha * Math.max(0, pred - nm.L0)) * gain);
    }
    for (let k = 0; k < n; k++) {
      if (!(z[k] > threshold)) continue;
      let j = k;
      while (j + 1 < n && z[j + 1] > threshold) j++;
      if (j - k + 1 <= hw) {
        let e = -Infinity;
        for (let q = k; q <= j; q++) if (r[q] > e) e = r[q];
        const left = k > 0 ? r[k - 1] : -Infinity, right = j < n - 1 ? r[j + 1] : -Infinity;
        if (left < NEIGHBOUR_FRACTION * e && right < NEIGHBOUR_FRACTION * e) found.set(k + ':' + j, [k, j]);
      }
      k = j;
    }
  }
  return [...found.values()];
}

/**
 * Can a smooth background plus one or two real bands explain y[a..b]?
 * @returns {{event:boolean, height:number, misfit:number}} event: the feature stands above its
 *   background by threshold σ; misfit: Wilson–Hilferty deviate of the best model's χ²
 */
function classify(Y, a, b, ctx) {
  const { n, threshold, minBandPts, pad } = ctx;
  const lo = Math.max(0, a - pad), hi = Math.min(n - 1, b + pad);
  const m = hi - lo + 1;
  const h = height(Y, a, b, ctx);
  const sigma = localSigma(Y, a, b, ctx);
  const none = { event: false, spike: false, height: h, misfit: 0, rel: 0 };
  if (!(h > threshold * sigma) || m - (b - a + 1) < 3) return none;
  const t = new Float64Array(m), yy = new Float64Array(m);
  const mid = (lo + hi) / 2, half = Math.max(1, (hi - lo) / 2);
  for (let i = 0; i < m; i++) { t[i] = (lo + i - mid) / half; yy[i] = Y[lo + i]; }
  // Background: a quadratic (the flank or top of a broad band, a fluorescence
  // slope), plus a step where the window holds a real jump outside the
  // candidate (the join of an extended scan, a filter edge). A step cannot
  // make both edges of a spike, only explain the data beside it.
  const bg = [Float64Array.from(t, () => 1), t, Float64Array.from(t, v => v * v)];
  let jStep = -1, dMax = 0;
  for (let i = lo + 1; i <= hi; i++) {
    if (i >= a && i <= b + 1) continue;                     // the candidate's own edges
    const d = Math.abs(Y[i] - Y[i - 1]);
    if (d > dMax) { dMax = d; jStep = i; }
  }
  if (jStep > lo && dMax > STEP_SIGMA * Math.SQRT2 * sigma) bg.push(Float64Array.from({ length: m }, (_, i) => (lo + i >= jStep ? 1 : 0)));
  const nb = bg.length, s2 = sigma * sigma;
  // Bands are non-negative pseudo-Voigts no wider than half the window: a
  // broader band is the background's job, and a broad band with curvature
  // subtracted could otherwise fake a peak narrower than minBand. The band
  // explaining a candidate may be a neighbour whose flank it sits on, even one
  // centred beyond the window (but inside the data: at an array end a band just
  // outside the range could mimic a spike on the first point), so centres range
  // that far; the second band of a pair is the local one, near the candidate.
  const ext = Math.ceil(m / 2);
  const cLo = Math.max(0, lo - ext), cHi = Math.min(n - 1, hi + ext), nLo = Math.max(0, a - 1), nHi = Math.min(n - 1, b + 1);
  const wMax = Math.max(minBandPts, m / 2);
  const widths = [];
  for (let w = minBandPts; w <= wMax * 1.0001; w *= 1.5) widths.push(w);
  if (widths[widths.length - 1] < wMax * 0.95) widths.push(wMax);
  // The search ranks models by their unweighted residual (cheap: see fastSSR);
  // only the winner is refitted with the shape-tolerance weights.
  const ssr = fastSSR(bg, yy);
  const cache = new Map();
  const prof = (c, w, eta) => {
    const key = c + '|' + w + '|' + eta;
    let p = cache.get(key);
    if (!p) { p = ssr.column(Float64Array.from({ length: m }, (_, i) => pv(lo + i - c, w, eta))); cache.set(key, p); }
    return p;
  };
  const cost = spec => ssr(spec.map(q => prof(q[0], q[1], q[2])));
  const valid = spec => spec.every(([c, w, e], k) => w >= minBandPts * 0.9999 && w <= wMax * 1.0001 && e >= 0 && e <= 1
    && (spec.length === 2 && k === 0 ? c >= nLo - 0.5 && c <= nHi + 0.5 : c >= cLo && c <= cHi));
  // Coordinate search with shrinking steps on every centre, width and shape:
  // the grid alone leaves a few per cent of misfit on a strong narrow band.
  const refine = spec => {
    let cur = spec.map(q => q.slice()), curS = cost(cur);
    for (let r = 0; r < 4; r++) {
      const dc = 0.25 / 2 ** r, fw = 1.1 ** (1 / 2 ** r), de = 0.25 / 2 ** r;
      for (let it = 0; it < 8; it++) {
        let moved = false;
        for (let k = 0; k < cur.length; k++) {
          const q = cur[k];
          for (const [i, v] of [[0, q[0] - dc], [0, q[0] + dc], [1, q[1] / fw], [1, q[1] * fw], [2, q[2] - de], [2, q[2] + de]]) {
            const trial = cur.map(z => z.slice());
            trial[k][i] = v;
            if (!valid(trial)) continue;
            const s = cost(trial);
            if (s < curS * (1 - 1e-12)) { cur = trial; curS = s; moved = true; }
          }
        }
        if (!moved) break;
      }
    }
    return cur;
  };
  const judge = spec => {
    const r = fitChi(bg, yy, s2, spec.map(q => prof(q[0], q[1], q[2]).p), true);
    let rel = 0;
    for (let i = Math.max(lo, a - 1); i <= Math.min(hi, b + 1); i++) rel = Math.max(rel, Math.abs(r.resid[i - lo]) / h);
    // A spike's misfit sits on the candidate; over the whole window it is
    // diluted by the background points, so the candidate and its neighbours are
    // tested on their own too and the stronger verdict counts.
    let cl = 0, k = 0;
    for (let i = Math.max(lo, a - 2); i <= Math.min(hi, b + 2); i++) { cl += r.resid[i - lo] ** 2 * r.w[i - lo]; k++; }
    // Where the data stand clear above the best real-band model is where a spike
    // would be: those runs are offered to greedy() as the spike inside this candidate.
    const out = [];
    for (let i = a; i <= b; i++) {
      if (!(r.resid[i - lo] * Math.sqrt(r.w[i - lo]) > INNER_SIGMA)) continue;
      const last = out[out.length - 1];
      if (last && last[1] === i - 1) last[1] = i; else out.push([i, i]);
    }
    return { misfit: Math.max(wilsonHilferty(r.chi, m - nb - 3 * spec.length), wilsonHilferty(cl, k - 1)), rel, out };
  };

  // one band: a coarse grid (whole points, Gaussian or Lorentzian), then the
  // two best starting points refined; the refinement does the fine work
  const seeds = [];
  for (const eta of [0, 1]) for (const w of widths) for (let c = Math.ceil(cLo); c <= cHi; c += 1) {
    const s = cost([[c, w, eta]]);
    if (seeds.length < 2 || s < seeds[1].s) { seeds.push({ s, spec: [[c, w, eta]] }); seeds.sort((p, q) => p.s - q.s); seeds.length = Math.min(2, seeds.length); }
  }
  if (!seeds.length || !isFinite(seeds[0].s)) return none;
  const fits = seeds.map(sd => refine(sd.spec)).map(sp => ({ sp, s: cost(sp) })).sort((p, q) => p.s - q.s);
  let { misfit, rel, out } = judge(fits[0].sp);

  // Two bands (doublets, a narrow band on the flank of another) can only rescue
  // a feature the single band failed on, so they are tried only then.
  if (!isBand(misfit, rel)) {
    const w2 = [...new Set([minBandPts, Math.min(wMax, 2 * minBandPts), wMax])];
    let best2 = null, sb = Infinity;
    for (let c1 = nLo; c1 <= nHi + 1e-9; c1 += 0.5) {
      for (let c2 = cLo; c2 <= cHi + 1e-9; c2 += 0.5) {
        if (Math.abs(c2 - c1) < 0.5) continue;
        for (const wa of w2) for (const wb of w2) {
          const s = cost([[c1, wa, 0.5], [c2, wb, 0.5]]);
          if (s < sb) { sb = s; best2 = [[c1, wa, 0.5], [c2, wb, 0.5]]; }
        }
      }
    }
    if (best2) {
      const j2 = judge(refine(best2));
      if (j2.misfit < misfit) ({ misfit, rel, out } = j2);
    }
  }
  // Whatever the model says, a spike stands above its own neighbours.
  return { event: true, spike: prominent(Y, a, b, ctx, sigma) && !isBand(misfit, rel), height: h, misfit, rel, outliers: out };
}

/** Does y[a..b] rise more than PROM_SIGMA σ above the higher of its two neighbours? */
function prominent(Y, a, b, ctx, sigma = localSigma(Y, a, b, ctx)) {
  const n = Y.length;
  let top = -Infinity;
  for (let i = a; i <= b; i++) top = Math.max(top, Y[i]);
  return top - Math.max(a > 0 ? Y[a - 1] : -Infinity, b < n - 1 ? Y[b + 1] : -Infinity) > PROM_SIGMA * sigma;
}

/** Can the best real-band model stand? It cannot if it misses the feature both
 *  significantly and materially: z > Z_CRIT with REL_MIN of the height, or a
 *  gross miss (REL_GROSS) at z > Z_GROSS. No band at least minBand wide misses
 *  by that much: even with noise it fits within a few per cent. */
function isBand(misfit, rel) {
  return !((misfit > Z_CRIT && rel > REL_MIN) || (misfit > Z_GROSS && rel > REL_GROSS));
}

/**
 * Residual sum of squares of y on [background | bands], band coefficients ≥ 0,
 * for a fixed background. The background block of the normal equations is
 * computed once per window and each band's products once per band, so a trial
 * fit costs a 4×4 or 5×5 solve. `column(p)` wraps a band profile with its products.
 */
function fastSSR(bg, yy) {
  const m = yy.length, nb = bg.length;
  let ym = 0;
  for (let i = 0; i < m; i++) ym += yy[i];
  ym /= m;
  const y = Float64Array.from(yy, v => v - ym);          // the constant column absorbs the mean
  const dot = (u, v) => { let s = 0; for (let i = 0; i < m; i++) s += u[i] * v[i]; return s; };
  const G = bg.map(p => bg.map(q => dot(p, q))), gy = bg.map(p => dot(p, y));
  const yty = dot(y, y);
  const K = nb + 2, A = new Float64Array(K * (K + 1)), sol = new Float64Array(K), rhs = new Float64Array(K);
  const f = bands => {
    let use = bands;
    for (let tries = 0; tries <= bands.length; tries++) {
      const k = nb + use.length;
      for (let p = 0; p < nb; p++) { for (let q = 0; q < nb; q++) A[p * (k + 1) + q] = G[p][q]; rhs[p] = gy[p]; }
      for (let j = 0; j < use.length; j++) {
        const col = nb + j, u = use[j];
        for (let p = 0; p < nb; p++) A[p * (k + 1) + col] = A[col * (k + 1) + p] = u.pb[p];
        for (let jj = 0; jj <= j; jj++) A[col * (k + 1) + nb + jj] = A[(nb + jj) * (k + 1) + col] = jj === j ? u.pp : dot(u.p, use[jj].p);
        rhs[col] = u.py;
      }
      for (let p = 0; p < k; p++) A[p * (k + 1) + k] = rhs[p];
      if (!gaussJordan(A, k, sol)) return Infinity;
      let neg = -1;
      for (let j = 0; j < use.length; j++) if (sol[nb + j] < 0) { neg = j; break; }
      if (neg < 0) {
        let s = yty;                                       // at the least-squares solution SSR = yᵀy − cᵀBᵀy
        for (let p = 0; p < k; p++) s -= sol[p] * rhs[p];
        return Math.max(0, s);
      }
      use = use.filter((_, j) => j !== neg);
    }
    return Infinity;
  };
  f.column = p => ({ p, pb: bg.map(q => dot(p, q)), pp: dot(p, p), py: dot(p, y) });
  return f;
}

/** Solve the k×k system stored row-major with its right-hand side in column k (k+1 wide), scaled to unit diagonal. */
function gaussJordan(A, k, out) {
  const W = k + 1;
  const sc = new Float64Array(k);
  for (let p = 0; p < k; p++) { const d = A[p * W + p]; if (!(d > 0)) return false; sc[p] = 1 / Math.sqrt(d); }
  for (let p = 0; p < k; p++) { for (let q = 0; q < k; q++) A[p * W + q] *= sc[p] * sc[q]; A[p * W + k] *= sc[p]; }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r * W + c]) > Math.abs(A[piv * W + c])) piv = r;
    if (!(Math.abs(A[piv * W + c]) > 1e-10)) return false;
    if (piv !== c) for (let q = 0; q < W; q++) { const t = A[c * W + q]; A[c * W + q] = A[piv * W + q]; A[piv * W + q] = t; }
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const fct = A[r * W + c] / A[c * W + c];
      if (fct) for (let q = c; q < W; q++) A[r * W + q] -= fct * A[c * W + q];
    }
  }
  for (let i = 0; i < k; i++) out[i] = A[i * W + k] / A[i * W + i] * sc[i];
  return true;
}

/** Shrink a spike run to where it breaks away from the data around it (null if
 *  its top does not break away on either side: a smooth bump, not a spike). An end
 *  point that continues the trend of the CONT points beyond it (a straight-line
 *  extrapolation, within CONT_SIGMA of its noise) belongs to the signal, e.g. the
 *  flank of a band the spike sits on; the spike starts at the first jump. So a
 *  tall spike keeps its shoulders and a band under it is not taken along. */
const CONT = 4, CONT_SIGMA = 4, GROW = 2;
const CONT_W = (() => {
  // least-squares line through offsets 1…CONT, extrapolated to offset 0
  const ts = Array.from({ length: CONT }, (_, i) => i + 1);
  const S = ts.reduce((p, q) => p + q, 0), SS = ts.reduce((p, q) => p + q * q, 0);
  const w = ts.map(t => (SS - S * t) / (CONT * SS - S * S));
  return { w, gain: Math.sqrt(1 + w.reduce((p, q) => p + q * q, 0)) };
})();
const CONT_Q = (() => {
  // least-squares parabola through offsets 1…CONT, extrapolated to offset 0:
  // follows a band's accelerating rise, which the straight line undershoots
  const ts = Array.from({ length: CONT }, (_, i) => i + 1);
  const w = ts.map((_, j) => solve([ts.map(() => 1), ts, ts.map(t => t * t)], ts.map((__, k) => (k === j ? 1 : 0)), null)[0]);
  return { w, gain: Math.sqrt(1 + w.reduce((p, q) => p + q * q, 0)) };
})();
function trim(Y, a, b, ctx) {
  const { n } = ctx;
  const sig = localSigma(Y, a, b, ctx), tol = CONT_SIGMA * CONT_W.gain * sig;
  const ext = (W, i, dir) => {
    let v = 0;
    for (let k = 0; k < CONT; k++) { const j = i - dir * (k + 1); if (j < 0 || j >= n) return Infinity; v += W.w[k] * Y[j]; }
    return v;
  };
  const pred = (i, dir) => ext(CONT_W, i, dir);
  // Growing needs the point to clear the curved trend too (on a band's
  // accelerating flank it does not). The parabola's extrapolation is noisier,
  // and it only has to rule out that flank, so half the margin is enough.
  const breaks = (i, dir) => Y[i] - pred(i, dir) >= tol && Y[i] - ext(CONT_Q, i, dir) >= 0.5 * CONT_SIGMA * CONT_Q.gain * sig;
  // never past the top: the highest point is the spike if anything is, and if
  // it continues the trend on both sides there is no spike here at all
  let top = a;
  for (let i = a + 1; i <= b; i++) if (Y[i] > Y[top]) top = i;
  if (Y[top] - pred(top, 1) < tol && Y[top] - pred(top, -1) < tol) return null;
  while (a < top && Y[a] - pred(a, 1) < tol) a++;
  while (b > top && Y[b] - pred(b, -1) < tol) b--;
  // The same test outward: a neighbour that breaks away from the data beyond it
  // is the spike's own shoulder, missed by the candidate run (at most GROW points
  // a side, so a removal never creeps up the flank of a band).
  for (let k = 0; k < GROW && a > 0 && breaks(a - 1, 1); k++) a--;
  for (let k = 0; k < GROW && b < n - 1 && breaks(b + 1, -1); k++) b++;
  return [a, b];
}

/** Straight line through the window points outside a..b (robust enough for trimming). */
function baseLine(Y, a, b, lo, hi) {
  let sw = 0, st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = lo; i <= hi; i++) if (i < a || i > b) { sw++; st += i; sy += Y[i]; stt += i * i; sty += i * Y[i]; }
  const den = sw * stt - st * st;
  if (!sw) return () => 0;
  if (Math.abs(den) < 1e-12) return () => sy / sw;
  const s = (sw * sty - st * sy) / den, c = (sy - s * st) / sw;
  return i => c + s * i;
}

/** Largest excess of y[a..b] over a quadratic through the window points outside the run. */
function height(Y, a, b, { n, pad }) {
  const e = excess(Y, a, b, n, pad);
  return e.length ? Math.max(...e) : 0;
}

/** Excess of each point of y[a..b] over a quadratic through the window points outside the run. */
function excess(Y, a, b, n, pad) {
  const lo = Math.max(0, a - pad), hi = Math.min(n - 1, b + pad);
  const tt = [], vv = [];
  for (let i = lo; i <= hi; i++) if (i < a || i > b) { tt.push(i); vv.push(Y[i]); }
  const out = new Float64Array(b - a + 1);
  if (!tt.length) return out;
  const deg = Math.min(2, tt.length - 1);
  const mid = (lo + hi) / 2, half = Math.max(1, (hi - lo) / 2);
  const cols = [];
  for (let d = 0; d <= deg; d++) cols.push(tt.map(i => ((i - mid) / half) ** d));
  const coef = solve(cols, vv, null) || [vv.reduce((p, q) => p + q, 0) / vv.length];
  for (let i = a; i <= b; i++) {
    let base = 0;
    for (let d = 0; d < coef.length; d++) base += coef[d] * ((i - mid) / half) ** d;
    out[i - a] = Y[i] - base;
  }
  return out;
}

/**
 * χ² of a quadratic background plus non-negative bands, weights 1/(σ² + (SHAPE_TOL·band)²).
 * Two passes: the band-dependent weights need a first estimate of the bands.
 */
function fitChi(bg, yy, s2, bands, wantResid = false) {
  const m = yy.length;
  let w = new Float64Array(m).fill(1 / s2);
  // The tolerance scales with the band signal, but never beyond the data's own
  // range: a runaway coefficient must not buy itself zero weight.
  let ylo = Infinity, yhi = -Infinity;
  for (const v of yy) { if (v < ylo) ylo = v; if (v > yhi) yhi = v; }
  const cap = yhi - ylo;
  let chi = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    const use = bands.slice();
    let coef = null;
    const nb = bg.length;
    for (let tries = 0; tries <= bands.length; tries++) {
      coef = solve([...bg, ...use], yy, w);
      if (!coef) return wantResid ? { chi: Infinity, resid: new Float64Array(m) } : Infinity;
      const neg = coef.slice(nb).findIndex(c => c < 0);
      if (neg < 0) break;
      use.splice(neg, 1);
    }
    const bandSig = new Float64Array(m), resid = new Float64Array(m);
    chi = 0;
    for (let i = 0; i < m; i++) {
      let mdl = 0, bs = 0;
      for (let k = 0; k < nb; k++) mdl += coef[k] * bg[k][i];
      for (let k = 0; k < use.length; k++) bs += coef[nb + k] * use[k][i];
      mdl += bs; bandSig[i] = bs;
      const r = yy[i] - mdl;
      resid[i] = r;
      chi += r * r * w[i];
    }
    if (pass === 0) w = Float64Array.from(bandSig, v => 1 / (s2 + (SHAPE_TOL * Math.min(Math.max(v, 0), cap)) ** 2));
    else if (wantResid) return { chi, resid, w };
  }
  return chi;
}

/** Weighted least squares by the normal equations; null if singular. */
function solve(cols, yy, w) {
  const k = cols.length, m = yy.length;
  const A = Array.from({ length: k }, () => new Float64Array(k + 1));
  for (let i = 0; i < m; i++) {
    const wi = w ? w[i] : 1;
    for (let p = 0; p < k; p++) {
      const cp = cols[p][i] * wi;
      for (let q = p; q < k; q++) A[p][q] += cp * cols[q][i];
      A[p][k] += cp * yy[i];
    }
  }
  for (let p = 0; p < k; p++) for (let q = 0; q < p; q++) A[p][q] = A[q][p];
  // Scale to unit diagonal so the singularity test is relative: a column almost
  // collinear with the others makes the fit meaningless, not perfect.
  const sc = Array.from({ length: k }, (_, p) => (A[p][p] > 0 ? 1 / Math.sqrt(A[p][p]) : 0));
  if (sc.some(v => !v)) return null;
  for (let p = 0; p < k; p++) { for (let q = 0; q < k; q++) A[p][q] *= sc[p] * sc[q]; A[p][k] *= sc[p]; }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (!(Math.abs(A[piv][c]) > 1e-10)) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f) for (let q = c; q <= k; q++) A[r][q] -= f * A[c][q];
    }
  }
  return Array.from({ length: k }, (_, i) => A[i][k] / A[i][i] * sc[i]);
}

/** Pseudo-Voigt (unit height) at distance d points from the centre, FWHM w points. */
function pv(d, w, eta) {
  const u2 = (2 * d / w) ** 2;
  return eta / (1 + u2) + (1 - eta) * Math.exp(-LN2 * u2);
}

/** χ² with k degrees of freedom as a standard-normal deviate (Wilson–Hilferty). */
function wilsonHilferty(chi, k) {
  k = Math.max(1, k);
  if (!Number.isFinite(chi)) return Infinity;
  const v = 2 / (9 * k);
  return (Math.cbrt(chi / k) - (1 - v)) / Math.sqrt(v);
}

/** Share of companion spectra that show the SAME feature: standing out above
 *  their own background at the feature's peak point and, for features wider than
 *  one point, with a similar profile (a band elsewhere in the span does not count). */
const sigmaCache = new WeakMap();
function presence(Y, comps, a, b, pad) {
  const e = excess(Y, a, b, Y.length, pad);
  let p = 0;
  for (let i = 1; i < e.length; i++) if (e[i] > e[p]) p = i;
  let hits = 0;
  for (const c of comps) {
    let s = sigmaCache.get(c);
    if (s === undefined) { s = noiseSigma(Float64Array.from(c)); sigmaCache.set(c, s); }
    const ec = excess(c, a, b, c.length, pad);
    if (!(ec[p] > PRESENT_SIGMA * Math.max(s, 1e-300))) continue;
    if (b === a || corr(e, ec) > 0.7) hits++;
  }
  return comps.length ? hits / comps.length : 0;
}

function corr(u, v) {
  const n = u.length;
  let mu = 0, mv = 0;
  for (let i = 0; i < n; i++) { mu += u[i]; mv += v[i]; }
  mu /= n; mv /= n;
  let suv = 0, suu = 0, svv = 0;
  for (let i = 0; i < n; i++) { const du = u[i] - mu, dv = v[i] - mv; suv += du * dv; suu += du * du; svv += dv * dv; }
  return suu > 0 && svv > 0 ? suv / Math.sqrt(suu * svv) : 0;
}

/**
 * Signal-dependent noise: photon shot noise grows with the count level, so a
 * point on a strong band is noisier than one on the floor. From blocks of 16
 * points: variance of the second differences against the block level, fitted as
 * σ² + α·(level − floor level). Band curvature inflates the variance of band
 * blocks, which errs toward a larger α: fewer false spikes on strong bands.
 */
function noiseModel(Y, sigma) {
  const n = Y.length, B = 16, blocks = [];
  for (let s = 1; s + B < n; s += B) {
    const d = new Float64Array(B), lv = new Float64Array(B);
    for (let i = 0; i < B; i++) { const k = s + i; d[i] = Y[k] - 0.5 * (Y[k - 1] + Y[k + 1]); lv[i] = Y[k]; }
    const md = median(d);
    const mad = median(d.map(v => Math.abs(v - md)));
    blocks.push({ v: (1.4826 * mad) ** 2 / 1.5, L: median(lv) });
  }
  if (blocks.length < 8) return { alpha: 0, L0: 0, s2: sigma * sigma };
  blocks.sort((p, q) => p.L - q.L);
  const low = blocks.slice(0, Math.max(3, blocks.length >> 2));
  const L0 = median(low.map(b => b.L));
  const s2 = sigma * sigma;
  const r = blocks.filter(b => b.L - L0 > 10 * sigma).map(b => (b.v - s2) / (b.L - L0));
  const alpha = r.length >= 3 ? Math.max(0, median(r)) : 0;
  return { alpha, L0, s2 };
}

/** Noise σ for the window around a..b: the larger of the model's value at the
 *  window's signal level and the spread actually seen there (robust σ of the
 *  second differences outside the candidate), so a noisy band top is never
 *  judged against the quieter floor. */
function localSigma(Y, a, b, { n, pad, nm }) {
  const lo = Math.max(0, a - pad), hi = Math.min(n - 1, b + pad), v = [], d = [];
  for (let i = lo; i <= hi; i++) if (i < a || i > b) v.push(Y[i]);
  // Third differences (−1 3 −3 1) over a wider stretch: blind to a band's local
  // curvature, which second differences would count as noise on a flank or a
  // top (variance 20 σ²), and enough of them (~40) that taking the larger of
  // this and the model does not bias the noise upward.
  const lo3 = Math.max(1, a - 3 * pad), hi3 = Math.min(n - 3, b + 3 * pad);
  for (let i = lo3; i <= hi3; i++) if (i + 2 < a - 1 || i - 1 > b + 1) d.push(Y[i + 2] - 3 * Y[i + 1] + 3 * Y[i] - Y[i - 1]);
  const level = v.length ? median(v) : Y[a];
  const model = Math.sqrt(nm.s2 + nm.alpha * Math.max(0, level - nm.L0));
  if (d.length < 12) return model;
  // 30th percentile of the absolute deviations (0.3853 σ for Gaussian noise):
  // a nearby spike or shoulder, which only adds large values, cannot inflate it
  // until it covers most of the window.
  const md = median(d);
  const dev = Float64Array.from(d, x => Math.abs(x - md)).sort();
  const seen = dev[Math.floor(0.3 * (dev.length - 1))] / 0.3853 / Math.sqrt(20);
  return Math.max(model, seen);
}

function medianSpacing(X) {
  if (X.length < 2) return 1;
  const d = new Float64Array(X.length - 1);
  for (let i = 1; i < X.length; i++) d[i - 1] = Math.abs(X[i] - X[i - 1]);
  return median(d) || 1;
}

/** Whitaker–Hayes noise level: MAD of first differences, as a Gaussian σ of y. */
function noiseSigma(Y) {
  const n = Y.length;
  const d = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) d[i - 1] = Y[i] - Y[i - 1];
  const med = median(d);
  for (let i = 0; i < d.length; i++) d[i] = Math.abs(d[i] - med);
  return median(d) / 0.6745 / Math.SQRT2;
}

function median(a) {
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SYM = 5;   // points per side in the symmetric predictor
const ONE = 6;   // points in the one-sided (array edge) predictor

/** Least-squares weights for the hole predictor (fixed index offsets) and their noise gains. */
function predictorWeights(hw) {
  // symmetric quadratic through offsets ±(hw+1 … hw+SYM), evaluated at 0
  const ts = Array.from({ length: SYM }, (_, i) => hw + 1 + i);
  let S2 = 0, S4 = 0;
  for (const t of ts) { S2 += 2 * t * t; S4 += 2 * t ** 4; }
  const den = 2 * SYM * S4 - S2 * S2;
  const sym = ts.map(t => (S4 - S2 * t * t) / den);
  // one-sided straight line through offsets hw+1 … hw+ONE, extrapolated to 0 (array edges)
  const us = Array.from({ length: ONE }, (_, i) => hw + 1 + i);
  const Su = us.reduce((a, u) => a + u, 0), Suu = us.reduce((a, u) => a + u * u, 0);
  const one = us.map(u => (Suu - Su * u) / (ONE * Suu - Su * Su));
  // σ of (point − prediction) in units of the point noise σ
  const symGain = Math.sqrt(1 + 2 * sym.reduce((a, w) => a + w * w, 0));
  const oneGain = Math.sqrt(1 + one.reduce((a, w) => a + w * w, 0));
  return { ts, sym, us, one, symGain, oneGain };
}

/** [prediction, noise gain] for point k from points outside the hole. */
function predict(Y, k, hw, W) {
  const n = Y.length, far = hw + SYM;
  if (k - far >= 0 && k + far < n) {
    let v = 0;
    for (let i = 0; i < SYM; i++) v += W.sym[i] * (Y[k - W.ts[i]] + Y[k + W.ts[i]]);
    return [v, W.symGain];
  }
  const dir = k - far < 0 ? 1 : -1;               // extrapolate from the side that exists
  let v = 0;
  for (let i = 0; i < ONE; i++) {
    const j = k + dir * W.us[i];
    if (j < 0 || j >= n) return [Y[k], 1];        // not enough points either way: never flag
    v += W.one[i] * Y[j];
  }
  return [v, W.oneGain];
}

/** Replace a short run (≤ 3 points) by a quadratic through the 2 clean points on
 *  each side, so a spike on a band top is replaced by the band's curvature, not
 *  a chord under it; longer runs (where a quadratic would amplify the noise) and
 *  runs near an array end fall back to linear interpolation. */
function fillSmooth(arr, a, b) {
  const n = arr.length, K = 2;
  if (b - a + 1 > 3 || a - K < 0 || b + K >= n) return fill(arr, a, b);
  const ts = [], vs = [];
  for (let i = a - K; i < a; i++) { ts.push(i - a); vs.push(arr[i]); }
  for (let i = b + 1; i <= b + K; i++) { ts.push(i - a); vs.push(arr[i]); }
  const c = solve([ts.map(() => 1), ts, ts.map(t => t * t)], vs, null);
  if (!c) return fill(arr, a, b);
  for (let i = a; i <= b; i++) { const t = i - a; arr[i] = c[0] + c[1] * t + c[2] * t * t; }
}

/** Replace a..b by linear interpolation between the clean neighbours. */
function fill(arr, a, b) {
  const n = arr.length;
  const L = a - 1, R = b + 1;
  if (L < 0 && R >= n) return;
  for (let k = a; k <= b; k++) {
    if (L < 0) arr[k] = arr[R];
    else if (R >= n) arr[k] = arr[L];
    else arr[k] = arr[L] + (arr[R] - arr[L]) * (k - L) / (R - L);
  }
}
