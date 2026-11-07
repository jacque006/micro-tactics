# PR media capture

Every open PR gets up to 3 PNG screenshots and one GIF of 20 seconds or less in its preview comment. `.github/workflows/pages.yml` makes them with main's `tools/capture.js`, following the PR's `tests/game/capture.json`.

The scenario is JSON, not code, so capturing a PR never runs that PR's code outside the browser sandbox.

## Writing a scenario

Edit `tests/game/capture.json` to show the feature your PR adds:

```json
{
  "steps": [
    { "shot": "title" },
    { "record": "start" },
    { "tap": [0, 0] },
    { "tap": [1, 5] },
    { "waitFor": { "path": "player.selected", "equals": "knight" } },
    { "shot": "knight-selected" },
    { "endTurn": true },
    { "wait": 3000 },
    { "record": "stop" }
  ]
}
```

| Step | What it does |
|---|---|
| `{ "tap": [x, y] }` | Taps the centre of tile (x, y). The canvas is 16 × 15 tiles; rows 12-14 are the info panel. |
| `{ "endTurn": true }` | Taps the END TURN button. |
| `{ "wait": ms }` | Pauses for 0 to 10000 ms. |
| `{ "waitFor": { "path": "...", "equals": value, "timeout": ms } }` | Waits until `window.__debug.<path>` equals `value` (a string, number, boolean or null). The timeout defaults to 5000 ms. |
| `{ "shot": "name" }` | Saves `name.png`. At most 3 per scenario, with unique names made of lowercase letters, digits and dashes. |
| `{ "record": "start" }` / `{ "record": "stop" }` | Records everything in between as the GIF. Recording stops by itself at 20 seconds. |

Limits: 200 steps at most, and all waits together under 60 seconds. `npm test` checks that the scenario is valid.

## Running it locally

```sh
python3 tools/build.py
node tools/capture.js --out media    # defaults: --page dist/index.html --scenario tests/game/capture.json
```

The output goes to `media/`, which git ignores: `<shot>.png`, `capture.gif` and `manifest.json`. If Chromium isn't installed, run `npx playwright install chromium`, or set `PW_CHROMIUM_EXECUTABLE` to an installed Chrome.
