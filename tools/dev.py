#!/usr/bin/env python3
"""Rebuild on save and serve the result, inside the same sandbox players get.

    python3 tools/dev.py [--port 8000]

Watches game.html, shell/ and tools/api-allowlist.json, rebuilds dist/index.html when one
changes, and serves it at http://127.0.0.1:8000/. Reload the browser after a rebuild. A failed
build prints why and the last good build keeps serving. Needs Node and `npm ci` for the lint.
"""

import argparse
import functools
import http.server
import pathlib
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build as builder  # noqa: E402

DIST = ROOT / "dist"


def watched():
    return [ROOT / "game.html", ROOT / "tools" / "api-allowlist.json", *sorted((ROOT / "shell").iterdir())]


def rebuild():
    try:
        page = builder.build(ROOT / "game.html")
    except builder.BuildError as e:
        print(f"\n[{time.strftime('%H:%M:%S')}] build failed: {e}", flush=True)
        return
    DIST.mkdir(exist_ok=True)
    (DIST / "index.html").write_text(page, encoding="utf-8")
    print(f"[{time.strftime('%H:%M:%S')}] rebuilt dist/index.html", flush=True)


def watch():
    seen = {}
    while True:
        stamps = {p: p.stat().st_mtime for p in watched() if p.exists()}
        if stamps != seen:
            seen = stamps
            rebuild()
        time.sleep(0.3)


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    DIST.mkdir(exist_ok=True)
    threading.Thread(target=watch, daemon=True).start()
    handler = functools.partial(NoCache, directory=str(DIST))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    print(f"serving http://127.0.0.1:{args.port}/ (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
