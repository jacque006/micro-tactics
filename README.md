# Micro Tactics

A turn-based tactics game in a single HTML file. Lead three heroes against skeletons that refuse to stay dead.

**Play it** at https://jacque006.github.io/micro-tactics/, or download the HTML file from any CI run and open it offline.

## Controls (mouse / touch)

| Input | Action |
| --- | --- |
| Tap / click a hero | Select it (blue tiles = where it can move) |
| Tap a blue tile | Move there (once per turn) |
| Tap a red / gold / teal tile | Attack, smash, or raise (ends that hero's turn) |
| Tap the selected hero again | Wait (end that hero's turn) |
| END TURN button | Hand the turn to the skeletons |

## Heroes

| Hero | HP | Move | Action |
| --- | --- | --- | --- |
| Knight | 6 | 3 | 2 damage to an adjacent foe, or smash an adjacent bone pile |
| Archer | 4 | 3 | 1 damage at range 2-4 |
| Bonewright | 3 | 3 | 1 damage at range 1-3, or **raise** a bone pile within range 3 |

## The bone mechanic: Rattle & Reassemble

A defeated skeleton collapses into a **bone pile** with a countdown. When it reaches 0 at the end of an enemy turn, the pile rebuilds into a 1 HP skeleton, unless something stands on it (it waits). Per pile you choose:

- **Smash** it with the Knight (gone for good),
- **Raise** it with the Bonewright (it becomes your own Bone Thrall, 2 HP, acts next turn), or
- **Block** it by standing on it.

You win when no skeletons and no bone piles remain; you lose if all three heroes fall.

## Architecture

- **`game.html` is the whole game:** one inline script drawing on one canvas.
- **`tools/build.py` turns it into `dist/index.html`:** a small shell page (`shell/`) that runs the game inside a sandboxed iframe under a strict CSP. The result is one self-contained file that works hosted anywhere or opened from disk. [SECURITY.md](SECURITY.md) explains what the sandbox allows.
- **Board:** 16×12 tiles of 16px (256×192) drawn above a 48px info panel on a 256×240 canvas; the whole board is always visible. The canvas scales to the frame with `touch-action: none` and pointer events, so mouse and touch share one code path.
- **Rules:** BFS for movement range, Manhattan range for attacks, `phase` state machine (`title → player ⇄ enemy → over/win`).
- **Enemy AI:** each skeleton walks to the reachable tile closest to a hero (preferring weak ones) and hits the weakest adjacent hero.
- **Saves:** the game has no direct storage. `Save.get/set/remove` (after `await Save.ready`) go through the shell to localStorage, under this game's own namespace. The game doesn't save anything yet.
- **Debug handle:** `window.__debug` (inside the game frame) exposes `player` (heroes, selection, legacy cursor), `enemies`, and `wave` (the turn number) for the tests and the capture tool.

## Working on it

```sh
npm ci                          # Playwright and acorn; no install scripts run
npx playwright install chromium
python3 tools/dev.py            # rebuilds on save, serves http://127.0.0.1:8000/
npm test                        # game and security suites, in Chromium
```

`python3 tools/build.py` builds once. It refuses a `game.html` that uses a browser API outside `tools/api-allowlist.json`, and says which line.

## Previews, downloads and screenshots

- Every open PR gets a playable preview at `https://jacque006.github.io/micro-tactics/pr/<number>/`. A comment on the PR links it and shows up to 3 screenshots and a GIF, and it updates on every push.
- `tests/game/capture.json` decides what those screenshots show. Edit it to show your PR's feature (format: [tools/CAPTURE.md](tools/CAPTURE.md)).
- Every CI run, on every branch, has a single-file download of that build in its summary.

## Assets and licenses

No external assets. All graphics are drawn procedurally on the canvas.
