# BOOTSTRAP — Build this repo's development harness

You are the founding agent for this repository. Execute everything below,
then verify your work against the acceptance checklist. Do not ask
questions; where something is underspecified, choose the simplest
option consistent with the constitution.

## 1. The Constitution (non-negotiable, encode ALL of these in CI)

1. THE GAME is a single file: `index.html` at repo root. No game
   dependencies, no imports, no CDN links, no build step for the game.
2. SECURITY HEADER, in <head>, before any script. The CSP must be:
   <meta http-equiv="Content-Security-Policy" content="default-src 'none';
   script-src 'sha256-HASH-OF-SCRIPT-BLOCK';
   style-src 'unsafe-inline'; img-src data:; base-uri 'none';
   form-action 'none'; object-src 'none'; frame-ancestors 'none';">
   Where 'sha256-HASH-OF-SCRIPT-BLOCK' is the literal, correct
   base64 SHA-256 hash of the file's single <script> body (computable
   with: openssl dgst -sha256 -binary script.js | openssl base64 -A).
   The hash MUST be recomputed and the CSP updated in the same commit
   whenever the script changes. style-src stays 'unsafe-inline' (style
   injection is not a meaningful threat surface for a canvas game and
   hashing styles would double the maintenance burden).
   Note: frame-ancestors is ignored in meta CSP but harmless here; the
   real anti-framing defense is the JS guard in item 8 — include it
   in the meta string anyway so a future header-based serving setup
   inherits the full policy.
3. The game must NEVER contain: fetch, XMLHttpRequest, WebSocket,
   EventSource, sendBeacon, importScripts, localStorage, sessionStorage,
   indexedDB, document.cookie, eval, new Function, alert, prompt,
   confirm, window.open, or any http(s):// URL. Additionally the script
   must not assign to document.location / window.location / top /
   parent in any way that could redirect or escape (navigation CSP
   coverage is weak; this closes it by code discipline, verified by
   CI grep).
4. Every PR that changes index.html must bump the version number in the
   release log comment at the top of the file (semver: patch=bugfix,
   minor=feature, major=theme/scope change) and add a one-line entry.
5. The QA surface: the game must support `?qa=1` which exposes
   `window.__qa = { getState, setSeed, tap }` for test scripting. The hook
   must be inert in normal play. Also support `?still=1` to freeze
   time-based animation for deterministic screenshots.
6. Agents (you) may NEVER modify files under tests/ or .github/workflows/
   to make CI pass. Fix the game, not the tests. If a test seems wrong,
   say so in the PR and let the human decide.
7. The repo may have dev-only dependencies (Playwright, a static server)
   but they never touch the shipped game.
8. FRAMING GUARD: the first lines of the script must detect
   `top !== self` and if framed, render nothing and throw (halt). This
   substitutes for the frame-ancestors header that meta CSP cannot
   deliver on static hosts.
9. TAMPER SEAL PROCEDURE: after any script change, run
   `tools/pin-hash.sh` (you must create it) which extracts the script
   body, computes its base64 SHA-256, and rewrites the CSP meta tag.
   Commit the hash update in the SAME PR as the script change. CI
   independently verifies the pairing — a mismatch fails the build.

## 2. Create these files

### index.html (starter stub)
A minimal, WORKING canvas game stub honoring the constitution:
- Strict CSP (exact string above, with the correctly computed hash of
  your own script), viewport meta for mobile
- Fixed-size canvas, pixelated rendering, centered dark page
- A seeded RNG (mulberry32) whose seed `__qa.setSeed` can pin
- `?qa=1` and `?still=1` hooks per the constitution
- The framing guard (constitution item 8) as the script's first logic
- An inline release-log comment header starting at version 0.1.0
- Something minimal but real: draws a board, responds to a tap
  (so interaction tests have something to test)

### tools/pin-hash.sh (or .js)
Executable script: extracts the <script> body from index.html, computes
base64 SHA-256, rewrites the script-src hash in the CSP meta tag.
Must be idempotent (running twice changes nothing) and must fail loudly
if it cannot find exactly one script block.

