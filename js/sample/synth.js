/* Synthetic demo spectra, so the app can be explored without lab data.

   Everything band-specific comes from the library (the atlas): positions,
   schematic heights and widths, and the monolayer criteria. What the atlas does
   not say — count scale, lineshape mix, background, noise, spike sizes, the G
   width of a monolayer — are app choices, and each spectrum's
   meta.description says which numbers are which. These spectra are
   illustrations, never reference data.

   Seeded and deterministic: the same seed always gives the same spectrum, so a
   demo, a screenshot and a bug report all show the same thing. Noise and spike
   placement use separate PRNG streams so switching noise off does not move the
   spikes. */

import { peakY } from '../fit/profile.js';

// The atlas schematic stores Gaussian σ; the WiRE profile wants FWHM (2√(2 ln 2) σ).
// Same factor the library uses for fit.fwhmSeed, so the demo matches the fit seeds.
const SIG_TO_FWHM = 2.3548;
const READ_NOISE = 4;          // counts; keeps σ > 0 where the signal is ~0 (app choice)
const SPIKE_STREAM = 0x5bd1e995;

/** mulberry32 — tiny, fast, good enough for synthetic noise; same generator as the test harness. */
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate (Box–Muller). */
function gauss(r) {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function num(v, dflt) { const n = Number(v); return v === undefined || v === null || !Number.isFinite(n) ? dflt : n; }

function seedOf(opts) { return Math.trunc(num(opts.seed, 1)) | 0; }

/** Evenly spaced ascending axis; a real CCD axis is not uniform in cm⁻¹, but nothing here depends on that. */
function axis(xMin, xMax, n) {
  if (!(xMax > xMin)) throw new Error('Synthetic spectrum: xMax must be greater than xMin.');
  if (!(n >= 16)) throw new Error('Synthetic spectrum: needs at least 16 points.');
  const x = new Float64Array(n), dx = (xMax - xMin) / (n - 1);
  for (let i = 0; i < n; i++) x[i] = xMin + i * dx;
  x[n - 1] = xMax;
  return x;
}

/** Smooth, slowly varying fluorescence-like background (app choice): a gentle rise plus a broad hump. */
function background(x, level) {
  const n = x.length, b = new Float64Array(n);
  if (!level) return b;
  const x0 = x[0], span = x[n - 1] - x[0];
  for (let i = 0; i < n; i++) {
    const u = (x[i] - x0) / span, h = (x[i] - 1900) / 700;
    b[i] = level * (0.6 + 0.5 * u - 0.15 * u * u + 0.2 * Math.exp(-0.5 * h * h));
  }
  return b;
}

/** Shot noise ∝ √counts on top of a small read-noise floor — what a CCD actually shows. */
function addNoise(y, r, scale) {
  if (!scale) return;
  for (let i = 0; i < y.length; i++) {
    y[i] += scale * Math.sqrt(Math.max(y[i], 0) + READ_NOISE * READ_NOISE) * gauss(r);
  }
}

/**
 * Add `count` cosmic-ray spikes of 1, 2, 3, 1, … points. They are kept away from
 * band centres so the demo shows them on clean baseline (where a user can see what
 * despiking removed), and apart from each other so each is one event.
 */
function addSpikes(x, y, r, count, height, avoid) {
  const spikes = [], n = x.length, lo = Math.floor(n * 0.04), hi = Math.ceil(n * 0.96);
  for (let k = 0; k < count; k++) {
    const width = (k % 3) + 1;
    let start = -1;
    for (let attempt = 0; attempt < 400 && start < 0; attempt++) {
      const s = lo + Math.floor(r() * (hi - lo - width));
      const xs = x[s], xe = x[s + width - 1];
      const nearBand = attempt < 300 && avoid.some(([c, half]) => xe > c - half && xs < c + half);
      const nearSpike = spikes.some(p => s <= p.end + 25 && s + width - 1 >= p.start - 25);
      if (!nearBand && !nearSpike) start = s;
    }
    if (start < 0) break;
    const H = height * (0.8 + 0.7 * r());
    // Multi-pixel events are uneven: one hot pixel plus partially charged neighbours.
    const peakAt = start + Math.floor(r() * width);
    let top = 0;
    for (let i = start; i < start + width; i++) {
      const add = i === peakAt ? H : H * (0.45 + 0.35 * r());
      y[i] += add;
      if (add > top) top = add;
    }
    spikes.push({ start, end: start + width - 1, xStart: x[start], xEnd: x[start + width - 1], width, height: top });
  }
  return spikes.sort((a, b) => a.start - b.start);
}

function makeSpectrum({ id, name, file, x, y, meta }) {
  return {
    id, name, x, y,
    xLabel: 'Raman shift', xUnit: 'cm⁻¹', yLabel: 'Intensity',
    source: { file, format: 'synthetic' },
    meta,
  };
}

/** Atlas reference excitation, when the library states one (positions belong to that laser). */
function laserOf(lib) {
  const nm = lib && lib.referenceExcitation && Number(lib.referenceExcitation.nm);
  return Number.isFinite(nm) && nm > 0 ? nm : undefined;
}

/**
 * Graphene-oxide-like demo spectrum built from the library's atlas schematic.
 * Each band with `plot: { mu, A, sig }` becomes a WiRE pseudo-Voigt
 * (x0 = mu, w = sig·2.3548, h ∝ A, g = gaussianPct), scaled so the tallest band
 * is `peakCounts` counts, on a smooth fluorescence background, with Poisson-like
 * noise and cosmic-ray spikes 1, 2 and 3 points wide (listed in meta.spikes).
 * @param {object} lib band library (graphene-go.json)
 * @param {object} [opts]
 * @param {number} [opts.seed=1]
 * @param {number} [opts.n=1801] number of points
 * @param {number} [opts.xMin=800] cm⁻¹
 * @param {number} [opts.xMax=3500] cm⁻¹
 * @param {number} [opts.peakCounts=4000] height of the tallest band (0 → background only)
 * @param {number} [opts.gaussianPct=50] % Gaussian of every component
 * @param {number} [opts.background=1500] fluorescence level in counts (0 → none)
 * @param {number} [opts.noise=1] noise multiplier (0 → noise-free)
 * @param {number} [opts.spikes=3] number of cosmic-ray spikes
 * @param {Object<string, number>} [opts.relHeights] band id → relative height, replacing the
 *   schematic plot.A for those bands (an app choice, recorded in meta.description)
 * @param {string} [opts.id] spectrum id (default 'synth-go-<seed>')
 * @param {string} [opts.name]
 * @returns {object} Spectrum with meta { synthetic, description, seed, spikes, laserNm, components }
 */
export function synthFromLibrary(lib, opts = {}) {
  const bands = ((lib && lib.bands) || []).filter(b => b.plot &&
    [b.plot.mu, b.plot.A, b.plot.sig].every(v => Number.isFinite(v)) && b.plot.sig > 0);
  if (!bands.length) throw new Error('This library has no band schematic (plot.mu / A / sig) to build a demo spectrum from.');
  const seed = seedOf(opts);
  const n = Math.round(num(opts.n, 1801));
  const x = axis(num(opts.xMin, 800), num(opts.xMax, 3500), n);
  const peakCounts = Math.max(0, num(opts.peakCounts, 4000));
  const g = Math.min(100, Math.max(0, num(opts.gaussianPct, 50)));
  const level = Math.max(0, num(opts.background, 1500));
  const noise = Math.max(0, num(opts.noise, 1));
  const nSpikes = Math.max(0, Math.floor(num(opts.spikes, 3)));

  const rel = opts.relHeights || {};
  const A = b => (Number.isFinite(rel[b.id]) ? rel[b.id] : b.plot.A);
  const maxA = Math.max(...bands.map(A));
  const components = bands.map(b => ({
    bandId: b.id, label: b.label,
    x0: b.plot.mu, w: b.plot.sig * SIG_TO_FWHM, h: maxA > 0 ? (A(b) / maxA) * peakCounts : 0, g,
  }));
  const overridden = bands.filter(b => Number.isFinite(rel[b.id])).map(b => `${b.label} ${rel[b.id]}`);

  const y = background(x, level);
  if (peakCounts > 0) {
    for (const c of components) for (let i = 0; i < n; i++) y[i] += peakY(c, x[i]);
  }
  addNoise(y, mulberry32(seed), noise);
  const spikes = addSpikes(x, y, mulberry32(seed ^ SPIKE_STREAM), nSpikes,
    Math.max(peakCounts, level, 1000), components.map(c => [c.x0, Math.max(30, 0.6 * c.w)]));

  const laserNm = laserOf(lib);
  const description =
    'Synthetic graphene-oxide-like spectrum for demonstration, not measured data. ' +
    `Bands from the atlas schematic of the "${lib.name || lib.id}" library: each band's plot.mu, plot.A and plot.sig ` +
    `drawn as a WiRE pseudo-Voigt with FWHM = sig × ${SIG_TO_FWHM}. ` +
    (overridden.length ? `Relative heights replaced by app choices that follow the atlas's own description of graphene oxide (strong D, D′ shoulder, D* and D″ present, weak broad 2D with I(D+D′) > I(2D)): ${overridden.join(', ')}. ` : '') +
    `App choices (not atlas data): ${g}% Gaussian lineshape; heights scaled so the tallest band is ${peakCounts} counts; ` +
    `a smooth fluorescence background of ~${level} counts; Poisson-like shot noise (×${noise}) plus ${READ_NOISE}-count read noise; ` +
    `${spikes.length} cosmic-ray spike${spikes.length === 1 ? '' : 's'} (1, 2 and 3 points wide, listed in meta.spikes). ` +
    (laserNm ? `Positions are the atlas values, i.e. for its reference excitation (${laserNm} nm, ${lib.referenceExcitation.status || 'stated'}).` : '');

  return makeSpectrum({
    id: opts.id || `synth-go-${seed}`,
    name: opts.name || 'Demo · graphene oxide (synthetic)',
    file: 'synthetic-graphene-oxide',
    x, y,
    meta: { synthetic: true, description, seed, spikes, ...(laserNm ? { laserNm } : {}), components },
  });
}

/** Plain text of an atlas HTML snippet (tags dropped, entities that matter here decoded). */
function plain(s) {
  return String(s || '').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * The atlas's monolayer statement: 2D FWHM range and I_2D/I_G. Read from the
 * library text rather than hard-coded, so the demo can never drift from the atlas.
 */
function monolayerCriteria(lib) {
  const texts = [];
  for (const r of lib.ratios || []) for (const e of r.eqs || []) texts.push(plain(e));
  const twoD = (lib.bands || []).find(b => b.id === 'twoD');
  if (twoD) texts.push(plain(twoD.meaning));
  const fwhmRe = /FWHM\s*≈\s*(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*cm/;
  const ratioRe = /I_?2D\s*\/\s*I_?G\s*≈\s*(\d+(?:\.\d+)?)/;
  for (const t of texts) {
    const f = fwhmRe.exec(t), r = ratioRe.exec(t);
    if (f && r) return { fwhmLo: +f[1], fwhmHi: +f[2], ratio: +r[1], text: t };
  }
  return null;
}

/**
 * Pristine-monolayer-graphene-like demo spectrum: G at the atlas G position and a
 * single sharp Lorentzian 2D at the atlas 2D position, with the 2D FWHM inside
 * (the middle of) the atlas's monolayer range and I_2D/I_G equal to the atlas's
 * value; no D band. The G width and lineshape are app choices (the atlas states
 * none) and are recorded in meta.description.
 * @param {object} lib band library (graphene-go.json)
 * @param {object} [opts]
 * @param {number} [opts.seed=1]
 * @param {number} [opts.n=1801]
 * @param {number} [opts.xMin=800]
 * @param {number} [opts.xMax=3500]
 * @param {number} [opts.peakCounts=3000] 2D height in counts (0 → background only)
 * @param {number} [opts.gFwhm=15] G FWHM, cm⁻¹ (app choice)
 * @param {number} [opts.twoDFwhm] 2D FWHM, default the middle of the atlas range
 * @param {number} [opts.ratio] I_2D/I_G, default the atlas value
 * @param {number} [opts.background=300]
 * @param {number} [opts.noise=1]
 * @param {number} [opts.spikes=0]
 * @param {string} [opts.id] default 'synth-1lg-<seed>'
 * @param {string} [opts.name]
 * @returns {object} Spectrum with meta { synthetic, description, seed, spikes, laserNm, components }
 */
export function synthMonolayer(lib, opts = {}) {
  const bands = (lib && lib.bands) || [];
  const G = bands.find(b => b.id === 'G'), T = bands.find(b => b.id === 'twoD');
  if (!G || !T) throw new Error('A monolayer demo needs a library with G and 2D bands (graphene-go).');
  const crit = monolayerCriteria(lib);
  if (!crit && (opts.twoDFwhm === undefined || opts.ratio === undefined)) {
    throw new Error('This library does not state monolayer 2D criteria (FWHM range and I_2D/I_G).');
  }
  const seed = seedOf(opts);
  const n = Math.round(num(opts.n, 1801));
  const x = axis(num(opts.xMin, 800), num(opts.xMax, 3500), n);
  const peakCounts = Math.max(0, num(opts.peakCounts, 3000));
  const gFwhm = Math.max(1, num(opts.gFwhm, 15));
  const twoDFwhm = Math.max(1, num(opts.twoDFwhm, crit ? (crit.fwhmLo + crit.fwhmHi) / 2 : NaN));
  const ratio = Math.max(1e-6, num(opts.ratio, crit ? crit.ratio : NaN));
  const level = Math.max(0, num(opts.background, 300));
  const noise = Math.max(0, num(opts.noise, 1));
  const nSpikes = Math.max(0, Math.floor(num(opts.spikes, 0)));

  const components = [
    { bandId: G.id, label: G.label, x0: G.posSort, w: gFwhm, h: peakCounts / ratio, g: 0 },
    { bandId: T.id, label: T.label, x0: T.posSort, w: twoDFwhm, h: peakCounts, g: 0 },
  ];
  const y = background(x, level);
  if (peakCounts > 0) {
    for (const c of components) for (let i = 0; i < n; i++) y[i] += peakY(c, x[i]);
  }
  addNoise(y, mulberry32(seed), noise);
  const spikes = addSpikes(x, y, mulberry32(seed ^ SPIKE_STREAM), nSpikes,
    Math.max(peakCounts, level, 1000), components.map(c => [c.x0, Math.max(30, 2 * c.w)]));

  const laserNm = laserOf(lib);
  const fromAtlas = crit ? `the atlas states FWHM ≈ ${crit.fwhmLo}–${crit.fwhmHi} cm⁻¹ and I_2D/I_G ≈ ${crit.ratio} for a monolayer` : 'criteria supplied by the caller';
  const description =
    'Synthetic pristine-monolayer-graphene-like spectrum for demonstration, not measured data. ' +
    `From the atlas: G at ${G.posSort} cm⁻¹ and 2D at ${T.posSort} cm⁻¹ (posSort); a single Lorentzian 2D ` +
    `with FWHM ${twoDFwhm} cm⁻¹ (${fromAtlas}); no D band (forbidden in pristine graphene). ` +
    (opts.ratio !== undefined
      ? `2D/G height ratio ${ratio}: an app choice inside the atlas's monolayer range (≈2, up to ~4 suspended), set clear of the ≥ 2 decision threshold so the demo reads unambiguously. `
      : `2D/G height ratio ${ratio} (atlas value). `) +
    `App choices (not atlas data): G FWHM ${gFwhm} cm⁻¹ and a Lorentzian G lineshape; 2D height ${peakCounts} counts; ` +
    `a weak smooth background of ~${level} counts; Poisson-like shot noise (×${noise}) plus ${READ_NOISE}-count read noise` +
    (spikes.length ? `; ${spikes.length} cosmic-ray spike${spikes.length === 1 ? '' : 's'} (meta.spikes)` : '') + '. ' +
    (laserNm ? `Positions are for the atlas reference excitation (${laserNm} nm, ${lib.referenceExcitation.status || 'stated'}).` : '');

  return makeSpectrum({
    id: opts.id || `synth-1lg-${seed}`,
    name: opts.name || 'Demo · monolayer graphene (synthetic)',
    file: 'synthetic-monolayer-graphene',
    x, y,
    meta: { synthetic: true, description, seed, spikes, ...(laserNm ? { laserNm } : {}), components },
  });
}
