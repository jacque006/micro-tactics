#!/usr/bin/env python3
"""Assembles the GitHub Pages site: the released game, a preview of every open PR, and their
screenshots. Run by .github/workflows/pages.yml in three steps with different permissions:

    python3 tools/pages.py fetch   --repo OWNER/NAME --work work      # read-only token
    python3 tools/pages.py build   --work work --site site --manifest manifest.json   # no token
    python3 tools/pages.py comment --repo OWNER/NAME                  # can comment on PRs

Trust model: this file, the shell and the build tool always come from main. From a PR we take
only two files, as data: game.html and tests/game/capture.json. So a PR cannot change how its
own preview is built, sandboxed or captured. Only PRs whose branch lives in this repository get
previews; anyone who can push a branch here is already trusted to that degree.

Site layout:
    index.html                    the released game (main), media/ its screenshots
    pr/<n>/index.html             PR preview, with its own save namespace and a download link
    pr/<n>/media/                 the PR's screenshots and GIF
Standard library only, plus the gh CLI for fetch and comment.
"""

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build as builder  # noqa: E402  (tools/build.py)

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHOT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
MAX_PREVIEWS = 20
MARKER = "<!-- micro-tactics-preview -->"


def gh(*args, stdin=None):
    result = subprocess.run(["gh", *args], input=stdin, capture_output=True)
    return result.returncode, result.stdout, result.stderr.decode("utf-8", "replace")


def clip(text, limit=1500):
    text = text.replace("```", "'''").replace("<!--", "<!-")
    return text if len(text) <= limit else text[:limit] + "\n[...]"


# ---------- fetch ----------
def fetch(repo, work):
    work = pathlib.Path(work)
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    code, out, err = gh("api", f"repos/{repo}/pulls?state=open&sort=updated&direction=desc&per_page=100")
    if code != 0:
        sys.exit(f"listing pull requests failed: {err}")
    prs = []
    for pr in json.loads(out):
        head = pr.get("head") or {}
        number, sha = pr.get("number"), head.get("sha", "")
        same_repo = (head.get("repo") or {}).get("full_name") == repo
        if not isinstance(number, int) or not SHA_RE.match(sha) or not same_repo:
            continue
        if len(prs) == MAX_PREVIEWS:
            break
        target = work / f"pr-{number}"
        target.mkdir()
        files = {}
        for path in ("game.html", "tests/game/capture.json"):
            code, body, _ = gh("api", "-H", "Accept: application/vnd.github.raw", f"repos/{repo}/contents/{path}?ref={sha}")
            if code == 0 and len(body) < builder.MAX_BYTES:
                (target / pathlib.Path(path).name).write_bytes(body)
                files[path] = True
        prs.append({"number": number, "sha": sha, "has_game": "game.html" in files})
    (work / "prs.json").write_text(json.dumps(prs))
    print(f"fetched {len(prs)} pull request(s)")


# ---------- build ----------
def capture(page, scenario, out):
    result = subprocess.run(
        ["node", str(ROOT / "tools" / "capture.js"), "--page", str(page), "--scenario", str(scenario), "--out", str(out)],
        capture_output=True, text=True, timeout=240, cwd=ROOT,
    )
    if result.returncode != 0:
        return None, clip((result.stderr or result.stdout).strip())
    try:
        manifest = json.loads((out / "manifest.json").read_text())
        shots = [s for s in manifest.get("shots", []) if isinstance(s, str) and SHOT_RE.match(s)][:3]
        return {"shots": shots, "gif": manifest.get("gif") is True}, None
    except (OSError, ValueError):
        return None, "capture wrote no manifest"


def build_site(work, site, manifest_path):
    work, site = pathlib.Path(work), pathlib.Path(site)
    shutil.rmtree(site, ignore_errors=True)
    site.mkdir(parents=True)
    default_scenario = ROOT / "tests" / "game" / "capture.json"

    # The released game. If main does not build, fail and deploy nothing.
    (site / "index.html").write_text(builder.build(ROOT / "game.html"), encoding="utf-8")
    media, error = capture(site / "index.html", default_scenario, site / "media")
    if error:
        print(f"warning: capturing main failed:\n{error}")
    (site / "robots.txt").write_text("User-agent: *\nDisallow: /pr/\n")

    entries = []
    for pr in json.loads((work / "prs.json").read_text()):
        number, sha = int(pr["number"]), pr["sha"]
        if not SHA_RE.match(sha):
            continue
        short = sha[:7]
        entry = {"number": number, "sha": sha, "status": "built", "shots": [], "gif": False}
        source = work / f"pr-{number}"
        out = site / "pr" / str(number)
        try:
            if not pr.get("has_game"):
                raise builder.BuildError("this PR has no game.html")
            page = builder.build(
                source / "game.html",
                namespace=f"pr-{number}",
                banner=f"Preview of PR #{number} at {short}. Not the released game; saves are kept separately.",
                download_name=f"micro-tactics-pr-{number}-{short}.html",
            )
        except builder.BuildError as e:
            entry.update(status="failed", error=clip(str(e)))
            entries.append(entry)
            continue
        out.mkdir(parents=True)
        (out / "index.html").write_text(page, encoding="utf-8")
        scenario = source / "capture.json"
        media, error = capture(out / "index.html", scenario if scenario.exists() else default_scenario, out / "media")
        if media:
            entry.update(media)
        else:
            entry["capture_error"] = error
        entries.append(entry)
        print(f"PR #{number}: {entry['status']}{' (capture failed)' if error else ''}")

    pathlib.Path(manifest_path).write_text(json.dumps({"prs": entries}, separators=(",", ":")))