### .github/workflows/ci.yml
On every push and PR:
1. Static guards (fail loudly, with ::error annotations):
   - CSP present, structurally exact (all six directives), and the
     script hash matches the actual script body (independent
     re-computation in the workflow — never trust the file's own claim)
   - Forbidden-API grep (constitution list, including the location/
     top/parent assignment guard)
   - No http(s):// URLs anywhere in index.html
   - Version bumped relative to main
2. Install dev deps, run Playwright against a local static server:
   - loads with zero pageerror/console.error within 5s
   - CSP actually enforced: assert that a deliberately violating probe
     (e.g., a script-injected image load from a nonexistent remote URL
     injected via console under ?qa=1) is BLOCKED by capturing the
     browser's CSP violation report
   - framing guard test: load the game inside a child iframe fixture;
     assert the game did not initialize (its canvas stays blank)
   - scripted interaction via window.__qa completes within timeouts
   - screenshot of the `?qa=1&still=1` state matches baseline
     (toHaveScreenshot; commit baselines on first run)
3. Lint job: verify tests/ and .github/ files are unchanged versus
   main when the PR author is an agent (skip for human authors).

### .github/workflows/deploy.yml
On push to main, after ci passes: deploy repo root to GitHub Pages
(actions/configure-pages + upload-pages-artifact + deploy-pages,
permissions scoped to pages: write, id-token: write). Additionally,
create (or update) a GitHub release for the merge: attach index.html
as an artifact and record its SHA-256 digest prominently in the
release notes so players can verify downloads.

### .github/workflows/agent-iterate.yml
On PR synchronize from agent-owned branches: run ci; on failure,
feed the failing test output back to the implementing agent (comment
on the PR), capped at 6 attempts, then tag the human. Permissions:
contents: write scoped to the PR branch; pull-requests: write.

### AGENTS.md (repo root)
Restate the constitution in imperative agent-facing language, plus:
- issue format we use (Intent / Constraints / Acceptance Criteria)
- the tamper-seal procedure (constitution item 9): after editing the
  script, ALWAYS run tools/pin-hash.sh and commit the hash change
  in the same PR; expect CI to reject mismatches
- "update screenshot baselines in the same PR as intentional visual
  changes, and say why in the PR description"
- "run the full turn-cycle mental walkthrough before claiming done"
- pointer to the release-log convention
- what you may not do (constitution item 6; no force-push; no main)

### README.md
What this repo is, how to run the game (open index.html locally or
visit the Pages URL), how to VERIFY the release hash
(shasum -a 256 index.html, compare to the release notes), how to
report bugs as issues, how the harness works in 5 bullets, and a
link to AGENTS.md.

### package.json + tests/
Dev-only. Playwright as the sole dependency group, plus a trivial
static server for local test serving. tests/ contains the smoke specs
described in ci.yml, including the CSP-enforcement probe and the
framing-guard fixture. Baseline screenshots live in
tests/__screenshots__/.

## 3. What you must NOT do

- Do not create settings changes (branch protection, Pages enablement) —
  the human operator does those after merge; just document them in the
  PR description.
- Do not push to main. Branch + PR only.
- Do not weaken any guard, test, timeout, or hash check to achieve
  green. This includes "updating" the CSP hash without the
  corresponding script change, or vice versa.
- Do not add game features beyond the stub. Features come later as issues.

## 4. Acceptance checklist (definition of done)

- [ ] All files above exist and are internally consistent
- [ ] CI passes on your branch, including your own smoke tests, the
      CSP-enforcement probe, and the framing-guard test
- [ ] Tamper check: manually corrupt one character of the script body,
      confirm the hash-verification job FAILS, then revert and confirm
      green. Report that you did this in the PR description.
- [ ] index.html opens standalone from disk (file://) AND serves over http
- [ ] A second agent landing cold on this repo could work productively
      from AGENTS.md alone
