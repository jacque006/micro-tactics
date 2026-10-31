# PR media capture

`tools/capture.js` plays the game in headless Chromium and writes PR media:
at most 3 PNG screenshots and one GIF of 20 seconds or less.

```
npx playwright install chromium   # once
node tools/capture.js --out media --scenario tour
```

The script serves `index.html` itself, so no dev server is needed and it adds no dependencies.
Output is written to `media/` (git-ignored).

## Capturing a specific feature

Add a function to `SCENARIOS` in `tools/capture.js`. It receives `tap(tx, ty)` (tile coordinates),
`endTurn()`, `wait(ms)`, `debug()` (reads `window.__debug`), `shot(name)` and `rec.start()/rec.stop()`.
Use `debug()` to check the game reached the moment worth showing before calling `shot()`.
`shot()` throws on a 4th screenshot, and the GIF stops recording at 20 seconds.

## Publishing as workflow artifacts (needs a workflow, owner to add)

Agents cannot edit `.github/workflows/`. This job can be added to `ci.yml` (or a new workflow) by the repo owner:

```yaml
  pr-media:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: node tools/capture.js --out media
      - uses: actions/upload-artifact@v4
        with:
          name: pr-media
          path: media/
```

Artifacts do not render inline in a PR description. Link the run's artifact list from the description.
