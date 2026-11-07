# Security model

The goal: whatever ends up in `game.html`, written by a person, by Claude, or by someone who tricked either one, the game can only draw, take input, play sound and save its own data. And nothing reaches the repo, the build or the published site without the owner's review.

## Who can change what

| Paths | Who | What they decide |
|---|---|---|
| `game.html`, `tests/game/`, `README.md` | agent and owner | the game itself, which is untrusted by design |
| `shell/`, `tools/`, `tests/security/`, `tests/prepare.py`, `.github/`, `CLAUDE.md`, `SECURITY.md`, `CODEOWNERS`, `package.json`, `package-lock.json`, `.npmrc`, `playwright.config.js` | owner only | what the game can do, and how it is built, tested and published |

CODEOWNERS puts every change in front of the owner. CI's `agent scope` check fails any PR on a `claude/` branch (or with a `claude[bot]` commit) that touches an owner-only path.

## Walls: what the browser enforces

`tools/build.py` turns `game.html` into one self-contained HTML file: a small shell page with the game inside it.

- **Sandboxed frame.** The game runs in `<iframe sandbox="allow-scripts" srcdoc=...>`. Without `allow-same-origin` it gets an opaque origin, so it has no cookies, localStorage, IndexedDB or cache, and no access to the shell page. Without `allow-popups`, `allow-top-navigation`, `allow-forms` or `allow-downloads` it can't open windows, move the page, submit forms or download files. There is no `allow=` attribute, so it can't ask for the camera, microphone, clipboard or other permissions.
- **Content-Security-Policy.** It is the first element of the page, and the frame inherits it. `default-src 'none'`. Scripts run only by hash (shell, preamble, game). Images, media and fonts load only from `data:` and `blob:`. Trusted Types with no policies, so no `innerHTML`, `eval`, string timers or script URLs. No workers, frames, form targets or `<base>`. The exact policy is in `tools/build.py` and checked by `tests/security/build.spec.js`.
- **Preamble.** `shell/preamble.js` runs first inside the frame and removes WebRTC and WebTransport, which CSP can't block. Game code can't get fresh copies from a new iframe, because that iframe is cross-origin to the opaque frame.
- **Save bridge.** The shell is the only code that touches real storage. Keys are namespaced per build (`mt:<namespace>:<key>`), validated, and capped at 64 keys, 64 KB per value and 256 KB in total. Previews use their own namespace, so a preview can't read or change the released game's saves.

All of this lives inside the one file, so it holds the same way hosted on Pages, hosted somewhere else, embedded by another site, or opened from disk. `tests/security/sandbox.spec.js` checks every one of those placements with a canary game (`tests/security/canary.html`) that tries every escape we know of. The test browsers send all traffic through a logging proxy that refuses it, so a request that got out would show up.

## Tripwires: what makes a bad diff loud

- `tools/build.py` refuses a `game.html` with more than one script, an external script, `<link>`, `<base>`, `<iframe>`, `<meta http-equiv>`, inline event handlers, CSS `@import` or remote CSS URLs.
- `tools/lint_game.mjs` parses the game's script and refuses:
  - any global not in `tools/api-allowlist.json`
  - banned properties (`innerHTML`, `location`, `href`, `cookie`, `constructor`, `defaultView` and more)
  - bracket access on a global, `import()` and `with`
  - URL strings, and `data:` URIs that aren't images or audio

  It understands scopes, so a local variable named `fetch` is fine and the global `fetch` is not.
- These are tripwires, not walls. A determined author can hide a property name in a computed string. If that happens the walls above still hold; the tripwire just makes sure a reviewer notices.

## Pipeline

| Workflow | Runs on | Whose code | Token | Secrets |
|---|---|---|---|---|
| `ci.yml` | every PR and branch push | the PR's | read-only | none |
| `pages.yml` | after CI, daily, by hand | main's only | read (assemble), Pages (deploy), PR comments (comment) | none |
| `claude.yml` | the owner's `@claude` on an issue or PR the owner (or Claude) opened | main's | contents, PRs and issues write; no workflows permission | Claude token, in the `claude` environment |

