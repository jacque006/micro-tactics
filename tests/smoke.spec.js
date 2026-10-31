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

test("player moves with WASD", async ({ page }) => {
  await page.goto("/index.html");
  const before = await page.evaluate(() => JSON.stringify(window.__debug?.player));
  await page.keyboard.down("d");
  await page.waitForTimeout(400);
  await page.keyboard.up("d");
  const after = await page.evaluate(() => JSON.stringify(window.__debug?.player));
  expect(after).not.toBe(before);
});
