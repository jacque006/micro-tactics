# Micro Tactics

A turn-based tactics game in a single `index.html`. Lead three heroes against skeletons that refuse to stay dead.

## Controls (mouse / touch)

| Input | Action |
| --- | --- |
| Tap / click a hero | Select it (blue tiles = where it can move) |
| Tap a blue tile | Move there (once per turn) |
| Tap a red / gold / teal tile | Attack, smash, or raise (ends that hero's turn) |
| Tap the selected hero again | Wait (end that hero's turn) |
| END TURN button | Hand the turn to the skeletons |

Optional keyboard: WASD / arrows move a cursor, Space/Enter act as a tap, `E` ends the turn.

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

Everything lives in `index.html` (one inline script, sealed into the CSP).

- **Board:** 16×12 tiles of 16px (256×192) drawn above a 48px info panel on a 256×240 canvas; the whole board is always visible. The canvas scales to the viewport with `touch-action: none` and pointer events, so mouse and touch share one code path.
- **Rules:** BFS for movement range, Manhattan range for attacks, `phase` state machine (`title → player ⇄ enemy → over/win`).
- **Enemy AI:** each skeleton walks to the reachable tile closest to a hero (preferring weak ones) and hits the weakest adjacent hero.
- **Debug handle:** `window.__debug` exposes `player` (heroes, selection, keyboard cursor), `enemies`, and `wave` (the turn number) for the Playwright smoke tests.

## Security

The CSP is sealed with `python3 tools/pin_hash.py --seal index.html` after any script edit and checked with `--verify`. There are no network requests.

## Assets and licenses

No external assets. All graphics are drawn procedurally on the canvas.
