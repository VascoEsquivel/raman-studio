"""Build data/libraries/graphene-go.json from the Raman graphene atlas.

Usage:
    python tools/extract_atlas.py path/to/raman-graphene-atlas/index.html [--commit SHA]

Every atlas field is copied verbatim: same keys, same strings (HTML fragments
included), same numbers. The app needs a few machine-readable values the atlas
only states in prose (numeric ranges, dispersion rates); those are derived here
into separate `match` / `fit` blocks, and each derived value records the exact
atlas text it came from. App settings that are NOT atlas data (tolerances, fit
bounds, the assumed reference laser) live in clearly labelled top-level blocks.

tools/verify_atlas.py re-checks the output against the atlas source.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atlas_parse import parse_constants, parse_notes  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "libraries" / "graphene-go.json"
FWHM_PER_SIGMA = 2.3548200450309493  # 2·sqrt(2·ln 2)

# Bands whose dispersion the atlas states numerically: id -> (field, regex).
# The regex must match the atlas text verbatim; the number is read from it.
STATED_DISPERSION = {
    "D": ("process", r"Strongly dispersive \(~(\d+) cm⁻¹ per eV of laser energy\)"),
    "twoD": ("process", r"Highly dispersive \(~(\d+) cm⁻¹/eV\)"),
}
# Double-resonance / combination bands for which the atlas gives no rate.
# Per the atlas author's decision (2026-10-02): no shift, wider match window.
UNSTATED_DISPERSION = {
    "Dp": "Intravalley double resonance (atlas D′ process); the atlas gives no dispersion rate.",
    "DDpp": "Atlas: \"Weak and only mildly dispersive\" — no numeric rate given.",
    "DDp": "D+D′ combination (atlas); the atlas gives no dispersion rate.",
    "twoDp": "Overtone of D′ (atlas); the atlas gives no dispersion rate.",
}


def parse_range(pos_text: str) -> list:
    m = re.fullmatch(r"~(\d+)(?:–(\d+))? cm⁻¹", pos_text)
    if not m:
        raise ValueError(f"unrecognised posText {pos_text!r}")
    lo = int(m.group(1))
    hi = int(m.group(2)) if m.group(2) else lo
    return [lo, hi]


def derive_band(p: dict) -> dict:
    band = dict(p)  # verbatim atlas fields, atlas key order
    match = {
        "range": parse_range(p["posText"]),
        "rangeSource": "atlas posText: " + p["posText"],
        "center": p["posSort"],
        "centerSource": "atlas posSort",
    }
    if p["id"] in STATED_DISPERSION:
        field, rx = STATED_DISPERSION[p["id"]]
        m = re.search(rx, p[field])
        if not m:
            raise ValueError(f"dispersion text for {p['id']} not found in atlas field {field}")
        match["dispersion"] = {"cmPerEV": int(m.group(1)), "stated": True,
                               "source": f"atlas {p['id']}.{field}: \"{m.group(0)}\""}
    elif p["id"] in UNSTATED_DISPERSION:
        match["dispersion"] = {"cmPerEV": None, "stated": False, "widenWindow": True,
                               "source": UNSTATED_DISPERSION[p["id"]],
                               "todo": "Rate not in atlas. Window is widened instead of shifted "
                                       "(see matchDefaults.unknownDispersionAllowanceCmPerEV)."}
    else:
        match["dispersion"] = {"cmPerEV": 0, "stated": False,
                               "source": "not a double-resonance band in the atlas; treated as non-dispersive"}
    band["match"] = match
    band["fit"] = {
        "fwhmSeed": round(p["plot"]["sig"] * FWHM_PER_SIGMA, 2),
        "source": "atlas plot.sig × 2.3548 — the atlas's schematic curve width, used only as a "
                  "starting value for deconvolution (the atlas gives no measured FWHM)",
    }
    return band


def build(html: str, commit: str) -> dict:
    c = parse_constants(html)
    notes = parse_notes(html)
    banner = notes["banner"]
    ch_quote = "the ~2850–2920 cm⁻¹ region is sp³ C–H stretching, not a lattice phonon band"
    if ch_quote not in banner:
        raise ValueError("sp³ C–H banner text not found verbatim")
    ids = [p["id"] for p in c["PEAKS"]]
    if len(ids) != 9:
        raise ValueError(f"expected 9 atlas bands, found {len(ids)}")

    return {
        "schema": "raman-studio/band-library@1",
        "id": "graphene-go",
        "name": "Graphene & graphene oxide — nine-band model",
        "material": "Graphene / graphene oxide (GO, rGO)",
        "source": {
            "title": notes["title"],
            "url": "https://vascoesquivel.github.io/raman-graphene-atlas/",
            "repo": "https://github.com/VascoEsquivel/raman-graphene-atlas",
            "commit": commit,
            "file": "index.html",
            "extractedWith": "tools/extract_atlas.py",
            "note": "Atlas fields are verbatim copies of the PEAKS, RATIOS, CHEAT and REFS constants. "
                    "Blocks named match / fit / matchDefaults / fitDefaults / referenceExcitation / "
                    "ratioMap are app data derived from or added to the atlas, and say so.",
        },
        "referenceExcitation": {
            "nm": 532,
            "status": "assumed",
            "note": "The atlas does not state an excitation wavelength for its positions. 532 nm was "
                    "chosen by the atlas author (2026-10-02) as the reference for dispersion-shifting "
                    "match windows. App setting, not atlas data.",
        },
        "matchDefaults": {
            "toleranceCm": 25,
            "unknownDispersionAllowanceCmPerEV": 50,
            "note": "App settings, not atlas data. A peak matches a band if it lies within the band's "
                    "atlas range ± toleranceCm (after dispersion shift). Bands with "
                    "dispersion.widenWindow get an extra ± allowance × |ΔE| because the atlas gives "
                    "no rate for them; 50 cm⁻¹/eV is the atlas D-band rate, used as a generous envelope.",
        },
        "fitDefaults": {
            "fwhmMin": 6,
            "fwhmMax": 300,
            "gaussianPercentSeed": 50,
            "windowPadCm": 100,
            "note": "App settings, not atlas data: bounds for the deconvolution fitter. Centres are "
                    "bounded to each band's match window so bands cannot swap places.",
        },
        "atlasNotes": notes,
        "bands": [derive_band(p) for p in c["PEAKS"]],
        "regions": [{
            "id": "CH-stretch",
            "label": "sp³ C–H",
            "name": "sp³ C–H stretching region",
            "range": [2850, 2920],
            "kind": "non-lattice",
            "text": ch_quote,
            "source": "atlas header banner (also the G* correction and workflow step 8)",
        }],
        "ratios": c["RATIOS"],
        "ratioMap": [
            {"ratioIndex": 0, "num": "D", "den": "G", "measures": ["height", "area"],
             "extras": ["crystalliteSize", "gWidth"]},
            {"ratioIndex": 1, "num": "D", "den": "Dp", "measures": ["height", "area"],
             "classify": {"values": [13, 7, 3.5],
                          "labels": ["sp³ defects", "vacancy-type defects", "boundary / edge defects"],
                          "source": "atlas ratio card I_D / I_D′ (Eckmann 2012)"}},
            {"ratioIndex": 2, "num": "twoD", "den": "G", "measures": ["height", "area"],
             "extras": ["twoDWidth"]},
            {"ratioIndex": 3, "num": "Dp", "den": "G", "measures": ["area"]},
            {"ratioIndex": 4, "num": "twoD", "den": "DDp", "measures": ["height", "area"]},
        ],
        "workflow": c["CHEAT"],
        "references": c["REFS"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("atlas", help="path to the atlas index.html")
    ap.add_argument("--commit", default="unknown", help="atlas git commit the file came from")
    ap.add_argument("--out", default=str(OUT))
    a = ap.parse_args()
    html = Path(a.atlas).read_text(encoding="utf-8")
    lib = build(html, a.commit)
    Path(a.out).write_text(json.dumps(lib, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {a.out}: {len(lib['bands'])} bands, {len(lib['ratios'])} ratio cards, "
          f"{len(lib['workflow'])} workflow steps, {len(lib['references'])} references")


if __name__ == "__main__":
    main()