- **Previews.** `pages.yml` takes only `game.html` and `tests/game/capture.json` from each open PR whose branch lives in this repository. It fetches them as data through the API and builds them with main's shell and tools. It never runs a PR's tools, tests or install scripts. The game runs only inside its sandboxed frame, in a Chromium whose only proxy is a closed port. Previews live at `/pr/<number>/`, under a banner and with their own save namespace.
- **Screenshots and GIFs.** main's `tools/capture.js` follows the PR's JSON scenario: taps, waits, checks on `__debug`, and shots. No PR code runs outside the browser. The output is size-checked and published to Pages. The comment job writes its text from the build manifest only.
- **Downloads.** CI uploads every branch's build as a single HTML file. That copy is built with the branch's own tools. The preview's download link is built with main's.
- **Supply chain.**
  - Every action is pinned to a full commit SHA.
  - Dependencies are Playwright and acorn only: exact versions, no install scripts, at least 7 days old.
  - The Python tools use only the standard library.
  - zizmor is hash-pinned. It and actionlint check the workflows.

## Known gaps

- **Navigation can leak a hostname.** If the game navigates its frame, CSP blocks it, but Chrome may first open a connection to the target host. The path and query string never leave. A hostname like `<data>.attacker.example` can, through DNS. Only the lint (no `location`, no `href`, no element other than `<canvas>`) and review stand in the way.
- **Local copies share storage.** In Chrome, every HTML file opened from disk shares one storage area, so other local files can read or change this game's saves. That's why saves are treated as untrusted input. Never store anything sensitive in them.
- **Firefox and WebKit** run the security suite in CI, but don't block merges until they're confirmed green.
- **Out of reach for any rule here:** a browser bug that escapes the sandbox, a game that burns CPU or draws misleading text on its canvas, a takeover of the owner's GitHub account, or the owner approving a bad diff.

## Settings the owner must apply

These live in GitHub's settings, not in the repo, so no PR can set them.

1. **Pages:** Settings → Pages → Source: **GitHub Actions**. Then delete the `gh-pages` branch. It is no longer served.
2. **`github-pages` environment:** Settings → Environments → `github-pages` → Deployment branches: **main only**.
3. **`claude` environment:** create it (or let the next agent run create it), and set Deployment branches to **main only**. Add `CLAUDE_CODE_OAUTH_TOKEN` there, then delete the repository-level secret of that name. Until you do, the agent keeps using the repository secret.
4. **Actions:** Settings → Actions → General:
   - Allow only actions created by GitHub, plus `anthropics/claude-code-action@*`.
   - Tick **Require actions to be pinned to a full-length commit SHA**.
   - Set Workflow permissions to **Read repository contents**.
   - Untick **Allow GitHub Actions to create and approve pull requests**.
   - For fork PRs, choose **Require approval for all external contributors**.
5. **Ruleset for `main`:**
   - Require a pull request, with code-owner review.
   - Require the status checks `build`, `test (chromium)`, `agent scope` and `workflow lint`.
   - Block force pushes and deletion.
   - While you're the only maintainer, add yourself as a bypass actor *for pull requests only*.
6. **Ruleset for other branches** (recommended): target all branches except `claude/**` and `dependabot/**`, restrict creations and updates, and set bypass to repository admins. Then the agent can push only to `claude/` branches.
7. **Who can reach the agent:** the workflow already ignores everyone but you. To keep strangers' text off your issues too, limit interactions to collaborators (Settings → Moderation; it expires, so renew it) or make the repo private.
8. **Account:** use passkey or security-key 2FA, and turn on secret scanning push protection.
9. **Custom domain** (optional): every project under `jacque006.github.io` shares one origin. So the shell's storage is shared, namespaced but not isolated, with any other game hosted there. A custom subdomain per game gives each one its own origin. Verify the domain in your account settings first.

## Reporting a problem

Turn on private vulnerability reporting (Settings → Code security). Then report through Security → Report a vulnerability, not in a public issue.
