/* "Read your spectrum" — the atlas's eight decision steps, filled with numbers.

   Ground rule: the only numeric thresholds used are the ones the atlas states
   (step 1: 2D FWHM < 30 cm⁻¹ and I_2D/I_G ≥ 2; ratio card 5: I(2D) vs I(D+D′)).
   Even those are read out of the atlas step text, not typed in here. Words like
   "strong", "broad" or "little" have no number in the atlas, so they are shown
   as the measured value for the user to judge — inventing a cutoff would put
   words in the atlas's mouth.

   Presence is three-valued on purpose. "Absent" is a claim that needs evidence:
   a fit that covered the band and found nothing significant, or a detection run
   that searched the band's window. Without that the band is "unknown", and a
   step that hinges on it is reported as 'insufficient' rather than guessed. */

import { computeRatios, bandSources } from './ratios.js';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const f1 = v => v.toFixed(1);
const fr = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

function plain(html) {
  return String(html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** The monolayer thresholds exactly as the atlas step 1 text states them. */
function atlasThresholds(html) {
  const f = /FWHM\s*(?:&lt;|<)\s*([\d.]+)\s*cm/.exec(html || '');
  const r = /I_2D\/I_G\s*(?:≥|&ge;|>=)\s*([\d.]+)/.exec(html || '');
  return { maxFwhm: f ? Number(f[1]) : null, minRatio: r ? Number(r[1]) : null };
}

function statusOf(checks) {
  if (!checks.length || checks.every(c => c.ok === null)) return 'insufficient';
  if (checks.some(c => c.key && c.ok === false)) return 'no';
  if (checks.some(c => c.key && c.ok === null)) return 'insufficient';
  if (checks.every(c => c.ok === true)) return 'match';
  return 'partial';
}

const srcWord = s => (s === 'fit' ? 'fit' : 'detected');

/**
 * Evaluate the library's read-your-spectrum steps with the measured numbers.
 * Only the graphene-go library is evaluated; any other library gets its steps
 * back as 'info' with no evidence.
 * @param {object} prepared result of prepareLibrary
 * @param {{ ratios?: object[], components?: object[], assignments?: object[], peaks?: object[],
 *   noiseSigma?: number, xRange?: [number, number] }} [data]
 *   ratios default to computeRatios(...); assignments to matchPeaks(peaks, prepared).
 *   xRange (addition to the contract) is the x extent detection searched — without it the
 *   searched extent is taken as the span of the detected peaks, which never overstates it.
 * @returns {{ steps: Array<{ index: number, html: string,
 *   status: 'match'|'partial'|'no'|'info'|'insufficient', evidence: string[],
 *   checks: Array<{ text: string, ok: boolean|null, key: boolean }> }>,
 *   summary: { stepIndex: number, status: 'match'|'partial', text: string } | null }}
 *   `index` is 0-based (atlas step number = index + 1); `checks` is an addition to the contract.
 */
export function evaluateWorkflow(prepared, { ratios, components, assignments, peaks, noiseSigma, xRange } = {}) {
  const lib = prepared && prepared.library;
  const htmls = lib && Array.isArray(lib.workflow) ? lib.workflow : [];
  const infoOnly = () => ({
    steps: htmls.map((html, index) => ({ index, html, status: 'info', evidence: [], checks: [] })),
    summary: null,
  });
  if (!lib || lib.id !== 'graphene-go') return infoOnly();

  const src = bandSources(prepared, { assignments, peaks, components });
  const rs = Array.isArray(ratios) ? ratios
    : computeRatios(prepared, { assignments: src.assignments, peaks: src.peaks, components: src.comps });
  const ratio = (num, den) => rs.find(r => r && r.num === num && r.den === den) || null;
  const sigma = isNum(noiseSigma) && noiseSigma > 0 ? noiseSigma : 0;
  const pband = id => prepared.bands.find(b => b.id === id) || null;

  // Extent the detector looked at. The detected peaks' own span is a lower bound,
  // so it can only under-claim "searched", never invent an absence.
  let searchLo = NaN, searchHi = NaN;
  if (Array.isArray(xRange) && isNum(xRange[0]) && isNum(xRange[1])) {
    searchLo = Math.min(xRange[0], xRange[1]); searchHi = Math.max(xRange[0], xRange[1]);
  } else if (Array.isArray(peaks)) {
    for (const p of peaks) {
      if (!p || !isNum(p.x)) continue;
      const lo = isNum(p.leftX) ? p.leftX : p.x, hi = isNum(p.rightX) ? p.rightX : p.x;
      searchLo = Number.isNaN(searchLo) ? lo : Math.min(searchLo, lo);
      searchHi = Number.isNaN(searchHi) ? hi : Math.max(searchHi, hi);
    }
  }
  const detectionRan = Array.isArray(peaks);
  const searchedAt = x => detectionRan && isNum(x) && x >= searchLo && x <= searchHi;

  const stateCache = new Map();
  const st = id => {
    if (stateCache.has(id)) return stateCache.get(id);
    const label = src.bandLabel(id);
    const c = src.component(id);
    const p = src.detected(id);
    let s;
    if (c && c.significant && isNum(c.h) && c.h > 3 * sigma) {
      s = { id, label, state: 'present', source: 'fit', x: c.x0, h: c.h, w: isNum(c.w) ? Math.abs(c.w) : NaN };
    } else if (p) {
      s = { id, label, state: 'present', source: 'detected', x: p.x, h: p.y, w: isNum(p.fwhm) ? p.fwhm : NaN };
    } else if (c) {
      s = { id, label, state: 'absent', why: c.significant ? 'fitted height not above 3σ noise' : 'fit component not significant' };
    } else if (pband(id) && searchedAt(pband(id).center)) {
      s = { id, label, state: 'absent', why: 'no detected peak in its window; Deconvolve to check for a hidden shoulder' };
    } else {
      s = { id, label, state: 'unknown' };
    }
    stateCache.set(id, s);
    return s;
  };
  const describe = (s, withHeight = false) => {
    if (s.state === 'present') {
      const h = withHeight && isNum(s.h) ? `, height ${fr(s.h)}` : '';
      return `${s.label} present at ${f1(s.x)} cm⁻¹ (${srcWord(s.source)}${h})`;
    }
    if (s.state === 'absent') return `${s.label} absent (${s.why})`;
    return `${s.label}: presence unknown — run Detect peaks or Deconvolve`;
  };
  const check = (text, ok, key, detail) => ({ text, ok, key, detail });
  const present = (id, key, text) => {
    const s = st(id);
    return check(text || `${s.label} present`, s.state === 'present' ? true : s.state === 'absent' ? false : null, key, describe(s));
  };
  const absent = (id, key) => {
    const s = st(id);
    return check(`${s.label} absent`, s.state === 'absent' ? true : s.state === 'present' ? false : null, key, describe(s));
  };
  const hr = (num, den) => {
    const r = ratio(num, den);
    return r && r.height ? r.height : null;
  };
  const ratioText = (name, h) => `${name} = ${fr(h.value)} (height, ${srcWord(h.source)})`;

  // Atlas ratio card 5: ordered ⇒ I(2D) > I(D+D′); oxidised/disordered ⇒ I(D+D′) > I(2D).
  // +1 = 2D stronger, −1 = D+D′ stronger, null = can't tell.
  const orderGauge = () => {
    const t = st('twoD'), c = st('DDp');
    if (t.state === 'absent' && c.state === 'present') return { cmp: -1, detail: `${t.label} absent, ${c.label} present → I(${c.label}) > I(${t.label}) (atlas ratio card 5)` };
    if (t.state === 'present' && c.state === 'absent') return { cmp: 1, detail: `${c.label} absent, ${t.label} present → I(${t.label}) > I(${c.label}) (atlas ratio card 5)` };
    if (t.state === 'present' && c.state === 'present') {
      const h = hr('twoD', 'DDp');
      if (h && h.value !== 1) {
        return { cmp: h.value > 1 ? 1 : -1, detail: `I(${t.label})/I(${c.label}) = ${fr(h.value)} (height, ${srcWord(h.source)}) → ${h.value > 1 ? `I(${t.label}) > I(${c.label})` : `I(${c.label}) > I(${t.label})`} (atlas ratio card 5)` };
      }
      const r = ratio('twoD', 'DDp');
      return { cmp: null, detail: `I(${t.label}) vs I(${c.label}) not comparable${r && r.missing.length ? `: ${r.missing.join('; ')}` : ''}` };
    }
    return { cmp: null, detail: `I(${t.label}) vs I(${c.label}) unknown — ${describe(t)}; ${describe(c)}` };
  };

  const th = atlasThresholds(htmls[0]);
  const thText = th.maxFwhm !== null ? `< ${th.maxFwhm} cm⁻¹` : '(threshold not found in the atlas text)';

  const fwhmCheck = (wantSharp, key) => {
    const s = st('twoD');
    const text = wantSharp ? `${s.label} FWHM ${thText}` : `${s.label} broader than the monolayer's ${thText}`;
    if (th.maxFwhm === null) return check(text, null, key, `${s.label} FWHM threshold not found in the atlas step 1 text`);
    if (s.state !== 'present' || !isNum(s.w)) {
      return check(text, s.state === 'absent' ? false : null, key, s.state === 'present' ? `${s.label} FWHM not measured` : describe(s));
    }
    const sharp = s.w < th.maxFwhm;
    const detail = `${s.label} FWHM ${f1(s.w)} cm⁻¹ ${sharp ? '<' : '≥'} ${th.maxFwhm} cm⁻¹ (${srcWord(s.source)})`;
    return check(text, wantSharp ? sharp : !sharp, key, detail);
  };
  const ratio2DCheck = (wantHigh, key) => {
    const name = `I_${st('twoD').label}/I_${st('G').label}`;
    const text = th.minRatio === null ? `${name} (threshold not found in the atlas text)` : `${name} ${wantHigh ? '≥' : '<'} ${th.minRatio}`;
    if (th.minRatio === null) return check(text, null, key, `${name} threshold not found in the atlas step 1 text`);
    const h = hr('twoD', 'G');
    if (!h) {
      const r = ratio('twoD', 'G');
      return check(text, null, key, `${name} not available${r && r.missing.length ? `: ${r.missing.join('; ')}` : ''}`);
    }
    const high = h.value >= th.minRatio;
    return check(text, wantHigh ? high : !high, key, `${ratioText(name, h)} ${high ? '≥' : '<'} ${th.minRatio}`);
  };
  const idig = () => {
    const h = hr('D', 'G');
    return h ? ratioText(`I_${st('D').label}/I_${st('G').label}`, h) : null;
  };

  const steps = [];
  const push = (index, checks, notes = [], forced = null) => {
    const status = forced || statusOf(checks);
    const evidence = checks.map(c => c.detail).concat(notes.filter(Boolean));
    steps.push({ index, html: htmls[index], status, evidence, checks: checks.map(({ text, ok, key }) => ({ text, ok, key })) });
  };

  const others = ids => ids.map(st).filter(s => s.state === 'present').map(s => s.label);

  for (let index = 0; index < htmls.length; index++) {
    if (index === 0) {
      const checks = [present('G', true), present('twoD', true), fwhmCheck(true, true), ratio2DCheck(true, false), absent('D', true)];
      const extra = others(['Dstar', 'Dpp', 'Dp', 'DDpp', 'DDp', 'twoDp']);
      push(index, checks, [extra.length ? `Also present: ${extra.join(', ')} (step 1 expects only G + 2D)` : null]);
    } else if (index === 1) {
      const d = st('D');
      let little;
      if (d.state === 'absent') little = check(`little/no ${d.label}`, true, true, describe(d));
      else if (d.state === 'unknown') little = check(`little/no ${d.label}`, null, true, describe(d));
      else {
        const g = orderGauge();
        const lead = `${describe(d)}${idig() ? `, ${idig()}` : ''}; the atlas gives no number for "little"`;
        little = check(`little/no ${d.label}`, g.cmp === null ? null : g.cmp > 0, true, `${lead} — ${g.detail}${g.cmp > 0 ? ': ordered, few defects' : g.cmp < 0 ? ': disordered' : ''}`);
      }
      const t = st('twoD');
      const checks = [present('G', true), present('twoD', true), fwhmCheck(false, true), ratio2DCheck(false, false), little,
        check(`multi-component ${t.label}`, null, false, `${t.label} component count is not determined automatically — inspect the lineshape (atlas: 4 components in AB bilayers)`)];
      push(index, checks);
    } else if (index === 2) {
      const g = orderGauge();
      const t = st('twoD');
      let weak;
      if (t.state === 'absent') weak = check(`weak or absent ${t.label}`, true, true, describe(t));
      else weak = check(`weak or absent ${t.label}`, g.cmp === null ? null : g.cmp < 0, true, g.detail);
      const checks = [present('D', true), present('Dp', false, `${st('Dp').label} shoulder on ${st('G').label}`),
        present('Dstar', false), present('Dpp', false), weak];
      const widths = ['D', 'G', 'twoD'].map(st).filter(s => s.state === 'present' && isNum(s.w)).map(s => `${s.label} ${f1(s.w)}`);
      push(index, checks, [
        idig() ? `${idig()} — the atlas gives no number for "strong D"` : null,
        widths.length ? `FWHM: ${widths.join(', ')} cm⁻¹ — the atlas gives no number for "broad"` : null,
      ]);
    } else if (index === 3) {
      const r = ratio('D', 'Dp');
      const ev = [];
      if (r && r.height) ev.push(ratioText(`I_${st('D').label}/I_${st('Dp').label}`, r.height));
      if (r && r.classify) ev.push(`Nearest atlas value ${r.classify.nearest} → ${r.classify.label}`);
      if (r && r.area) ev.push(`A_${st('D').label}/A_${st('Dp').label} = ${fr(r.area.value)} (fit areas)`);
      if (ev.length) push(index, [], ev, 'info');
      else push(index, [], r ? r.missing : ['No I_D/I_D′ ratio in this library'], 'insufficient');
    } else if (index === 4) {
      const r = ratio('D', 'G');
      const ev = [];
      if (r && r.height) ev.push(ratioText(`I_${st('D').label}/I_${st('G').label}`, r.height));
      if (r && r.area) ev.push(`A_${st('D').label}/A_${st('G').label} = ${fr(r.area.value)} (fit areas)`);
      if (r && isNum(r.extras.gWidth)) {
        ev.push(`${st('G').label} FWHM ${f1(r.extras.gWidth)} cm⁻¹ (${srcWord(r.extras.gWidthSource)}) — atlas: a broad G means the amorphisation regime; it gives no numeric cutoff`);
      }
      for (const c of (r && r.extras.crystalliteSize) || []) {
        ev.push(`Lₐ = ${f1(c.valueNm)} nm from the ${c.basis} ratio (Cançado, E_l = ${c.El.toFixed(2)} eV) — valid in the low-defect regime only`);
      }
      if (ev.length) push(index, [], ev, 'info');
      else push(index, [], r ? r.missing : ['No I_D/I_G ratio in this library'], 'insufficient');
    } else if (index === 5) {
      const ids = ['D', 'twoD', 'DDp', 'Dstar', 'Dpp'];
      const known = ids.map(st).filter(s => s.state !== 'unknown');
      if (!known.length && !hr('D', 'G')) {
        push(index, [], ids.map(id => describe(st(id))), 'insufficient');
      } else {
        const h2 = hr('twoD', 'G');
        push(index, [], [
          'Single spectrum: compare these values across your GO → rGO series',
          idig(),
          describe(st('twoD'), true) + (h2 ? `, ${ratioText(`I_${st('twoD').label}/I_${st('G').label}`, h2)}` : ''),
          describe(st('DDp')),
          describe(st('Dstar'), true),
          describe(st('Dpp'), true),
        ], 'info');
      }
    } else if (index === 6) {
      const pos = ['G', 'twoD', 'twoDp'].map(st);
      const ev = pos.map(s => (s.state === 'present' ? `ω(${s.label}) = ${f1(s.x)} cm⁻¹ (${srcWord(s.source)})` : describe(s)));
      const ok = pos[0].state === 'present' || pos[1].state === 'present';
      if (ok && pos[0].state === 'present' && pos[1].state === 'present') {
        ev.push(`Plot ω(${pos[1].label}) against ω(${pos[0].label}) across samples to separate strain from doping`);
      }
      push(index, [], ev, ok ? 'info' : 'insufficient');
    } else if (index === 7) {
      const regions = Array.isArray(prepared.regions) ? prepared.regions : [];
      const ev = [];
      let searched = false;
      for (const reg of regions) {
        const [lo, hi] = reg.range;
        const inside = x => isNum(x) && x >= lo && x <= hi;
        const where = `${reg.name || reg.label} (${lo}–${hi} cm⁻¹)`;
        const hits = [];
        src.peaks.forEach((p, i) => {
          if (!p || !inside(p.x)) return;
          const a = src.assignments.find(q => q && q.peakId !== null && q.peakId !== undefined && q.peakId === p.id)
            || (src.assignments.length === src.peaks.length ? src.assignments[i] : null);
          const lab = a && a.kind === 'band' ? ` — currently labelled ${a.label}; decide: phonon combination or sp³ C–H stretching` : '';
          hits.push(`Peak at ${f1(p.x)} cm⁻¹ lies in the ${where}${lab}`);
        });
        for (const c of src.comps) {
          if (!c || !c.significant || !isNum(c.h) || !(c.h > 3 * sigma) || !inside(c.x0)) continue;
          hits.push(`Fitted ${c.label || src.bandLabel(c.bandId)} component at ${f1(c.x0)} cm⁻¹ lies in the ${where}`);
        }
        ev.push(...hits);
        // Searched if detection covered the region or a fitted band's window overlaps it.
        const fitCovers = src.comps.some(c => {
          const b = c && pband(c.bandId);
          return b && b.window[1] >= lo && b.window[0] <= hi;
        });
        const covered = (searchedAt(lo) && searchedAt(hi)) || fitCovers;
        if (!hits.length && covered) ev.push(`No peak or fitted component in the ${where}`);
        searched = searched || covered || hits.length > 0;
      }
      const gs = st('DDpp');
      if (gs.state !== 'unknown') ev.push(describe(gs));
      push(index, [], ev.length ? ev : ['No peaks or fitted components to check yet'], searched || gs.state !== 'unknown' ? 'info' : 'insufficient');
    } else {
      push(index, [], [], 'info');
    }
  }

  // Best reading among the three identification steps: a full match beats a
  // partial; among equals, the larger share of satisfied checks, then atlas order.
  let best = null;
  for (const s of steps.slice(0, 3)) {
    if (s.status !== 'match' && s.status !== 'partial') continue;
    const frac = s.checks.length ? s.checks.filter(c => c.ok === true).length / s.checks.length : 0;
    const rank = (s.status === 'match' ? 2 : 1) + frac;
    if (!best || rank > best.rank) best = { s, rank };
  }
  let summary = null;
  if (best) {
    const s = best.s;
    const m = /→\s*<b>([\s\S]*?)<\/b>/.exec(s.html || '');
    const what = m ? plain(m[1]) : plain(s.html || '');
    const n = s.index + 1;
    if (s.status === 'match') summary = { stepIndex: s.index, status: s.status, text: `Consistent with ${what} (atlas step ${n}).` };
    else {
      const open = s.checks.filter(c => c.ok !== true).map(c => c.text);
      summary = { stepIndex: s.index, status: s.status, text: `Partly consistent with ${what} (atlas step ${n}); not confirmed: ${open.join('; ')}.` };
    }
  }
  return { steps, summary };
}
