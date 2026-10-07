"""Static dev server that mimics GitHub Pages' project-site layout.

The repo is served under a subpath (default /raman-studio/), exactly as
https://<user>.github.io/raman-studio/ serves it, so any absolute-path bug
shows up locally. Everything outside the subpath is a 404.

Usage:
    python tools/serve.py [--port 8765] [--base /raman-studio/]
"""
from __future__ import annotations

import argparse
import http.server
import os
import posixpath
import socketserver
import threading
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Windows' registry can map .js to text/plain, which breaks ES modules. Pin the types.
TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg", ".webp": "image/webp",
    ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
    ".tsv": "text/tab-separated-values; charset=utf-8", ".jdx": "text/plain; charset=utf-8",
    ".dx": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel", ".spc": "application/octet-stream",
    ".woff2": "font/woff2",
}


def make_handler(base: str):
    class Handler(http.server.SimpleHTTPRequestHandler):
        # Keep-alive: a page load fetches ~30 modules; one socket per request
        # (HTTP/1.0) exhausts Windows' socket buffers over many reloads.
        protocol_version = "HTTP/1.1"

        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT), **kw)

        def translate_path(self, path):
            path = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
            if path == base.rstrip("/"):
                return ""  # handled by send_head redirect
            if not path.startswith(base):
                return ""
            rel = posixpath.normpath(path[len(base):]).lstrip("/")
            if rel.startswith(".."):
                return ""
            full = ROOT / rel
            # GitHub Pages never serves dotfiles from the repo's .git; keep parity-ish.
            if any(part.startswith(".git") for part in Path(rel).parts):
                return ""
            return str(full)

        def send_head(self):
            p = urllib.parse.unquote(self.path.split("?", 1)[0])
            if p == base.rstrip("/"):
                self.send_response(301)
                self.send_header("Location", base)
                self.end_headers()
                return None
            if not self.translate_path(self.path):
                self.send_error(404, "Not under " + base)
                return None
            return super().send_head()

        def guess_type(self, path):
            return TYPES.get(os.path.splitext(path)[1].lower(), "application/octet-stream")

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, fmt, *args):
            if os.environ.get("SERVE_QUIET"):
                return
            super().log_message(fmt, *args)

    return Handler


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(port: int = 0, base: str = "/raman-studio/"):
    """Start in a background thread; returns (server, url)."""
    srv = ThreadingServer(("127.0.0.1", port), make_handler(base))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}{base}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--base", default="/raman-studio/")
    a = ap.parse_args()
    srv = ThreadingServer(("127.0.0.1", a.port), make_handler(a.base))
    print(f"serving {ROOT} at http://127.0.0.1:{a.port}{a.base}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
