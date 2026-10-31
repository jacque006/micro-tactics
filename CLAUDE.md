# CLAUDE.md — Agent Constitution

Standing operating rules for every automated contributor to this repository. These rules bind you on every task. CI mechanically enforces the marked items — the rest are enforced at human review.

## What this project is

A single-file, browser-deployed game (see `BOOTSTRAP.md` for the active task). Trust model: **you propose, CI verifies, a human merges.** You never have final authority over what ships.

## Hard constraints (CI-enforced)

1. All game code lives in `index.html` — one file, under 2 MB.
2. 16px tile grid. No mixed tile sizes.
3. Runtime CSP is sealed by `tools/pin_hash.py`. Never weaken a CSP directive; run `--seal` after your final script edit.
4. No runtime network requests. Assets are procedural or inlined `data:` URIs.
5. Never modify: `tests/`, `.github/workflows/`, `tools/pin_hash.py`, `CLAUDE.md`, `BOOTSTRAP.md`.
6. Every externally-sourced asset carries a license comment (origin, author, license, URL) adjacent to its use.

## Process rules (human-enforced)

7. All changes arrive as a PR branch referencing a GitHub issue. Never push to `main`.
8. Run `npm ci && npm test` and `python3 tools/pin_hash.py --verify index.html` before marking work done or requesting review.
9. The issue's acceptance criteria are the definition of done. Do not add scope beyond them; do not silently skip criteria — comment on the issue instead.
10. If a spec is ambiguous or contradictory, stop and ask in the issue rather than improvising.
11. When a reviewer leaves change requests, address every comment before re-requesting review.
12. Prefer deleting code over adding it. Prefer the smallest diff that satisfies the acceptance criteria.
13. If you cannot complete a task, say so in the issue with a precise statement of where you stopped and why.

## Style

14. Plain, readable code over cleverness. The human reviewing your diff is reading every line.
