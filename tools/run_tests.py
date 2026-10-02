"""Run the browser unit-test suite headlessly and report results.

Serves the repo under /raman-studio/ (GitHub Pages layout), opens
tests/index.html in headless Chrome via Playwright, waits for the suite to
finish and prints every result. Exit code 0 only if every test passed and the
page logged no console errors.

Usage:
    python tools/run_tests.py [--only io,process] [--headed] [--browser chrome|msedge]

Needs `pip install playwright`; it drives your installed Chrome/Edge, so no
browser download is required.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("SERVE_QUIET", "1")
import serve  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated suite filename prefixes")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--browser", default="chrome", help="Playwright channel: chrome or msedge")
    ap.add_argument("--timeout", type=int, default=180, help="seconds")
    ap.add_argument("--quiet", action="store_true", help="only print failures and the summary")
    a = ap.parse_args()

    from playwright.sync_api import sync_playwright

    srv, base = serve.start(0)
    url = base + "tests/" + (f"?only={a.only}" if a.only else "")
    console_errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel=a.browser, headless=not a.headed)
            page = browser.new_page()
            page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
            page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
            page.goto(url)
            page.wait_for_function("window.__TEST_RESULTS__ !== undefined", timeout=a.timeout * 1000)
            res = page.evaluate("window.__TEST_RESULTS__")
            browser.close()
    finally:
        srv.shutdown()

    out = sys.stdout
    for r in res["results"]:
        if r["ok"] and a.quiet:
            continue
        mark = "PASS" if r["ok"] else "FAIL"
        out.write(f"{mark}  {r['file']} :: {r['name']}  ({r['ms']:.0f} ms)\n")
        if not r["ok"]:
            out.write("      " + str(r["error"]).replace("\n", "\n      ") + "\n")
    if console_errors:
        out.write("\nCONSOLE ERRORS:\n" + "\n".join("  " + e for e in console_errors) + "\n")
    out.write(f"\n{res['passed']}/{res['total']} passed, {res['failed']} failed, "
              f"{len(console_errors)} console errors\n")
    return 0 if res["failed"] == 0 and not console_errors else 1


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
