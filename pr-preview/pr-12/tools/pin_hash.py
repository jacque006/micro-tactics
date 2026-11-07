#!/usr/bin/env python3
"""Seal or verify CSP script hashes for index.html.

Usage:
  python3 tools/pin_hash.py --seal index.html    # rewrite the CSP meta with current script hashes
  python3 tools/pin_hash.py --verify index.html  # exit 0 iff sealed hashes match current scripts
"""

import argparse
import base64
import hashlib
import re
import sys

SCRIPT_RE = re.compile(
    r"<script(?![^>]*\bsrc\s*=)[^>]*>(.*?)</script>", re.DOTALL | re.IGNORECASE
)
META_RE = re.compile(
    r'<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*(/?)>',
    re.IGNORECASE,
)


def script_hashes(html):
    """One sha256 hash per inline <script> block, in document order."""
    hashes = []
    for m in SCRIPT_RE.finditer(html):
        digest = hashlib.sha256(m.group(1).encode("utf-8")).digest()
        hashes.append("'sha256-" + base64.b64encode(digest).decode("ascii") + "'")
    return hashes


def build_csp(script_hashes):
    return (
        "default-src 'none'; "
        "img-src 'self' data:; "
        "style-src 'unsafe-inline'; "
        "script-src " + " ".join(script_hashes)
    )


def seal(html):
    if not script_hashes(html):
        sys.exit("ERROR: no inline scripts found — nothing to seal")
    csp = build_csp(script_hashes(html))
    meta_tag = '<meta http-equiv="Content-Security-Policy" content="%s">' % csp
    if META_RE.search(html):
        return META_RE.sub(lambda m: meta_tag + m.group(2) and meta_tag or meta_tag, html, count=1)
    if "<head>" not in html:
        sys.exit("ERROR: no <head> and no CSP meta tag found")
    return html.replace("<head>", "<head>\n    " + meta_tag, 1)


def verify(html):
    m = META_RE.search(html)
    if not m:
        sys.exit("FAIL: no CSP meta tag in index.html")
    sealed = re.findall(r"'sha256-[A-Za-z0-9+/=]+'", m.group(1))
    computed = script_hashes(html)
    if not computed:
        sys.exit("FAIL: no inline scripts found")
    if sealed != computed:
        print("FAIL: sealed hashes do not match current inline scripts.")
        print("  sealed:  ", sealed)
        print("  computed:", computed)
        print("Run: python3 tools/pin_hash.py --seal index.html")
        sys.exit(1)
    print("OK: %d script hash(es) verified." % len(computed))


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--seal", action="store_true")
    g.add_argument("--verify", action="store_true")
    ap.add_argument("path", nargs="?", default="index.html")
    args = ap.parse_args()

    with open(args.path, "r", encoding="utf-8") as f:
        html = f.read()

    if args.seal:
        with open(args.path, "w", encoding="utf-8") as f:
            f.write(seal(html))
        print("Sealed: CSP meta rewritten with %d script hash(es)." % len(script_hashes(html)))
    else:
        verify(html)


if __name__ == "__main__":
    main()
