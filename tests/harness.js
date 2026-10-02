// Minimal zero-dependency test harness. Runs in any modern browser.
// Usage in a test file:
//   import { test, assert, assertClose, assertEqual, assertThrows, fixtureText } from './harness.js';
//   test('parses commas', () => { assertEqual(1 + 1, 2); });

const registry = [];
let currentFile = '(unknown)';

/** Called by the runner before importing each suite so tests know their file. */
export function setCurrentFile(name) { currentFile = name; }

/** Register a test. fn may be async. */
export function test(name, fn) { registry.push({ file: currentFile, name, fn }); }

export class AssertionError extends Error {
  constructor(msg) { super(msg); this.name = 'AssertionError'; }
}

export function assert(cond, msg = 'assertion failed') {
  if (!cond) throw new AssertionError(msg);
}

export function assertEqual(actual, expected, msg = '') {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${fmt(expected)}, got ${fmt(actual)}`);
  }
}

/** |actual - expected| <= tol (absolute). */
export function assertClose(actual, expected, tol = 1e-9, msg = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${expected} ± ${tol}, got ${actual}`);
  }
}

/** Element-wise assertClose over two array-likes of equal length. */
export function assertArrayClose(actual, expected, tol = 1e-9, msg = '') {
  assertEqual(actual.length, expected.length, `${msg} length`);
  for (let i = 0; i < expected.length; i++) {
    if (!(Math.abs(actual[i] - expected[i]) <= tol)) {
      throw new AssertionError(`${msg ? msg + ': ' : ''}index ${i}: expected ${expected[i]} ± ${tol}, got ${actual[i]}`);
    }
  }
}

/** Structural equality (JSON-comparable values). */
export function assertDeepEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new AssertionError(`${msg ? msg + ': ' : ''}expected ${e}, got ${a}`);
}

export function assertThrows(fn, re, msg = '') {
  let threw = false;
  try { fn(); } catch (err) {
    threw = true;
    if (re && !re.test(String(err && err.message))) {
      throw new AssertionError(`${msg ? msg + ': ' : ''}threw "${err.message}", expected ${re}`);
    }
  }
  if (!threw) throw new AssertionError(`${msg ? msg + ': ' : ''}expected an exception`);
}

/** Fetch a fixture from tests/fixtures/ as text. */
export async function fixtureText(name) {
  const r = await fetch(new URL(`./fixtures/${name}`, import.meta.url));
  if (!r.ok) throw new Error(`fixture ${name}: HTTP ${r.status}`);
  return r.text();
}

/** Fetch a fixture from tests/fixtures/ as an ArrayBuffer. */
export async function fixtureBuffer(name) {
  const r = await fetch(new URL(`./fixtures/${name}`, import.meta.url));
  if (!r.ok) throw new Error(`fixture ${name}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

/** Seeded PRNG (mulberry32, as in PeakForge) for reproducible synthetic data. */
export function rng(seed) {
  let a = seed | 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate from a uniform PRNG (Box–Muller). */
export function gauss(r) {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Run every registered test; returns a summary object. */
export async function runAll(onResult = () => {}) {
  const results = [];
  for (const t of registry) {
    const t0 = performance.now();
    let ok = true, error = null;
    try { await t.fn(); } catch (err) { ok = false; error = (err && (err.stack || err.message)) || String(err); }
    const r = { file: t.file, name: t.name, ok, error, ms: performance.now() - t0 };
    results.push(r);
    onResult(r);
  }
  const failed = results.filter(r => !r.ok).length;
  return { total: results.length, passed: results.length - failed, failed, results };
}

function fmt(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}
