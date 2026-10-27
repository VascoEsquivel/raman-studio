/* Private reference lists: candidate positions for peaks the atlas leaves unassigned.

   A reference list is a JSON file the user loads (schema raman-studio/reference-list@1).
   It lives for the session only: it is not bundled with the app, never uploaded, and
   not written into project files. Each material lists band positions taken from a
   source, and the source itself. A peak within the list's tolerance of a listed band
   gets that material as a *candidate*: a coincidence of position, not an
   identification. Several bands of one material lining up is stronger evidence than
   one, so materials are also summarised by how many of their bands have a peak near
   them. */

export const REFERENCE_SCHEMA = 'raman-studio/reference-list@1';

/** An http(s) URL, or null: links from a user's file are shown only if they are web links. */
export function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim() : null;
}

/**
 * Validate a reference list.
 * @param {string|object} json file text or parsed object
 * @returns {{id:string, name:string, toleranceCm:number, note:string,
 *   materials:Array<{name:string, role:string, bands:number[], source:({url:string, text:string}|null)}>}}
 * @throws {Error} with a message fit for the user when the file is not a usable list
 */
export function parseReferenceList(json) {
  let o;
  try { o = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new Error('Not a reference list: the file is not valid JSON.'); }
  if (!o || o.schema !== REFERENCE_SCHEMA) throw new Error(`Not a reference list (expected "schema": "${REFERENCE_SCHEMA}").`);
  const tol = Number(o.toleranceCm);
  if (!(tol > 0 && tol <= 100)) throw new Error('Reference list: toleranceCm must be a number of cm⁻¹ between 0 and 100.');
  if (!Array.isArray(o.materials) || !o.materials.length) throw new Error('Reference list: it lists no materials.');
  const materials = o.materials.map((m, i) => {
    const bands = Array.isArray(m && m.bands) ? m.bands.map(Number).filter(Number.isFinite) : [];
    if (!m || !m.name || !bands.length) throw new Error(`Reference list: material ${i + 1} needs a name and at least one band position.`);
    const url = m.source && safeUrl(m.source.url);
    return { name: String(m.name), role: m.role ? String(m.role) : '', bands, source: url ? { url, text: m.source.text ? String(m.source.text) : '' } : null };
  });
  return { id: String(o.id || 'reference-list'), name: String(o.name || 'Reference list'), toleranceCm: tol, note: o.note ? String(o.note) : '', materials };
}

/**
 * Listed bands within the tolerance of one peak position, nearest first.
 * @param {number} x peak position (cm⁻¹)
 * @param {object} list result of parseReferenceList
 * @returns {Array<{material:string, role:string, position:number, delta:number, source:object|null}>}
 *   delta = peak − listed position
 */
export function candidatesAt(x, list) {
  if (!list || !Number.isFinite(x)) return [];
  const out = [];
  for (const m of list.materials) {
    for (const b of m.bands) {
      const d = x - b;
      if (Math.abs(d) <= list.toleranceCm) out.push({ material: m.name, role: m.role, position: b, delta: d, source: m.source });
    }
  }
  return out.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
}

/**
 * For each material, which of its listed bands have a peak within the tolerance.
 * @param {number[]} xs peak positions
 * @param {object} list result of parseReferenceList
 * @returns {Array<{name:string, role:string, source:object|null, total:number,
 *   matched:Array<{position:number, x:number, delta:number}>}>} materials with at least one
 *   match, most matched bands first (then the larger share of the material's bands, then
 *   the smaller mean |delta|)
 */
export function materialSummary(xs, list) {
  if (!list) return [];
  const peaks = (xs || []).filter(Number.isFinite);
  const rows = list.materials.map(m => {
    const matched = [];
    for (const b of m.bands) {
      let best = null;
      for (const x of peaks) if (Math.abs(x - b) <= list.toleranceCm && (!best || Math.abs(x - b) < Math.abs(best.delta))) best = { position: b, x, delta: x - b };
      if (best) matched.push(best);
    }
    return { name: m.name, role: m.role, source: m.source, total: m.bands.length, matched };
  }).filter(r => r.matched.length);
  const meanD = r => r.matched.reduce((s, q) => s + Math.abs(q.delta), 0) / r.matched.length;
  return rows.sort((a, b) => b.matched.length - a.matched.length || b.matched.length / b.total - a.matched.length / a.total || meanD(a) - meanD(b));
}
