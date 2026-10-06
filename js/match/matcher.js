/* Peak → band assignment against a prepared library.

   Confidence is a Gaussian in the distance from the band centre, scaled so the
   window edge sits at exp(−2) ≈ 0.135 on either side. Windows are asymmetric
   (the atlas centre is not always mid-range, e.g. G: 1585 in 1580–1600), so the
   scale is taken on the side the peak is on — a peak at the far edge of a wide
   side is as plausible as one at the edge of a narrow side.

   Assignment is one-to-one and greedy by confidence: two peaks can't both be "D",
   because the labels feed ratios that assume one intensity per band. The losers
   keep the band in their `alternatives` so the UI can offer a manual swap. */

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/**
 * Confidence that a peak at x belongs to a prepared band.
 * @param {number} x peak position, cm⁻¹
 * @param {{ center: number, window: [number, number] }} preparedBand
 * @returns {number} exp(−2·(d/dmax)²) inside the window, 0 outside; d = |x − centre|,
 *   dmax = distance from the centre to the window edge on x's side
 */
export function bandConfidence(x, preparedBand) {
  if (!isNum(x) || !preparedBand || !Array.isArray(preparedBand.window)) return 0;
  const [lo, hi] = preparedBand.window;
  const c = preparedBand.center;
  if (!(x >= lo && x <= hi) || !isNum(c)) return 0;
  const d = Math.abs(x - c);
  const dmax = x >= c ? hi - c : c - lo;
  // A zero half-width only happens with zero tolerance on a single-valued range:
  // the peak is either exactly on the centre or not a candidate at all.
  if (!(dmax > 0)) return d === 0 ? 1 : 0;
  const r = d / dmax;
  return Math.exp(-2 * r * r);
}

function peakX(p) {
  if (!p) return NaN;
  if (isNum(p.x)) return p.x;
  if (isNum(p.x0)) return p.x0;
  return NaN;
}

/**
 * Assign detected peaks to library bands (one-to-one, greedy by confidence).
 * @param {Array<{ id?: string, x: number }>} peaks DetectedPeak-like objects (x0 is accepted for fit components)
 * @param {{ bands: object[], regions?: object[] }} prepared result of prepareLibrary
 * @returns {object[]} Assignment per peak, same order as `peaks`:
 *   { peakId, x, kind: 'band'|'region'|'unassigned', bandId, label, confidence, delta,
 *     alternatives: [{ bandId, label, confidence, delta }], regionId }
 *   `alternatives` lists every candidate band (confidence > 0) including the assigned one,
 *   best first. `regionId` (addition to the contract) names the library region for kind 'region'.
 */
export function matchPeaks(peaks, prepared) {
  const list = Array.isArray(peaks) ? peaks : [];
  const bands = Array.isArray(prepared) ? prepared : (prepared && Array.isArray(prepared.bands) ? prepared.bands : []);
  const regions = prepared && !Array.isArray(prepared) && Array.isArray(prepared.regions) ? prepared.regions : [];

  const candidates = [];
  const perPeak = list.map(() => []);
  list.forEach((p, i) => {
    const x = peakX(p);
    bands.forEach((b, j) => {
      const confidence = bandConfidence(x, b);
      if (confidence > 0) {
        const cand = { i, j, confidence, delta: x - b.center };
        candidates.push(cand);
        perPeak[i].push(cand);
      }
    });
  });

  // Ties in confidence go to the closer peak/band pair; the index keys make the
  // order fully deterministic when even |delta| ties.
  candidates.sort((a, b) => (b.confidence - a.confidence)
    || (Math.abs(a.delta) - Math.abs(b.delta))
    || (a.i - b.i) || (a.j - b.j));

  const peakBand = new Array(list.length).fill(-1);
  const bandUsed = new Array(bands.length).fill(false);
  for (const c of candidates) {
    if (peakBand[c.i] !== -1 || bandUsed[c.j]) continue;
    peakBand[c.i] = c.j;
    bandUsed[c.j] = true;
  }

  return list.map((p, i) => {
    const x = peakX(p);
    const alts = perPeak[i]
      .slice()
      .sort((a, b) => (b.confidence - a.confidence) || (Math.abs(a.delta) - Math.abs(b.delta)) || (a.j - b.j))
      .map(c => ({ bandId: bands[c.j].id, label: bands[c.j].label, confidence: c.confidence, delta: c.delta }));
    const peakId = p && p.id !== undefined ? p.id : null;
    const j = peakBand[i];
    if (j !== -1) {
      const c = perPeak[i].find(k => k.j === j);
      return { peakId, x, kind: 'band', bandId: bands[j].id, label: bands[j].label,
        confidence: c.confidence, delta: c.delta, alternatives: alts, regionId: null };
    }
    const region = isNum(x) ? regions.find(r => Array.isArray(r.range) && x >= r.range[0] && x <= r.range[1]) : null;
    if (region) {
      // Region membership is a plain yes/no on the atlas window, hence confidence 1.
      return { peakId, x, kind: 'region', bandId: null, label: region.label,
        confidence: 1, delta: null, alternatives: alts, regionId: region.id };
    }
    return { peakId, x, kind: 'unassigned', bandId: null, label: 'unassigned',
      confidence: 0, delta: null, alternatives: alts, regionId: null };
  });
}
