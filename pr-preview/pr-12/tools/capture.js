#!/usr/bin/env node
// Captures PR media from the running game: at most 3 PNG screenshots and one GIF (<= 20 s).
//
//   node tools/capture.js [--out media] [--scenario tour]
//
// Serves index.html itself; needs only Playwright's chromium (`npx playwright install chromium`).
// No extra dependencies: the GIF encoder is below.
//
// To capture a specific feature, add a scenario to SCENARIOS. A scenario drives the game
// with taps and the window.__debug hooks, and calls shot("name") for up to 3 PNGs.
// Everything between rec.start() and rec.stop() ends up in the GIF.

const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("@playwright/test");

const MAX_SHOTS = 3;
const MAX_GIF_SECONDS = 20;
const GIF_FPS = 10;

// ---------- Scenarios ----------
// ctx: { tap(tx, ty), endTurn(), wait(ms), debug(), shot(name), rec }
const SCENARIOS = {
  // Generic walkthrough: start, select a hero, show its options, move, end the turn.
  async tour(ctx) {
    await ctx.shot("title");
    await ctx.rec.start();
    await ctx.tap(0, 0); // start
    await ctx.wait(400);
    await ctx.tap(1, 5); // select the Knight
    await ctx.wait(600);
    await ctx.shot("knight-selected");
    await ctx.tap(4, 5); // move
    await ctx.wait(600);
    await ctx.tap(4, 5); // wait in place
    await ctx.endTurn();
    await ctx.wait(3000); // watch the enemy turn
    await ctx.shot("after-enemy-turn");
    await ctx.rec.stop();
  }
};

// ---------- Minimal GIF89a encoder (global palette, LZW) ----------
function quantize(rgba, palette, lookup) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    const key = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    out[i] = lookup.get(key);
  }
  return out;
}

function lzw(indices, minCode) {
  const clear = 1 << minCode, end = clear + 1;
  const bytes = [];
  let bitBuf = 0, bitCount = 0;
  const emit = (code, size) => {
    bitBuf |= code << bitCount;
    bitCount += size;
    while (bitCount >= 8) { bytes.push(bitBuf & 255); bitBuf >>= 8; bitCount -= 8; }
  };
  let dict = new Map(), next = end + 1, size = minCode + 1;
  emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix * 256 + k;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix, size);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear, size);
      dict = new Map(); next = end + 1; size = minCode + 1;
    }
    prefix = k;
  }
  emit(prefix, size);
  emit(end, size);
  if (bitCount > 0) bytes.push(bitBuf & 255);
  return bytes;
}

// frames: array of RGBA Uint8Array, all width*height. delayMs per frame.
function encodeGif(frames, width, height, delayMs) {
  // Build one global palette from every colour used; fall back to RGB332 if over 256.
  let colors = new Set();
  for (const f of frames) for (let i = 0; i < f.length; i += 4) colors.add((f[i] << 16) | (f[i + 1] << 8) | f[i + 2]);
  let quantized = frames;
  if (colors.size > 256) {
    quantized = frames.map((f) => {
      const g = new Uint8Array(f.length);
      for (let i = 0; i < f.length; i += 4) {
        g[i] = f[i] & 0xe0; g[i + 1] = f[i + 1] & 0xe0; g[i + 2] = f[i + 2] & 0xc0; g[i + 3] = 255;
      }
      return g;
    });
    colors = new Set();
    for (const f of quantized) for (let i = 0; i < f.length; i += 4) colors.add((f[i] << 16) | (f[i + 1] << 8) | f[i + 2]);
  }
  const palette = [...colors];
  const lookup = new Map(palette.map((c, i) => [c, i]));
  let bits = 1;
  while ((1 << bits) < palette.length) bits++;

  const out = [];
  const u16 = (n) => out.push(n & 255, (n >> 8) & 255);
  out.push(...Buffer.from("GIF89a"));
  u16(width); u16(height);
  out.push(0x80 | (7 << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < (1 << bits); i++) {
    const c = palette[i] || 0;
    out.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
  }
  out.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0); // loop forever
  const minCode = Math.max(2, bits);
  for (const f of quantized) {
    out.push(0x21, 0xf9, 4, 0, ...[Math.round(delayMs / 10) & 255, (Math.round(delayMs / 10) >> 8) & 255], 0, 0);
    out.push(0x2c); u16(0); u16(0); u16(width); u16(height); out.push(0);
    out.push(minCode);
    const data = lzw(quantize(f, palette, lookup), minCode);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      out.push(chunk.length, ...chunk);
    }
    out.push(0);
  }
  out.push(0x3b);
  return Buffer.from(out);
}

