"""Development-time ingestion of approved private research files.

Copies files that were fetched through the Google Drive connector into the
gitignored test-data/private/ folder, byte for byte, and records provenance.
Never part of the deployed app; never run in CI.

The connector returns a download either inline, as JSON
{"content": <base64>, "id", "mimeType", "title"}, or, when that is too large to
show, as a pointer "Output has been saved to <file>" whose file holds the same
JSON. Both forms are recorded verbatim in the Claude Code session transcript,
so this script decodes the bytes from there instead of anyone retyping base64.

Usage:
    python tools/ingest_private.py REQUESTS.json --transcript SESSION.jsonl

REQUESTS.json (keep it inside test-data/private/) lists the approved files:
    [{"fileId": "...", "title": "UL_X.spc", "size": 6460, "modifiedTime": "..."}]
`size` and `modifiedTime` come from the connector's get_file_metadata. For each
request the newest download of that fileId in the transcript is decoded; the
file is written only if its byte count equals `size` and the connector's id and
title match the request. A MANIFEST.json beside the files records fileId, title,
modifiedTime, size, sha256 and how the bytes were obtained. Exits non-zero if
any request fails.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "test-data" / "private"
SAVED = re.compile(r"Output has been saved to (\S+?\.txt)")


def tool_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(x.get("text", "") for x in content if isinstance(x, dict))
    return ""


def downloads(transcript: Path) -> dict[str, tuple[dict, str]]:
    """fileId -> (connector JSON, method) for the newest download of each file."""
    uses: dict[str, str] = {}
    found: dict[str, tuple[dict, str]] = {}
    with transcript.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            content = (rec.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for c in content:
                if c.get("type") == "tool_use" and str(c.get("name", "")).endswith("download_file_content"):
                    uses[c["id"]] = (c.get("input") or {}).get("fileId", "")
                elif c.get("type") == "tool_result" and c.get("tool_use_id") in uses:
                    text = tool_text(c.get("content"))
                    m = SAVED.search(text)
                    try:
                        if m:
                            data = json.loads(Path(m.group(1)).read_text(encoding="utf-8"))
                            method = f"connector download, saved result {Path(m.group(1)).name}"
                        else:
                            data = json.loads(text)
                            method = "connector download, inline result"
                    except (OSError, json.JSONDecodeError):
                        continue
                    found[uses[c["tool_use_id"]]] = (data, method)
    return found


def is_ignored(path: Path) -> bool:
    r = subprocess.run(["git", "check-ignore", "-q", str(path)], cwd=ROOT)
    return r.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("requests", type=Path)
    ap.add_argument("--transcript", type=Path, required=True)
    ap.add_argument("--dest", type=Path, default=PRIVATE / "drive")
    a = ap.parse_args()

    dest = a.dest.resolve()
    if PRIVATE.resolve() not in (dest, *dest.parents):
        print(f"refusing: {dest} is outside {PRIVATE}", file=sys.stderr)
        return 2
    dest.mkdir(parents=True, exist_ok=True)
    if not is_ignored(dest / "probe.bin"):
        print(f"refusing: {dest} is not gitignored", file=sys.stderr)
        return 2

    requests = json.loads(a.requests.read_text(encoding="utf-8"))
    got = downloads(a.transcript)
    manifest_path = dest / "MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    failed = 0
    for req in requests:
        fid, title, size = req["fileId"], req["title"], int(req["size"])
        if Path(title).name != title or title.startswith("."):
            print(f"FAIL {title}: not a plain file name"); failed += 1; continue
        if fid not in got:
            print(f"FAIL {title}: no download of {fid} in the transcript"); failed += 1; continue
        data, method = got[fid]
        problems = []
        if data.get("id") not in (None, fid):
            problems.append(f"connector id {data.get('id')}")
        if data.get("title") not in (None, title):
            problems.append(f"connector title {data.get('title')!r}")
        try:
            raw = base64.b64decode(data.get("content", ""), validate=True)
        except ValueError as e:
            problems.append(f"bad base64 ({e})")
            raw = b""
        if len(raw) != size:
            problems.append(f"{len(raw)} bytes, Drive says {size}")
        if problems:
            print(f"FAIL {title}: " + "; ".join(problems)); failed += 1; continue
        out = dest / title
        sha = hashlib.sha256(raw).hexdigest()
        previous = out.read_bytes() if out.exists() else None
        out.write_bytes(raw)
        note = "" if previous is None else (" (identical to the existing copy)" if previous == raw
                                           else f" (REPLACED a different existing copy, sha256 {hashlib.sha256(previous).hexdigest()[:12]}...)")
        manifest[title] = {"fileId": fid, "title": title, "modifiedTime": req.get("modifiedTime"),
                           "size": size, "sha256": sha, "method": method}
        print(f"ok   {title}  {size} B  sha256 {sha[:16]}...{note}")
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(requests) - failed}/{len(requests)} written; manifest {manifest_path.relative_to(ROOT)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
