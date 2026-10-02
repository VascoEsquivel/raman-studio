"""Verify data/libraries/graphene-go.json against the atlas source, field by field.

Usage:
    python tools/verify_atlas.py [path/to/atlas/index.html]

With no path, the atlas is downloaded from GitHub at the commit recorded in the
library's source.commit. Exits non-zero on any difference. Checks:
  * every atlas band field (all PEAKS keys) is present and identical
  * RATIOS, CHEAT (workflow) and REFS are identical
  * the page notes (banner, footer, …) are identical
  * every derived match.range matches the numbers in posText
  * no atlas band is missing and no extra band was added
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atlas_parse import parse_constants, parse_notes  # noqa: E402
from extract_atlas import parse_range  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "data" / "libraries" / "graphene-go.json"
DERIVED_BAND_KEYS = {"match", "fit"}


def main() -> int:
    lib = json.loads(LIB.read_text(encoding="utf-8"))
    if len(sys.argv) > 1:
        html = Path(sys.argv[1]).read_text(encoding="utf-8")
        where = sys.argv[1]
    else:
        commit = lib["source"]["commit"]
        url = f"https://raw.githubusercontent.com/VascoEsquivel/raman-graphene-atlas/{commit}/index.html"
        html = urllib.request.urlopen(url, timeout=30).read().decode("utf-8")
        where = url
    c = parse_constants(html)
    notes = parse_notes(html)
    errors = []

    atlas_ids = [p["id"] for p in c["PEAKS"]]
    lib_ids = [b["id"] for b in lib["bands"]]
    if atlas_ids != lib_ids:
        errors.append(f"band ids/order differ: atlas {atlas_ids} vs library {lib_ids}")

    by_id = {b["id"]: b for b in lib["bands"]}
    for p in c["PEAKS"]:
        b = by_id.get(p["id"])
        if not b:
            continue
        for k, v in p.items():
            if k not in b:
                errors.append(f"{p['id']}: missing atlas field {k!r}")
            elif b[k] != v:
                errors.append(f"{p['id']}.{k}: library {b[k]!r} != atlas {v!r}")
        for k in b:
            if k not in p and k not in DERIVED_BAND_KEYS:
                errors.append(f"{p['id']}: unexpected non-atlas field {k!r}")
        if b["match"]["range"] != parse_range(p["posText"]):
            errors.append(f"{p['id']}: match.range {b['match']['range']} does not match posText {p['posText']!r}")
        if b["match"]["center"] != p["posSort"]:
            errors.append(f"{p['id']}: match.center != posSort")

    for lib_key, const in (("ratios", "RATIOS"), ("workflow", "CHEAT"), ("references", "REFS")):
        if lib[lib_key] != c[const]:
            errors.append(f"{lib_key} differs from atlas {const}")
    if lib["atlasNotes"] != notes:
        errors.append("atlasNotes differ from the atlas page text")

    for e in errors:
        print("FAIL", e)
    print(f"{'FAILED' if errors else 'OK'}: {len(lib['bands'])} bands, {len(lib['ratios'])} ratio cards, "
          f"{len(lib['workflow'])} workflow steps, {len(lib['references'])} references checked against {where}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
