# BOOTSTRAP.md — Agent Task: Build the Game

Read this file completely, then `CLAUDE.md`, before writing any code.

## Objective

Turn this repository into a playable browser game: **Wasteland Skeletons** — a top-down 2D action-survival game delivered as a **single `index.html` file**, deployed via GitHub Pages.

## Product spec

- **Genre:** top-down action/survival on a tile grid. The grid is **16px** (not 24 — all candidate CC0 assets are 16×16; do not introduce mixed tile sizes).
- **Theme:** post-apocalyptic wasteland; the player fights animated skeletons.
- **Player:** WASD/arrow movement, wall collision, melee attack on Space, HP.
- **Enemies:** skeletons with wander/chase AI, touch damage, wave-based spawning, score on kill.
- **Loop:** survive waves; death shows a game-over screen with restart; a victory condition after N waves.
- **Delivery:** everything in one `index.html`. Assets are either drawn procedurally (canvas code) or inlined as `data:` URIs. **No runtime network requests** — the CSP forbids them, and CI enforces it.
- **Debug handle:** expose `window.__debug = { player, enemies, wave }` so the Playwright smoke tests can introspect game state. Do not remove it; it is part of the contract.

## Build order

1. Scaffold `index.html`: HTML5 boilerplate, `<canvas id="game">`, CSP `<meta>` placeholder (see `tools/pin_hash.py`), title screen.
2. Engine: `requestAnimationFrame` loop with fixed-timestep update, 16px tilemap, camera, input handler.
3. Player: movement, AABB collision, attack hitbox, HP.
4. Skeletons: procedural or CC0 sprite animation, AI states (wander → chase → attack), wave spawner.
5. Combat feel: hit flash, knockback, simple particles.
6. HUD: HP bar, score, wave counter; game-over and victory screens.
7. Optional: WebAudio-synthesized sound effects (no audio files).

## Assets

Prefer procedural drawing — fewer bytes, no license burden. If you use external sprites, they must be CC0 (e.g. 0x72's DungeonTileset II, GrafxKid's post-apocalyptic tiles, Reemax's skeletons — see the research notes in the issue thread) and each inlined asset carries a comment directly above it:

```html
<!-- asset: skeleton_sheet — Reemax, CC0, https://opengameart.org/content/zombie-and-skeleton-32x48 -->
```

## Definition of done (paste into the PR description and tick)

- [ ] `npm ci && npm test` passes locally (all Playwright smoke tests green)
- [ ] `python3 tools/pin_hash.py --verify index.html` exits 0 (run `--seal` first after your final edit)
- [ ] `index.html` is under 2 MB
- [ ] No `eval(`, no `new Function`, no network APIs, no external `src=` references
- [ ] `window.__debug` exposes player/enemies/wave
- [ ] Playable end to end: move, fight, die, restart, win
- [ ] `README.md` written: controls, architecture notes, asset license list
- [ ] All work is on a branch; the PR references this issue

## Off-limits (CI will reject changes here; flag conflicts in a PR comment instead of editing)

`tests/`, `.github/workflows/`, `tools/pin_hash.py`, `CLAUDE.md`, `BOOTSTRAP.md`
