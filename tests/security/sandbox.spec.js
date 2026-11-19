// Owner only. Proves the sandbox holds wherever the built file ends up: hosted, opened from
// disk, or embedded by another site, with or without that site's own sandbox. The canary
// (tests/security/canary.html) tries every escape we know of; see its comments.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const BUILD = path.join(__dirname, "..", "..", "build");
const PROXY_LOG = path.join(BUILD, "proxy.log");

// Hosts the canary navigates to. Browsers may open a connection to a navigation's host before
// CSP blocks it, so these hosts may show up by name; their paths and queries never may.
const NAME_ONLY = ["frame.leak.example", "anchor.leak.example", "selfnav.leak.example", "topnav.leak.example"];

async function gameFrame(page) {
  const handle = await page.locator("#game-frame").elementHandle();
  return handle.contentFrame();
}

async function embeddedGameFrame(page) {
  const handle = await page.frameLocator("iframe").locator("#game-frame").elementHandle();
  return handle.contentFrame();
}

async function canaryResults(frame) {
  await frame.waitForFunction(() => window.__canary && window.__canary.done, null, { timeout: 20000 });
  return frame.evaluate(() => window.__canary.results);
}

function proxyLines() {
  // The proxy creates this file when it starts. If it's missing, fail: every leak check below
  // would otherwise pass without having looked at anything.
  return fs.readFileSync(PROXY_LOG, "utf8").split("\n").filter(Boolean);
}

function expectNothingLeaked() {
  const lines = proxyLines();
  expect(lines.filter((l) => /secret/i.test(l)), "requests that carried data").toEqual([]);
  expect(
    lines.filter((l) => /leak\.example/i.test(l) && !NAME_ONLY.some((h) => l.includes(h))),
    "connections to hosts that CSP should block outright"
  ).toEqual([]);
}

const placements = [
  { name: "hosted", url: () => "/canary/index.html", frame: gameFrame },
  { name: "opened from disk", url: () => "file://" + path.join(BUILD, "canary", "index.html"), frame: gameFrame },
  { name: "embedded by another site", url: () => "http://127.0.0.1:8001/host/plain.html", frame: embeddedGameFrame },
  { name: "embedded by another site's sandbox", url: () => "http://127.0.0.1:8001/host/sandboxed.html", frame: embeddedGameFrame }
];

for (const placement of placements) {
  test(`the canary cannot escape when ${placement.name}`, async ({ page, context }) => {
    const popups = [];
    context.on("page", (p) => popups.push(p.url()));
    // A cookie the shell's origin has; the game must not see it (the canary's cookie probe).
    await context.addCookies([{ name: "shellcookie", value: "shell-only", url: "http://127.0.0.1:8000" }]);
    await page.goto(placement.url());
    const frame = await placement.frame(page);
    const results = await canaryResults(frame);

    expect(results.origin, "the game frame has an opaque origin").toBe("null");
    const escaped = Object.entries(results).filter(([name, v]) => name !== "origin" && !String(v).startsWith("held"));
    expect(escaped, "probes that got out").toEqual([]);

    const topUrl = page.url();
    // navigate() replaces the frame's document, which can end this call mid-flight. Only that
    // error is expected.
    await frame.evaluate(() => window.__canary.navigate()).catch((e) => {
      if (!/destroyed|detached|navigat/i.test(e.message)) {
        throw e;
      }
    });
    await page.waitForTimeout(1500);
    expect(page.url(), "the page did not navigate").toBe(topUrl);
    expect(popups, "no windows opened").toEqual([]);
    for (const f of page.frames()) { expect(f.url(), "no frame reached another site").not.toMatch(/leak\.example/); }
    expectNothingLeaked();
  });
}

test("every outside host goes to the logging proxy, never to DNS", async ({ page }) => {
  // The leak checks are only meaningful if a request that got out would reach the proxy. A
  // browser behind an HTTP proxy hands it the host name instead of resolving it, so no DNS
  // server or hosts-file entry can redirect the test hosts. This proves that's the path in use.
  const host = `control-${test.info().project.name}.proxy-check.example`;
  let navigationError = "";
  await page.goto(`http://${host}/`).catch((e) => {
    navigationError = e.message;
  });
  expect(proxyLines().some((l) => l.includes(host)), `the proxy saw ${host}. ${navigationError}`).toBe(true);
});

test("saves persist, stay in their namespace and respect the limits", async ({ page }) => {
  await page.goto("/canary/index.html");
  let frame = await gameFrame(page);
  const first = await frame.evaluate(() => window.__canary.save("best", "42"));
  expect(first).toMatchObject({ value: "42", persistent: true });

  // Save refuses bad input loudly, so a game author sees the mistake.
  await expect(frame.evaluate(() => window.__canary.save("big", "x".repeat(70000)))).rejects.toThrow(/at most/);
  await expect(frame.evaluate(() => window.__canary.save("__proto__", "x"))).rejects.toThrow(/keys are/);
  // And the shell refuses the same writes when a game skips Save and posts to it directly.
  await frame.evaluate(() => window.__canary.rawSet("big", "x".repeat(70000)));
  await frame.evaluate(() => window.__canary.rawSet("__proto__", "x"));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(["mt:canary:best"]);

  await page.reload();
  frame = await gameFrame(page);
  const after = await frame.evaluate(() => window.__canary.save("best"));
  expect(after).toMatchObject({ value: "42", keys: ["best"] });
});

test("a preview cannot read the released game's saves", async ({ page }) => {
  await page.goto("/canary/index.html");
  await (await gameFrame(page)).evaluate(() => window.__canary.save("best", "released"));
  await page.goto("/canary-pr/index.html");
  const preview = await (await gameFrame(page)).evaluate(() => window.__canary.save("best"));
  expect(preview).toMatchObject({ value: null, keys: [] });
});

test("inside another site's sandbox, saves fall back to memory", async ({ page }) => {
  await page.goto("http://127.0.0.1:8001/host/sandboxed.html");
  const frame = await embeddedGameFrame(page);
  const result = await frame.evaluate(() => window.__canary.save("best", "7"));
  expect(result).toMatchObject({ value: "7", persistent: false });
});
