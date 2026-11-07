const { test, expect } = require("@playwright/test");

test("game boots with no errors and a visible canvas", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/index.html");
  await expect(page.locator("#game")).toBeVisible();
  expect(errors).toEqual([]);
});

test("CSP is sealed", async ({ page }) => {
  await page.goto("/index.html");
  const csp = await page.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ""
  );
  expect(csp).toContain("sha256-");
  expect(csp).toContain("default-src 'none'");
});

test("tapping a hero selects it", async ({ page }) => {
  await page.goto("/index.html");
  const canvas = page.locator("#game");
  const clickTile = async (tx, ty) => {
    const box = await canvas.boundingBox();
    const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
    await page.mouse.click(
      box.x + ((tx * 16 + 8) * box.width) / size.w,
      box.y + ((ty * 16 + 8) * box.height) / size.h
    );
  };
  await clickTile(0, 0); // title screen: tap to start
  expect(await page.evaluate(() => window.__debug?.player.selected)).toBeFalsy();
  await clickTile(1, 5); // the Knight's starting tile
  expect(await page.evaluate(() => window.__debug?.player.selected)).toBe("knight");
});