# ---------- comment ----------
def render(entry, page_url, repo):
    number, sha = entry["number"], entry["sha"]
    short = sha[:7]
    commit = f"[`{short}`](https://github.com/{repo}/commit/{sha})"
    lines = [MARKER, f"<!-- sha: {sha} status: {entry['status']} -->", f"### Preview of {commit}", ""]
    if entry["status"] != "built":
        lines += ["**The preview did not build**, so there is nothing to play for this commit:", "",
                  "```text", entry.get("error", ""), "```"]
        return "\n".join(lines)
    url = f"{page_url}pr/{number}/"
    lines += [f"**[Play the preview]({url})**. The bar at the top of the preview has a download link for this exact file.", "",
              "<sub>Built from this PR's <code>game.html</code> and <code>tests/game/capture.json</code> with "
              "<code>main</code>'s shell and tools, so a PR can't change how its own preview is built. "
              "Preview saves are kept apart from the released game's.</sub>", ""]
    images = [f'<img src="{url}media/{s}.png?v={short}" width="256" alt="{s}">' for s in entry["shots"]]
    if entry["gif"]:
        images.append(f'<img src="{url}media/capture.gif?v={short}" width="256" alt="capture">')
    if images:
        lines += [" ".join(images), ""]
    if entry.get("capture_error"):
        lines += ["Screenshots failed for this commit:", "", "```text", entry["capture_error"], "```"]
    return "\n".join(lines)


def comment(repo, manifest_json, page_url):
    if not page_url.startswith("https://"):
        sys.exit(f"unexpected page URL: {page_url!r}")
    if not page_url.endswith("/"):
        page_url += "/"
    for entry in json.loads(manifest_json)["prs"]:
        number, sha = int(entry["number"]), entry["sha"]
        if not SHA_RE.match(sha):
            continue
        body = render(entry, page_url, repo)
        code, out, err = gh("api", "--paginate", f"repos/{repo}/issues/{number}/comments",
                            "--jq", '.[] | {id, body, user: .user.login}')
        if code != 0:
            print(f"PR #{number}: listing comments failed: {err}")
            continue
        existing = None
        for line in out.decode("utf-8").splitlines():
            c = json.loads(line)
            if c["user"] == "github-actions[bot]" and c["body"].startswith(MARKER):
                existing = c
                break
        if existing and existing["body"] == body:
            continue
        payload = json.dumps({"body": body}).encode("utf-8")
        if existing:
            code, _, err = gh("api", "-X", "PATCH", f"repos/{repo}/issues/comments/{existing['id']}", "--input", "-", stdin=payload)
        else:
            code, _, err = gh("api", "-X", "POST", f"repos/{repo}/issues/{number}/comments", "--input", "-", stdin=payload)
        print(f"PR #{number}: {'updated' if existing else 'posted'} preview comment" if code == 0 else f"PR #{number}: {err}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch")
    f.add_argument("--repo", required=True)
    f.add_argument("--work", default="work")
    b = sub.add_parser("build")
    b.add_argument("--work", default="work")
    b.add_argument("--site", default="site")
    b.add_argument("--manifest", default="manifest.json")
    c = sub.add_parser("comment")
    c.add_argument("--repo", required=True)
    args = ap.parse_args()
    if getattr(args, "repo", None) and not REPO_RE.match(args.repo):
        sys.exit(f"bad repository name: {args.repo!r}")
    if args.cmd == "fetch":
        fetch(args.repo, args.work)
    elif args.cmd == "build":
        build_site(args.work, args.site, args.manifest)
    else:
        comment(args.repo, os.environ["MANIFEST"], os.environ["PAGE_URL"])


if __name__ == "__main__":
    main()
