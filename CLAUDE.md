# CLAUDE.md — Agent Constitution

Standing operating rules for every automated contributor to this repository. These rules bind you on every task. CI mechanically enforces the marked items — the rest are enforced at human review.

## What this project is

A single-file, browser-deployed tactics game (see the active issue for the current task). Trust model: **you propose, CI verifies, a human merges.** You never have final authority over what ships.

## Governance

Files below are **review-gated**, not forbidden. You may propose changes to them in any PR — including tests, tooling, workflows, and this constitution itself — but a CODEOWNERS rule requires the owner's explicit approval before such a PR can merge. Treat proposing changes here as legislative, not routine: justify the change in the issue before you write it.

`tests/`, `.github/workflows/`, `tools/`, `CLAUDE.md`, `BOOTSTRAP.md`, `package.json`, `playwright.config.js`, `CODEOWNERS`

When a task legitimately requires changing a test, follow **tests-first ordering**: the test change must be its own commit, first in the PR, so a reviewer reads the new expectation before the code that meets it. When a task requires changing governance or tooling files, keep that change in its own PR — never mixed into a game-feature PR.

## Hard constraints (CI-enforced)

1. All game code lives in `index.html` — one file, under 2 MB.
2. 16px tile grid. No mixed tile sizes.
3. Runtime CSP is sealed by `tools/pin_hash.py`. Never weaken a CSP directive; run `--seal` after your final script edit.
4. No runtime network requests. Assets are procedural or inlined `data:` URIs.
5. Every externally-sourced asset carries a license comment (origin, author, license, URL) adjacent to its use.

## Process rules (human-enforced)

6. All changes arrive as a PR branch referencing a GitHub issue. Never push to `main`.
7. Run `npm ci && npm test` and `python3 tools/pin_hash.py --verify index.html` before marking work done or requesting review.
8. **Never weaken a test to make code pass.** Relaxing, deleting, or trivializing an assertion is grounds for rejecting the whole PR. If an assertion seems wrong or obsolete, escalate in the issue and propose the change tests-first instead.
9. The issue's acceptance criteria are the definition of done. Do not add scope beyond them; do not silently skip criteria — comment on the issue instead.
10. If a spec is ambiguous or contradictory, stop and ask in the issue rather than improvising.
11. When a reviewer leaves change requests, address every comment before re-requesting review.
12. Prefer deleting code over adding it. Prefer the smallest diff that satisfies the acceptance criteria.
13. If you cannot complete or verify a task, say so in the issue with a precise statement of where you stopped and why. Never claim verification you did not perform, and never mark a checklist item done that is not actually done.

## Style

14. Plain, readable code over cleverness. The human reviewing your diff is reading every line.
