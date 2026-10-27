"""Development-time validation of the app's fits against the lab's own WiRE curve fits.

Private and local only: reads lab files from the gitignored test-data/private/
folder, runs the app's own modules in a local browser (the server binds to
127.0.0.1), and writes results back under test-data/private/harness/. Nothing is
sent anywhere, and no lab value is stored in this script. Never part of the
deployed app; never run in CI.

For every WiRE curve-fit file (*_curvefit.wdf) with a matching point spectrum
(the same name without "_curvefit", .wdf preferred over .spc):

  * WiRE's fitted components are recovered exactly. A curve-fit file holds the
    total fitted envelope followed by one curve per component; each component is
    one pseudo-Voigt in WiRE's convention, so fitting it with the app's own
    profile returns WiRE's centre, FWHM, height and %Gaussian (residuals ~1e-9
    of the height). A component saved as zeros but still present in the
    envelope is recovered as envelope minus the saved components.
  * The app runs on the point spectrum with its default settings: processing,
    peak detection, atlas matching, deconvolution and ratios.
  * D and G are compared: the app's fitted component against the WiRE component
    whose centre falls in that band's match window, and I(D)/I(G) by height and
    by area. Every WiRE centre is also looked up among the app's detected peaks.

The lab's choice of bands differs from the atlas model (it adds bands the atlas
does not define), so these are comparisons, not pass/fail truths. A run is
saved as latest.json; --save-baseline also saves it as baseline.json, and later
runs flag changes from the baseline beyond the tolerances below.

Usage:
    python tools/lab_harness.py [--save-baseline] [--private test-data/private]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

# Changes from the baseline worth a look (harness tolerances, not scientific criteria).
TOL_POSITION_CM = 2.0      # fitted D or G centre or FWHM
TOL_RATIO_REL = 0.10       # I(D)/I(G), relative
TOL_DETECT_CM = 10.0       # a WiRE centre counts as detected if a peak lies this close

JS = r"""async ({ cases, base }) => {
  const { importFile } = await import(base + 'js/io/import.js');
  const { fitPeaks } = await import(base + 'js/fit/lm.js');
  const { runPipeline } = await import(base + 'js/process/pipeline.js');
  const { detectPeaks } = await import(base + 'js/detect/detect.js');
  const { loadLibraries, prepareLibrary } = await import(base + 'js/match/library.js');
  const { matchPeaks } = await import(base + 'js/match/matcher.js');
  const { deconvolve } = await import(base + 'js/fit/deconvolve.js');
  const { computeRatios } = await import(base + 'js/analysis/ratios.js');
  const load = async url => { const buf = await (await fetch(url)).arrayBuffer(); return importFile({ name: url.split('/').pop(), arrayBuffer: async () => buf }); };
  const libs = await loadLibraries(base + 'data/libraries/');
  const lib = (libs.libraries || libs)[0] || libs;
  const L = lib.library || lib;

  function exact(x, y) {
    let im = 0; for (let i = 1; i < y.length; i++) if (y[i] > y[im]) im = i;
    let a = im, b = im; while (a > 0 && y[a] > y[im] / 2) a--; while (b < y.length - 1 && y[b] > y[im] / 2) b++;
    const f = fitPeaks({ x, y, peaks: [{ x0: x[im], w: Math.max(x[b] - x[a], 4), h: y[im], g: 50 }], baseline: { mode: 'none' }, maxIter: 400 });
    const q = f.peaks[0];
    return { x0: q.x0, w: q.w, h: q.h, g: q.g, area: q.area, relResidual: f.stats.rmse / q.h };
  }

  const out = [];
  for (const c of cases) {
    const r = { name: c.name, point: c.point };
    try {
      const cf = (await load(c.curvefitUrl)).spectra;
      const x = cf[0].x, env = cf[0].y;
      const saved = cf.slice(1).filter(s => s.y.some(v => v > 0));
      const wire = saved.map(s => Object.assign(exact(x, s.y), { recovered: false }));
      const rest = Float64Array.from(env, (v, i) => v - saved.reduce((t, s) => t + s.y[i], 0));
      if (Math.max(...rest) > 0.01 * Math.max(...env)) wire.push(Object.assign(exact(x, rest), { recovered: true }));
      wire.sort((p, q) => p.x0 - q.x0);
      r.wire = wire;

      const sp = (await load(c.pointUrl)).spectra[0];
      const prep = prepareLibrary(L, { laserNm: sp.meta && sp.meta.laserNm || 532 });
      const t0 = performance.now();
      const pr = runPipeline(sp, {});
      const peaks = detectPeaks(pr.x, pr.y);
      const asg = matchPeaks(peaks, prep);
      const dc = deconvolve(pr.x, pr.y, prep.bands, { fitDefaults: L.fitDefaults });
      const ratios = computeRatios(prep, { assignments: asg, peaks, components: dc, laserNm: prep.laserNm });
      r.ms = performance.now() - t0;
      r.detected = peaks.map(p => p.x);
      r.app = dc.components.map(q => ({ bandId: q.bandId, x0: q.x0, w: q.w, h: q.h, g: q.g, area: q.area, significant: q.significant }));
      r.windows = dc.windows.map(w => ({ lo: w.lo, hi: w.hi, quality: w.stats.quality, bandIds: w.bandIds }));
      const idg = ratios.find(q => q.num === 'D' && q.den === 'G');
      r.appRatio = idg ? { height: idg.height, area: idg.area } : null;
      r.bands = {};
      for (const id of ['D', 'G']) {
        const b = prep.bands.find(q => q.id === id);
        const inWin = wire.filter(w => w.x0 >= b.window[0] && w.x0 <= b.window[1]).sort((p, q) => q.h - p.h);
        r.bands[id] = { window: b.window, wire: inWin[0] || null, app: r.app.find(q => q.bandId === id) || null };
      }
    } catch (e) { r.error = String(e && e.stack || e); }
    out.push(r);
  }
  return out;
}"""


def find_cases(priv: Path):
    cases = []
    for cf in sorted(priv.rglob("*_curvefit.wdf")):
        stem = cf.name[: -len("_curvefit.wdf")]
        point = next((cf.with_name(stem + ext) for ext in (".wdf", ".spc") if cf.with_name(stem + ext).exists()), None)
        if point:
            cases.append((stem, cf, point))
        else:
            print(f"  {cf.name}: no point spectrum {stem}.wdf/.spc beside it, skipped")
    return cases


def fmt(v, d=1):
    return "-" if v is None else f"{v:.{d}f}"


def summarise(r):
    """The numbers compared across runs, per case."""
    s = {}
    for id_ in ("D", "G"):
        a = r["bands"][id_]["app"]
        s[f"{id_}.x0"] = a and a["x0"]
        s[f"{id_}.w"] = a and a["w"]
        s[f"{id_}.significant"] = bool(a and a["significant"])
    ar = r.get("appRatio") or {}
    s["IDIG.height"] = (ar.get("height") or {}).get("value")
    s["IDIG.area"] = (ar.get("area") or {}).get("value")
    found = [any(abs(w["x0"] - p) <= TOL_DETECT_CM for p in r["detected"]) for w in r["wire"]]
    s["detected"] = sum(found)
    return s


def report(results):
    for r in results:
        print(f"\n== {r['name']}  (point spectrum: {r['point']})")
        if r.get("error"):
            print("   ERROR", r["error"].splitlines()[0])
            continue
        worst = max(w["relResidual"] for w in r["wire"])
        print(f"   WiRE components ({len(r['wire'])}, recovery residual <= {worst:.1e} of height):")
        for w in r["wire"]:
            hit = min(r["detected"], key=lambda p: abs(p - w["x0"]), default=None)
            det = f"detected {hit:.1f} ({hit - w['x0']:+.1f})" if hit is not None and abs(hit - w["x0"]) <= TOL_DETECT_CM else "not detected"
            print(f"     {w['x0']:7.1f}  FWHM {w['w']:6.1f}  h {w['h']:8.1f}  G% {w['g']:5.1f}{'  (recovered from envelope)' if w['recovered'] else ''}  -> {det}")
        for id_ in ("D", "G"):
            b = r["bands"][id_]
            w, a = b["wire"], b["app"]
            ws = f"WiRE {fmt(w and w['x0'])} / FWHM {fmt(w and w['w'])}" if w else "WiRE: no component in the window"
            as_ = f"app {fmt(a['x0'])} / FWHM {fmt(a['w'])}{'' if a['significant'] else ' (not significant)'}" if a else "app: not fitted"
            d = f"  d {a['x0'] - w['x0']:+.1f} / {a['w'] - w['w']:+.1f}" if a and w else ""
            print(f"   {id_}: {ws}   {as_}{d}")
        wd, wg = r["bands"]["D"]["wire"], r["bands"]["G"]["wire"]
        ar = r.get("appRatio") or {}
        hv, av = ar.get("height") or {}, ar.get("area") or {}
        lab_h = wd["h"] / wg["h"] if wd and wg else None
        lab_a = wd["area"] / wg["area"] if wd and wg else None
        pm = lambda q: (f"{q['value']:.2f}" + (f" +/- {q['se']:.2f}" if q.get("se") is not None else "") + f" ({q.get('source', 'fit')})") if q else "-"
        print(f"   I(D)/I(G) height: WiRE {fmt(lab_h, 2)}  app {pm(hv)}")
        print(f"   I(D)/I(G) area:   WiRE {fmt(lab_a, 2)}  app {pm(av)}")
        print(f"   app run {r['ms']:.0f} ms; fit quality " + ", ".join(f"{w['lo']:.0f}-{w['hi']:.0f}: {w['quality']:.2f}x noise" for w in r["windows"]))


def compare(results, baseline):
    flags = []
    old = {b["name"]: summarise(b) for b in baseline if not b.get("error")}
    for r in results:
        if r.get("error") or r["name"] not in old:
            continue
        a, b = summarise(r), old[r["name"]]
        for k in a:
            x, y = a[k], b.get(k)
            if isinstance(x, bool) or k == "detected":
                if x != y:
                    flags.append(f"{r['name']} {k}: {y} -> {x}")
            elif x is None or y is None:
                if x != y:
                    flags.append(f"{r['name']} {k}: {y} -> {x}")
            elif k.startswith("IDIG"):
                if abs(x - y) > TOL_RATIO_REL * abs(y):
                    flags.append(f"{r['name']} {k}: {y:.3f} -> {x:.3f}")
            elif abs(x - y) > TOL_POSITION_CM:
                flags.append(f"{r['name']} {k}: {y:.1f} -> {x:.1f}")
    return flags


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--private", default=str(ROOT / "test-data" / "private"))
    ap.add_argument("--save-baseline", action="store_true")
    ap.add_argument("--browser", default="chrome", help="Playwright channel: chrome or msedge")
    a = ap.parse_args()
    priv = Path(a.private).resolve()
    try:
        rel = priv.relative_to(ROOT).as_posix()
    except ValueError:
        print("the private folder must be inside the repository (it is served locally from there)")
        return 2
    cases = find_cases(priv)
    if not cases:
        print(f"no *_curvefit.wdf with a matching point spectrum under {priv}")
        return 1

    os.environ["SERVE_QUIET"] = "1"
    import serve
    from playwright.sync_api import sync_playwright
    srv, base = serve.start(0)
    try:
        with sync_playwright() as p:
            br = p.chromium.launch(channel=a.browser)
            pg = br.new_page()
            pg.goto(base + "tests/")
            url = lambda f: base + f.relative_to(ROOT).as_posix()
            results = pg.evaluate(JS, {"base": base, "cases": [
                {"name": stem, "point": pt.name, "curvefitUrl": url(cf), "pointUrl": url(pt)} for stem, cf, pt in cases]})
            br.close()
    finally:
        srv.shutdown()

    report(results)
    out = priv / "harness"
    out.mkdir(exist_ok=True)
    (out / "latest.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
    status = 0
    if a.save_baseline:
        (out / "baseline.json").write_text(json.dumps(results, indent=1), encoding="utf-8")
        print(f"\nbaseline saved: {out / 'baseline.json'}")
    elif (out / "baseline.json").exists():
        flags = compare(results, json.loads((out / "baseline.json").read_text(encoding="utf-8")))
        print("\nchanges from the baseline:" if flags else "\nno changes from the baseline beyond the tolerances")
        for f in flags:
            print("  -", f)
        status = 1 if flags else 0
    if any(r.get("error") for r in results):
        status = 1
    print(f"\nresults: {out / 'latest.json'} (private, gitignored: {rel}/harness/)")
    return status


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
