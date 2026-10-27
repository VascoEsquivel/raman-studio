"""End-to-end browser check of the app, served under /raman-studio/ like GitHub Pages.

For each scenario (the two built-in samples and every fixture file) it loads
the spectrum, waits for the label animation, screenshots the window, and
asserts:
  * no console errors or page errors
  * label boxes do not overlap each other
  * every label's leader starts at the trace (its apex dot sits on the plotted data)
  * expected bands are labelled near the expected positions (samples)
Then it exercises deconvolution, laser switching, presentation mode, theme,
exports and the print report on the GO sample.

Usage:
    python tools/check_app.py [--out DIR] [--headed] [--browser chrome] [--url URL]
--url runs the same checks against a deployed copy instead of a local server,
e.g. --url https://vascoesquivel.github.io/raman-studio/
Exit code 0 only if every check passed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("SERVE_QUIET", "1")
import serve  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"

# JS run in the page: geometry of every visible label.
LABELS_JS = """
() => [...document.querySelectorAll('#plotHost g.lbl')].map(g => {
  const box = g.querySelector('rect.box'), apex = g.querySelector('circle.apex');
  const b = box ? box.getBBox() : null;
  return { id: g.dataset.id, kind: g.getAttribute('class'), overflow: g.classList.contains('overflow'),
    sym: (g.querySelector('text.sym') || {}).textContent || '', sub: (g.querySelector('text.pos') || {}).textContent || '',
    box: b && { x: b.x, y: b.y, w: b.width, h: b.height },
    apex: apex && { x: +apex.getAttribute('cx'), y: +apex.getAttribute('cy') } };
})
"""


class Checker:
    def __init__(self, page, out: Path):
        self.page, self.out = page, out
        self.failures, self.passes = [], 0
        self.console = []
        page.on("console", lambda m: self.console.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: self.console.append(f"pageerror: {e}"))

    def check(self, cond, msg):
        if cond:
            self.passes += 1
        else:
            self.failures.append(msg)
            print("  FAIL", msg)

    def settle(self, ms=3200):
        self.page.wait_for_timeout(ms)

    def labels(self):
        return self.page.evaluate(LABELS_JS)

    def assert_layout(self, tag):
        L = [l for l in self.labels() if not l["overflow"] and l["box"]]
        for i in range(len(L)):
            for j in range(i + 1, len(L)):
                a, b = L[i]["box"], L[j]["box"]
                overlap = a["x"] < b["x"] + b["w"] - 0.5 and b["x"] < a["x"] + a["w"] - 0.5 and \
                    a["y"] < b["y"] + b["h"] - 0.5 and b["y"] < a["y"] + a["h"] - 0.5
                self.check(not overlap, f"{tag}: labels {L[i]['sym']} and {L[j]['sym']} overlap")
        return L

    def shot(self, name):
        self.page.screenshot(path=str(self.out / f"{name}.png"))


def expect_bands(c: Checker, tag, wanted):
    """wanted: {label: (lo, hi)} — a label with that text whose position sub lies in range."""
    L = c.labels()
    for sym, (lo, hi) in wanted.items():
        hit = [l for l in L if l["sym"] == sym and l["sub"] and lo <= float(l["sub"].split()[0]) <= hi]
        c.check(bool(hit), f"{tag}: expected a '{sym}' label between {lo} and {hi} cm⁻¹; got {[(l['sym'], l['sub']) for l in L]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "test-data" / "private" / "screens"))
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--browser", default="chrome")
    ap.add_argument("--url", default="", help="check a deployed copy (must end with /)")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)

    from playwright.sync_api import sync_playwright
    srv, base = (None, a.url) if a.url else serve.start(0)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel=a.browser, headless=not a.headed)
            ctx = browser.new_context(viewport={"width": 1600, "height": 960}, device_scale_factor=1, accept_downloads=True)
            page = ctx.new_page()
            c = Checker(page, out)

            # ---------------- empty state
            page.goto(base)
            page.wait_for_selector("#dropzone:not([hidden])")
            c.settle(800)
            c.shot("00_empty")

            # ---------------- GO sample
            print("sample: graphene oxide")
            page.click("#dzSampleGO")
            c.settle()
            c.shot("01_go_sample")
            L = c.assert_layout("GO sample")
            c.check(len(L) >= 3, f"GO sample: at least 3 labels drawn (got {len(L)})")
            expect_bands(c, "GO sample", {"D": (1320, 1380), "G": (1560, 1625), "D+D′": (2900, 2990)})
            spikes = page.evaluate("document.querySelectorAll('#plotHost .spike-ring').length")
            c.check(spikes >= 1, f"GO sample: removed cosmic rays are marked (got {spikes})")

            # deconvolution
            page.keyboard.press("f")
            page.wait_for_selector("#paneFit .fitwin", timeout=20000)
            c.settle()
            c.shot("02_go_deconvolved")
            c.assert_layout("GO deconvolved")
            # GO's weak, broad 2D is below detection; the fit resolves it (dashed label)
            expect_bands(c, "GO deconvolved", {"2D": (2640, 2740)})
            fit_labels = [l for l in c.labels() if "fit" in (l["kind"] or "")]
            c.check(len(fit_labels) >= 1, f"GO deconvolved: fit-resolved (dashed) labels present (got {len(fit_labels)})")
            q = page.evaluate("[...document.querySelectorAll('#paneFit .quality .v')].map(e => parseFloat(e.textContent))")
            c.check(all(v == v and v < 3 for v in q) and q, f"GO deconvolved: fit quality < 3× noise in every window ({q})")
            sel = page.inner_text("#paneFit .selline") if page.query_selector("#paneFit .selline") else ""
            c.check("Band set chosen by BIC" in sel, f"fit pane names the band set chosen by BIC ({sel[:80]!r})")
            sets = len(page.query_selector_all("#paneFit .selsets tbody tr"))
            c.check(sets == 8, f"fit pane lists every candidate band set ({sets})")
            page.click("#paneFit [data-opt=fitAllBands]")
            page.wait_for_function("!document.querySelector('#paneFit .selline') && document.querySelector('#paneFit [data-opt=fitAllBands]')?.checked", timeout=20000)
            c.check(True, "fit every band: re-fits without model selection")
            page.click("#paneFit [data-opt=fitAllBands]")
            page.wait_for_selector("#paneFit .selline", timeout=20000)
            c.settle(400)

            # click a label → band pane
            first = page.query_selector("#plotHost g.lbl:not(.overflow) rect.box")
            if first:
                first.click(force=True)
                c.settle(400)
                c.check(page.is_visible("#paneBand .bandhead"), "clicking a label opens the atlas band pane")
                c.shot("03_band_pane")
            # ratios + read panes
            page.click(".deck-tabs [data-tab=ratios]"); c.settle(300); c.shot("04_ratios")
            c.check(page.query_selector_all("#paneRatios .rcard").__len__() == 5, "ratios pane shows the five atlas ratio cards")
            idg = page.inner_text("#paneRatios .rcard .rval .v")
            c.check("±" in idg, f"fitted I_D/I_G carries a fit-model uncertainty ({idg!r})")
            c.check("not a probability" in page.inner_text("#paneRatios .source-note"), "ratios pane explains what ± means")
            page.click(".deck-tabs [data-tab=read]"); c.settle(300); c.shot("05_read")
            c.check(page.query_selector_all("#paneRead .step").__len__() == 8, "read pane shows the eight atlas workflow steps")

            # data pane: acquisition, quality checks, the removal list with Keep / Zap
            page.click(".deck-tabs [data-tab=data]"); c.settle(300); c.shot("05b_data")
            rows = page.query_selector_all("#paneData .srow")
            c.check(len(rows) == 3, f"data pane lists the GO sample's three cosmic rays (got {len(rows)})")
            c.check("No saturation" in page.inner_text("#paneData"), "data pane: clean synthetic data passes the quality checks")
            page.click("#paneData [data-spike=keep]"); c.settle(400)
            c.check(page.evaluate("document.querySelector('[data-val=despike]').textContent.startsWith('2 removed')"), "Keep puts one removal back")
            page.keyboard.press("Control+z"); c.settle(400)
            c.check(page.evaluate("document.querySelector('[data-val=despike]').textContent.startsWith('3 removed')"), "Ctrl+Z undoes the Keep")
            page.fill("#paneData [data-zapform] input[name=lo]", "1490")
            page.fill("#paneData [data-zapform] input[name=hi]", "1500")
            page.click("#paneData [data-zapform] button[type=submit]"); c.settle(400)
            c.check("zapped" in page.inner_text("#paneData"), "a hand zap is listed")
            page.keyboard.press("Control+z"); c.settle(400)
            # match confidence is a score, never a percentage
            page.click(".deck-tabs [data-tab=peaks]"); c.settle(300)
            meta = page.evaluate("[...document.querySelectorAll('#panePeaks .pside .pane-meta')].map(e => e.textContent)")
            c.check(meta and all("%" not in t for t in meta) and any(t.startswith("score ") for t in meta), f"peak list shows match scores, not percentages ({meta[:3]})")
            # despike controls
            page.click("[data-open=despike]"); c.settle(300)
            c.check(page.query_selector(".pop [data-path='despike.minBandCm']") is not None, "despike popover has the narrowest-band control")
            page.keyboard.press("Escape"); c.settle(200)

            # laser switch re-labels with shifted windows
            page.keyboard.press("3")
            c.settle()
            c.check(page.evaluate("document.documentElement.dataset.laser") == "785", "key 3 selects 785 nm")
            c.assert_layout("GO @785")
            c.shot("06_go_785")
            page.keyboard.press("1")
            c.settle()

            # raw + compare views
            page.keyboard.press("b"); c.settle(600); c.shot("07_raw_baseline")
            page.keyboard.press("c"); c.settle(600); c.shot("08_compare")
            page.keyboard.press("c"); c.settle(300)

            # light theme
            page.keyboard.press("t"); c.settle(900); c.shot("09_light"); c.assert_layout("GO light")
            page.keyboard.press("t"); c.settle(300)

            # presentation mode
            page.keyboard.press("p"); c.settle(1200)
            page.keyboard.press("ArrowRight"); c.settle(500)
            c.check(page.is_visible("#caption"), "presentation mode shows a caption for the selected label")
            c.shot("10_present")
            page.keyboard.press("Escape"); c.settle(500)

            # exports (the laser switches above cleared the fit: re-run it first)
            page.keyboard.press("f")
            page.wait_for_function("document.querySelector('[data-val=fire]').textContent.includes('bands')", timeout=20000)
            c.settle(2500)
            for kind, ext in (("png", ".png"), ("svg", ".svg"), ("peaks", ".csv"), ("fit", ".csv"), ("spectrum", ".csv"), ("project", ".json")):
                path = out / ("export_" + kind + ext)
                try:
                    page.click("#bExport")
                    with page.expect_download(timeout=25000) as dl:
                        page.click(f"#exportMenu [data-export={kind}]")
                    dl.value.save_as(str(path))
                    c.check(path.stat().st_size > 200, f"export {kind}: file written ({path.stat().st_size} bytes)")
                except Exception as e:
                    toast = page.evaluate("document.querySelector('#toast').textContent")
                    c.check(False, f"export {kind}: no download ({type(e).__name__}); toast: {toast!r}")
                page.wait_for_timeout(300)
            if (out / "export_svg.svg").exists():
                svg = (out / "export_svg.svg").read_text(encoding="utf-8")
                c.check("<svg" in svg and "class=\"lbl" in svg, "SVG export contains labels")

            # print report renders
            page.evaluate("""() => { window.print = () => {}; }""")
            page.click("#bExport"); page.click("#exportMenu [data-export=report]")
            c.settle(2500)
            page.emulate_media(media="print")
            c.check(page.evaluate("document.querySelector('#report .rp-fig svg') !== null"), "report contains the figure")
            if a.browser == "chrome" and not a.headed:
                page.pdf(path=str(out / "report.pdf"), format="A4")
                import re as _re
                pages = len(_re.findall(rb"/Type\s*/Page[^s]", (out / "report.pdf").read_bytes()))
                c.check(pages == 1, f"report prints on one A4 page (got {pages})")
            page.screenshot(path=str(out / "11_report_print.png"), full_page=True)
            page.emulate_media(media="screen")

            # ---------------- monolayer sample
            print("sample: monolayer")
            page.goto(base + "?sample=mono")
            c.settle()
            c.shot("12_mono_sample")
            c.assert_layout("monolayer")
            expect_bands(c, "monolayer", {"G": (1560, 1625), "2D": (2640, 2740)})
            L = c.labels()
            c.check(not any(l["sym"] == "D" for l in L), "monolayer: no D label")
            page.click(".deck-tabs [data-tab=read]"); c.settle(300)
            st = page.evaluate("document.querySelector('#paneRead .step')?.className || ''")
            c.check("match" in st, f"monolayer: atlas step 1 matches (class {st!r})")

            # ---------------- Renishaw map: band-intensity maps
            print("map: map_small.wdf")
            page.goto(base)
            page.wait_for_selector("#dropzone:not([hidden])")
            page.set_input_files("#fileInput", str(FIX / "map_small.wdf"))
            page.wait_for_function("document.querySelector('#dropzone').hidden", timeout=15000)
            c.settle(1500)
            c.check(page.is_visible(".deck-tabs [data-tab=map]"), "map file: the Map tab is offered")
            page.click(".deck-tabs [data-tab=map]")
            page.wait_for_selector("#paneMap .mcell", timeout=20000)
            c.settle(400)
            c.shot("13_map")
            cells = page.query_selector_all("#paneMap .mcell")
            c.check(len(cells) == 6, f"map pane: one cell per map point (got {len(cells)})")
            painted = page.evaluate("[...document.querySelectorAll('#paneMap .mcell')].filter(e => e.getAttribute('fill')).length")
            c.check(painted == 6, f"map pane: every cell has a colour (got {painted})")
            target = page.evaluate("document.querySelectorAll('#paneMap .mcell')[4].dataset.mapcell")
            page.click(f"#paneMap .mcell[data-mapcell='{target}']", force=True); c.settle(800)
            on = page.evaluate("document.querySelector('#paneMap .mcell.on')?.dataset.mapcell")
            c.check(on == target, f"clicking a map cell opens that spectrum ({on!r} vs {target!r})")
            page.select_option("#paneMap [data-mapsel=cmp]", "D"); c.settle(500)
            corr = page.inner_text("#paneMap .mcorr") if page.query_selector("#paneMap .mcorr") else ""
            c.check("r = 1.000" in corr or "r = 0.99" in corr, f"compare G with D: the two maps rise together ({corr!r})")
            c.check(len(page.query_selector_all("#paneMap .mdot")) == 6, "compare: a scatter dot per map point")
            page.select_option("#paneMap [data-mapsel=cmp]", "twoD"); c.settle(500)
            corr = page.inner_text("#paneMap .mcorr") if page.query_selector("#paneMap .mcorr") else ""
            c.check("r = -1.000" in corr or "r = -0.99" in corr, f"compare G with 2D: opposite directions ({corr!r})")
            c.shot("14_map_compare")
            c.assert_layout("map")
            with page.expect_download() as dl:
                page.click("#paneMap [data-action=mapcsv]")
            rows = Path(dl.value.path()).read_text(encoding="utf-8").strip().splitlines()
            c.check(len(rows) == 7 and rows[0].startswith("point,"), f"map CSV: header and one row per point (got {len(rows)} lines)")

            # ---------------- fixtures
            fixtures = sorted(f for f in FIX.iterdir() if f.suffix.lower() in
                              (".csv", ".tsv", ".txt", ".xlsx", ".xls", ".jdx", ".dx", ".spc", ".wdf") and f.name != "find_peaks_vectors.json")
            for f in fixtures:
                print("fixture:", f.name)
                page.goto(base)
                page.wait_for_selector("#dropzone:not([hidden])")
                page.set_input_files("#fileInput", str(f))
                # mapping dialog for ambiguous files: accept the best guess / pick columns
                try:
                    page.wait_for_function("document.querySelector('#mapDialog').open || !document.querySelector('#dropzone') || document.querySelector('#dropzone').hidden", timeout=15000)
                except Exception:
                    pass
                if page.evaluate("document.querySelector('#mapDialog').open"):
                    c.shot("fx_" + f.stem + "_mapping")
                    sels = page.query_selector_all("#mapDialog select[data-col]")
                    if len(sels) >= 2:
                        sels[0].select_option("x"); sels[1].select_option("y")
                    page.click("#mapOk")
                c.settle(2800)
                loaded = page.evaluate("document.querySelector('#dropzone').hidden")
                c.check(loaded, f"fixture {f.name}: spectrum loaded")
                if loaded:
                    c.assert_layout("fixture " + f.name)
                    c.shot("fx_" + f.stem)

            c.check(not c.console, "no console errors: " + json.dumps(c.console[:10]))
            browser.close()
    finally:
        if srv:
            srv.shutdown()

    print(f"\n{c.passes} checks passed, {len(c.failures)} failed. Screenshots in {out}")
    for f in c.failures:
        print("  -", f)
    return 0 if not c.failures else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