// ---------- Runner ----------
async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf("--" + name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const outDir = opt("out", "media");
  const scenarioName = opt("scenario", "tour");
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error("Unknown scenario: " + scenarioName + " (have: " + Object.keys(SCENARIOS).join(", ") + ")");
  fs.mkdirSync(outDir, { recursive: true });

  const server = http.createServer((req, res) => {
    if (req.url.split("?")[0] !== "/index.html") { res.writeHead(404).end(); return; }
    res.writeHead(200, { "Content-Type": "text/html" }).end(fs.readFileSync(path.join(__dirname, "..", "index.html")));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port + "/index.html";

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  const canvas = page.locator("#game");
  const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));

  let shots = 0;
  const frames = [];
  let timer = null;
  const grab = async () => {
    const data = await canvas.evaluate((c) => Array.from(c.getContext("2d").getImageData(0, 0, c.width, c.height).data));
    frames.push(Uint8Array.from(data));
  };
  const rec = {
    async start() {
      let busy = false;
      timer = setInterval(async () => {
        if (busy || frames.length >= MAX_GIF_SECONDS * GIF_FPS) return;
        busy = true;
        try { await grab(); } finally { busy = false; }
      }, 1000 / GIF_FPS);
    },
    async stop() { clearInterval(timer); timer = null; }
  };

  const ctx = {
    rec,
    wait: (ms) => page.waitForTimeout(ms),
    debug: () => page.evaluate(() => ({ player: window.__debug.player, enemies: window.__debug.enemies, wave: window.__debug.wave })),
    async tap(tx, ty) {
      const box = await canvas.boundingBox();
      await page.mouse.click(
        box.x + ((tx * 16 + 8) * box.width) / size.w,
        box.y + ((ty * 16 + 8) * box.height) / size.h
      );
    },
    async endTurn() {
      // The End Turn button is drawn in the bottom panel; tap its centre.
      const b = await page.evaluate(() => (typeof BUTTON === "undefined" ? null : BUTTON));
      const box = await canvas.boundingBox();
      if (!b) throw new Error("BUTTON is not reachable from the page; end the turn by tapping every hero instead.");
      await page.mouse.click(
        box.x + ((b.x + b.w / 2) * box.width) / size.w,
        box.y + ((b.y + b.h / 2) * box.height) / size.h
      );
    },
    async shot(name) {
      if (shots >= MAX_SHOTS) throw new Error("Scenario takes more than " + MAX_SHOTS + " screenshots");
      shots++;
      await canvas.screenshot({ path: path.join(outDir, name + ".png") });
    }
  };

  await scenario(ctx);
  await browser.close();
  server.close();
  if (errors.length) throw new Error("Page errors during capture:\n" + errors.join("\n"));

  if (frames.length > 0) {
    fs.writeFileSync(path.join(outDir, scenarioName + ".gif"), encodeGif(frames, size.w, size.h, 1000 / GIF_FPS));
  }
  console.log("Wrote " + shots + " screenshot(s) and " + frames.length + " GIF frame(s) to " + outDir);
}

main().catch((e) => { console.error(e); process.exit(1); });
