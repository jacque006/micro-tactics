# Wasteland Skeletons

A top-down action-survival game in a single `index.html`. Fight off 5 waves of skeletons in a post-apocalyptic wasteland.

## Controls

| Key | Action |
| --- | --- |
| WASD / arrow keys | Move |
| Space | Melee attack (in the direction you last moved) |
| Enter / R | Restart after game over or victory |

Any key on the title screen starts the game.

## Architecture

Everything lives in `index.html` (one inline script, sealed into the CSP).

- **Loop:** `requestAnimationFrame` feeding a fixed 60 Hz `update` step; rendering is separate.
- **World:** 40×30 tilemap of 16px tiles; border walls plus scattered rocks. Rendered on a 320×240 canvas, scaled up with pixelated CSS; the camera follows the player.
- **Collision:** AABB vs. tiles, resolved per axis so entities slide along walls.
- **Player:** 5 HP, melee hitbox in front of the player, brief invulnerability after being hit.
- **Skeletons:** AI states wander → chase → attack (windup, then lunge); touch damage; hit flash and knockback.
- **Waves:** wave *n* spawns `2 + 2n` skeletons; clearing wave 5 wins.
- **Debug handle:** `window.__debug` exposes live `player`, `enemies` and `wave` for the Playwright smoke tests.

## Security

The CSP is sealed with `python3 tools/pin_hash.py --seal index.html` after any script edit and checked with `--verify`. There are no network requests.

## Assets and licenses

No external assets. All graphics are drawn procedurally on the canvas, so there are no third-party licenses to list.
