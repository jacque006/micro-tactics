#!/usr/bin/env python3
"""Build the playable page from game.html.

    python3 tools/build.py                  # game.html -> dist/index.html
    python3 tools/build.py --game game.html --out site/pr/12/index.html \\
        --namespace pr-12 --banner "Preview of PR #12 at abc1234" \\
        --download-name micro-tactics-pr-12-abc1234.html

The output is one self-contained HTML file that works hosted anywhere or opened from disk:
the shell (shell/shell.html and shell/shell.js) with the game inside a sandboxed iframe, and a
Content-Security-Policy whose script hashes are computed here. Nothing needs sealing by hand.

Standard library only. The JavaScript lint needs Node and `npm ci` (for acorn).
"""

import argparse
import base64
import hashlib
import html
import html.parser
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SHELL_DIR = ROOT / "shell"
MAX_BYTES = 2 * 1024 * 1024

# Every directive is fixed here and checked by tests/security/build.spec.js.
# Weakening one is an owner-reviewed change.
POLICY = [
    "default-src 'none'",
    "script-src {scripts}",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    "webrtc 'block'",
]

# What game.html may contain: tag -> allowed attributes.
ALLOWED_TAGS = {
    "html": {"lang"},
    "head": set(),
    "meta": {"charset", "name", "content"},
    "title": set(),
    "style": set(),
    "body": set(),
    "canvas": {"id", "width", "height"},
    "script": set(),
}

NAMESPACE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
DOWNLOAD_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.html$")


class BuildError(Exception):
    pass


class GameChecker(html.parser.HTMLParser):
    """Checks game.html against ALLOWED_TAGS and collects problems."""

    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.problems = []
        self.counts = {}
        self.in_style = False
        self.style_text = []

    def handle_starttag(self, tag, attrs):
        line = self.getpos()[0]
        self.counts[tag] = self.counts.get(tag, 0) + 1
        if tag not in ALLOWED_TAGS:
            self.problems.append(f"line {line}: <{tag}> is not allowed in game.html")
            return
        for name, value in attrs:
            if name not in ALLOWED_TAGS[tag]:
                self.problems.append(f"line {line}: attribute {name!r} is not allowed on <{tag}>")
        if tag == "meta":
            names = {n for n, _ in attrs}
            ok = names == {"charset"} or (names == {"name", "content"} and dict(attrs).get("name") == "viewport")
            if not ok:
                self.problems.append(f"line {line}: only <meta charset> and <meta name=viewport> are allowed")
        self.in_style = tag == "style"

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "style":
            self.in_style = False

    def handle_data(self, data):
        if self.in_style:
            self.style_text.append(data)


def check_game(source):
    checker = GameChecker()
    checker.feed(source)
    checker.close()
    problems = list(checker.problems)
    for tag in ("html", "head", "body", "script"):
        if checker.counts.get(tag, 0) != 1:
            problems.append(f"game.html must have exactly one <{tag}> (found {checker.counts.get(tag, 0)})")
    css = "".join(checker.style_text)
    if "@import" in css or re.search(r"url\(\s*['\"]?(?!data:)", css):
        problems.append("CSS may only use data: URLs and no @import")
    if problems:
        raise BuildError("game.html failed the structure check:\n  " + "\n  ".join(problems))
    match = re.search(r"<script>(.*?)</script>", source, re.DOTALL)
    if not match:
        raise BuildError("game.html: the <script> must have no attributes")
    return match.group(1)


def lint_script(script):
    try:
        result = subprocess.run(
            ["node", str(ROOT / "tools" / "lint_game.mjs"), "-"],
            input=script, capture_output=True, text=True, cwd=ROOT,
        )
    except FileNotFoundError:
        raise BuildError("Node is needed for the game lint (tools/lint_game.mjs). Install Node, then `npm ci`.")
    if result.returncode != 0:
        raise BuildError((result.stderr or result.stdout).strip())


def sha256_source(text):
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


def read_text(path):
    # Browsers turn CRLF into LF before hashing an inline script, so do the same here.
    return pathlib.Path(path).read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n")


def build(game_path, namespace="micro-tactics", title="Micro Tactics", banner=None,
          download_name=None, skip_js_lint=False):
    if not NAMESPACE_RE.match(namespace):
        raise BuildError(f"namespace {namespace!r} must match {NAMESPACE_RE.pattern}")
    if download_name is not None and not DOWNLOAD_RE.match(download_name):
        raise BuildError(f"download name {download_name!r} must match {DOWNLOAD_RE.pattern}")

    game = read_text(game_path)
    game_script = check_game(game)
    if not skip_js_lint:
        lint_script(game_script)

    shell = read_text(SHELL_DIR / "shell.html")
    shell_js = read_text(SHELL_DIR / "shell.js")
    preamble = read_text(SHELL_DIR / "preamble.js")
    for name, text in (("shell.js", shell_js), ("preamble.js", preamble)):
        if "</script" in text.lower():
            raise BuildError(f"shell/{name} must not contain '</script'")

    # The preamble runs first inside the frame: it removes WebRTC and defines Save.
    head = re.search(r"<head>", game, re.IGNORECASE)
    if not head:
        raise BuildError("game.html: <head> must have no attributes")
    frame_doc = game[: head.end()] + "\n<script>" + preamble + "</script>" + game[head.end():]

    csp = "; ".join(POLICY).format(
        scripts=" ".join(sha256_source(s) for s in (shell_js, preamble, game_script))
    )

    bar = ""
    if banner:
        bar = '<div id="bar"><span>' + html.escape(banner) + "</span>"
        if download_name:
            bar += '<a href="" download="' + download_name + '">Download this build</a>'
        bar += "</div>"

    page = shell
    for key, value in (
        ("{{CSP}}", csp),
        ("{{TITLE}}", html.escape(title)),
        ("{{BANNER}}", bar),
        ("{{NAMESPACE}}", namespace),
        ("{{SRCDOC}}", html.escape(frame_doc, quote=True)),
        ("{{SHELL_JS}}", shell_js),
    ):
        if page.count(key) < 1:
            raise BuildError(f"shell/shell.html is missing {key}")
        page = page.replace(key, value)

    size = len(page.encode("utf-8"))
    if size >= MAX_BYTES:
        raise BuildError(f"built page is {size} bytes (limit {MAX_BYTES})")
    return page


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--game", default=str(ROOT / "game.html"))
    ap.add_argument("--out", default=str(ROOT / "dist" / "index.html"))
    ap.add_argument("--namespace", default="micro-tactics", help="storage namespace for saves")
    ap.add_argument("--banner", help="text for a bar above the game (used for previews)")
    ap.add_argument("--download-name", help="adds a download link to the bar with this file name")
    ap.add_argument("--skip-js-lint", action="store_true", help="tests only: build the sandbox canary")
    args = ap.parse_args()
    try:
        page = build(args.game, namespace=args.namespace, banner=args.banner,
                     download_name=args.download_name, skip_js_lint=args.skip_js_lint)
    except BuildError as e:
        sys.exit(f"build failed: {e}")
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    digest = hashlib.sha256(page.encode("utf-8")).hexdigest()
    print(f"built {out} ({len(page.encode('utf-8'))} bytes, sha256 {digest})")


if __name__ == "__main__":
    main()
