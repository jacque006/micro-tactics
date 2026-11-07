#!/usr/bin/env python3
"""Builds what the test suites load, into build/ (run by playwright.config.js before tests):

    build/index.html             the game, exactly as players get it
    build/canary/index.html      the sandbox canary (tests/security/canary.html), lint skipped
    build/canary-pr/index.html   the canary under another save namespace, like a PR preview
    build/host/*.html            pages that embed the canary from another origin (port 8001)
"""

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
CANARY = ROOT / "tests" / "security" / "canary.html"


def build(*args):
    subprocess.run([sys.executable, str(ROOT / "tools" / "build.py"), *args], check=True)


def main():
    # build/proxy.log belongs to the running proxy, so never remove the whole directory.
    BUILD.mkdir(exist_ok=True)
    build("--out", str(BUILD / "index.html"))
    build("--game", str(CANARY), "--out", str(BUILD / "canary" / "index.html"),
          "--namespace", "canary", "--skip-js-lint")
    build("--game", str(CANARY), "--out", str(BUILD / "canary-pr" / "index.html"),
          "--namespace", "canary-pr", "--skip-js-lint")
    host = BUILD / "host"
    host.mkdir(exist_ok=True)
    src = "http://127.0.0.1:8000/canary/index.html"
    (host / "plain.html").write_text(
        '<!DOCTYPE html><title>Another site</title>'
        f'<iframe src="{src}" width="640" height="480"></iframe>\n')
    (host / "sandboxed.html").write_text(
        '<!DOCTYPE html><title>Another site</title>'
        f'<iframe sandbox="allow-scripts" src="{src}" width="640" height="480"></iframe>\n')


if __name__ == "__main__":
    main()
