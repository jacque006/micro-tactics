// Gameplay checks. The game runs inside the sandboxed frame #game-frame, so read its state and
// find its canvas through that frame (gameFrame below). The CSP and sandbox are checked in
// tests/security/.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { validateScenario } = require("../../tools/capture.js");

async function gameFrame(page) {
  const handle = await page.locator("#game-frame").elementHandle();
  const frame = await handle.contentFrame();
  await frame.waitForFunction(() => typeof window.__debug === "object");
  return frame;
}

test("game boots with no errors and a visible canvas", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html");
  const frame = await gameFrame(page);
  await expect(frame.locator("canvas#game")).toBeVisible();
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test("tapping a hero selects it", async ({ page }) => {
  await page.goto("/index.html");
  const frame = await gameFrame(page);
  const canvas = frame.locator("canvas#game");
  const clickTile = async (tx, ty) => {
    const box = await canvas.boundingBox();
    const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
    await page.mouse.click(
      box.x + ((tx * 16 + 8) * box.width) / size.w,
      box.y + ((ty * 16 + 8) * box.height) / size.h
    );
  };
  await clickTile(0, 0); // title screen: tap to start
  expect(await frame.evaluate(() => window.__debug.player.selected)).toBeFalsy();
  await clickTile(1, 5); // the Knight's starting tile
  expect(await frame.evaluate(() => window.__debug.player.selected)).toBe("knight");
});

test("the PR capture scenario is valid", () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, "capture.json"), "utf8"));
  expect(validateScenario(scenario)).toEqual([]);
});
