#!/usr/bin/env node
// Captures PR media from a built page: at most 3 PNG screenshots and one GIF (<= 20 s).
//
//   node tools/capture.js --page dist/index.html --scenario tests/game/capture.json --out media
//
// The scenario is JSON, not code (format: tools/CAPTURE.md), so the Pages workflow can capture
// any PR with main's copy of this script without running the PR's code outside the browser.
// The game itself runs inside the page's sandboxed frame, in a browser whose only network is a
// dead proxy, so it cannot reach anything either.
//
// Writes <shot>.png files, capture.gif, and manifest.json ({ shots, gif, frames }).

const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("@playwright/test");

const MAX_SHOTS = 3;
const MAX_GIF_SECONDS = 20;
const GIF_FPS = 10;
const MAX_STEPS = 200;
const MAX_TOTAL_WAIT_MS = 60000;
const SHOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEBUG_PATH_RE = /^[A-Za-z_$][\w$]*(\.(?:[A-Za-z_$][\w$]*|\d+))*$/;
const COLS = 16, ROWS = 15; // tiles across the 256x240 canvas, info panel included

// ---------- Scenario format ----------
// { "steps": [ step, ... ] }, where each step has exactly one key:
//   { "tap": [tx, ty] }          tap the centre of a tile
//   { "endTurn": true }          tap the END TURN button
//   { "wait": ms }               pause (0-10000)
//   { "waitFor": { "path": "player.selected", "equals": "knight", "timeout": 5000 } }
//                                wait until window.__debug.<path> === equals
//   { "shot": "name" }           save name.png (at most 3, names unique)
//   { "record": "start" | "stop" } GIF recording (stops by itself at 20 s)
function validateScenario(scenario) {
  const errors = [];
  if (!scenario || typeof scenario !== "object" || !Array.isArray(scenario.steps)) return ["scenario must be { \"steps\": [...] }"];
  const steps = scenario.steps;
  if (steps.length < 1 || steps.length > MAX_STEPS) errors.push(`between 1 and ${MAX_STEPS} steps`);
  let shots = new Set(), waited = 0;
  steps.forEach((step, i) => {
    const at = `step ${i + 1}`;
    const keys = step && typeof step === "object" ? Object.keys(step) : [];
    if (keys.length !== 1) { errors.push(`${at}: needs exactly one key`); return; }
    const [key] = keys, v = step[key];
    const isInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
    if (key === "tap") {
      if (!Array.isArray(v) || v.length !== 2 || !isInt(v[0], 0, COLS - 1) || !isInt(v[1], 0, ROWS - 1)) errors.push(`${at}: tap needs [x 0-${COLS - 1}, y 0-${ROWS - 1}]`);
    } else if (key === "endTurn") {
      if (v !== true) errors.push(`${at}: endTurn must be true`);
    } else if (key === "wait") {
      if (!isInt(v, 0, 10000)) errors.push(`${at}: wait must be 0-10000 ms`);
      else waited += v;
    } else if (key === "waitFor") {
      const equalsOk = v && (v.equals === null || ["string", "number", "boolean"].includes(typeof v.equals));
      const ok = v && typeof v === "object" && typeof v.path === "string" && v.path.length <= 100 && DEBUG_PATH_RE.test(v.path)
        && Object.keys(v).every((k) => ["path", "equals", "timeout"].includes(k)) && equalsOk;
      if (!ok || (typeof v.equals === "string" && v.equals.length > 100)) errors.push(`${at}: waitFor needs { path, equals[, timeout] }`);
      else if (v.timeout !== undefined && !isInt(v.timeout, 1, 10000)) errors.push(`${at}: waitFor timeout must be 1-10000 ms`);
      else waited += v.timeout || 5000;
    } else if (key === "shot") {
      if (typeof v !== "string" || !SHOT_NAME_RE.test(v)) errors.push(`${at}: shot names are lowercase letters, digits and dashes`);
      else if (shots.has(v)) errors.push(`${at}: duplicate shot "${v}"`);
      else shots.add(v);
    } else if (key === "record") {
      if (v !== "start" && v !== "stop") errors.push(`${at}: record must be "start" or "stop"`);
    } else {
      errors.push(`${at}: unknown step "${key}"`);
    }
  });
  if (shots.size > MAX_SHOTS) errors.push(`at most ${MAX_SHOTS} shots`);
  if (waited > MAX_TOTAL_WAIT_MS) errors.push(`waits add up to more than ${MAX_TOTAL_WAIT_MS} ms`);
  return errors;
}

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
function serveFile(file) {
  const body = fs.readFileSync(file);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function capture({ page: pageFile, scenario, outDir }) {
  const errors = validateScenario(scenario);
  if (errors.length) throw new Error("Invalid scenario:\n  " + errors.join("\n  "));
  fs.mkdirSync(outDir, { recursive: true });

  const server = await serveFile(pageFile);
  const url = "http://127.0.0.1:" + server.address().port + "/";
  const browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined,
    // Nothing but the local server is reachable: everything else goes to a closed port.
    proxy: { server: "http://127.0.0.1:9", bypass: "127.0.0.1" }
  });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(url);
    const frame = await (await page.locator("#game-frame").elementHandle()).contentFrame();
    await frame.waitForFunction(() => typeof window.__debug === "object", null, { timeout: 10000 });
    const canvas = frame.locator("canvas").first();
    const size = await canvas.evaluate((c) => ({ w: c.width, h: c.height }));
    // The page is untrusted: keep what it hands back small and well-formed.
    if (![size.w, size.h].every((n) => Number.isInteger(n) && n > 0 && n <= 1024)) throw new Error("canvas size out of range");

    const shots = [];
    const frames = [];
    let timer = null;
    const grab = async () => {
      // base64 is far faster to pass out of the page than an array of numbers.
      const b64 = await canvas.evaluate((c, sz) => {
        const px = c.getContext("2d").getImageData(0, 0, sz.w, sz.h).data;
        let bin = "";
        for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
        return btoa(bin);
      }, size);
      const rgba = new Uint8Array(Buffer.from(String(b64), "base64"));
      if (rgba.length === size.w * size.h * 4) frames.push(rgba);
    };
    const clickCanvasPoint = async (x, y) => {
      const box = await canvas.boundingBox();
      await page.mouse.click(box.x + (x * box.width) / size.w, box.y + (y * box.height) / size.h);
    };

    for (const step of scenario.steps) {
      const [key] = Object.keys(step);
      const v = step[key];
      if (key === "tap") {
        await clickCanvasPoint(v[0] * 16 + 8, v[1] * 16 + 8);
      } else if (key === "endTurn") {
        const b = await frame.evaluate(() => (typeof BUTTON === "object" && BUTTON ? { x: BUTTON.x, y: BUTTON.y, w: BUTTON.w, h: BUTTON.h } : null));
        if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) throw new Error("endTurn: the game has no BUTTON");
        await clickCanvasPoint(b.x + b.w / 2, b.y + b.h / 2);
      } else if (key === "wait") {
        await page.waitForTimeout(v);
      } else if (key === "waitFor") {
        await frame.waitForFunction(
          ({ path: p, equals }) => {
            let cur = window.__debug;
            for (const part of p.split(".")) {
              if (cur === null || cur === undefined) return false;
              cur = cur[part];
            }
            return cur === equals;
          },
          { path: v.path, equals: v.equals },
          { timeout: v.timeout || 5000 }
        );
      } else if (key === "shot") {
        await canvas.screenshot({ path: path.join(outDir, v + ".png") });
        shots.push(v);
      } else if (key === "record") {
        if (v === "start" && !timer) {
          let busy = false;
          timer = setInterval(async () => {
            if (busy || frames.length >= MAX_GIF_SECONDS * GIF_FPS) return;
            busy = true;
            try { await grab(); } catch (e) { /* page closing */ } finally { busy = false; }
          }, 1000 / GIF_FPS);
        } else if (v === "stop") {
          clearInterval(timer);
          timer = null;
        }
      }
    }
    clearInterval(timer);
    if (pageErrors.length) throw new Error("Page errors during capture:\n" + pageErrors.join("\n"));
    if (frames.length > 0) fs.writeFileSync(path.join(outDir, "capture.gif"), encodeGif(frames, size.w, size.h, 1000 / GIF_FPS));
    const manifest = { shots, gif: frames.length > 0, frames: frames.length };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));
    return manifest;
  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => {
    const i = args.indexOf("--" + name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const root = path.join(__dirname, "..");
  const pageFile = opt("page", path.join(root, "dist", "index.html"));
  if (!fs.existsSync(pageFile)) throw new Error(pageFile + " does not exist. Run `python3 tools/build.py` first.");
  const scenario = JSON.parse(fs.readFileSync(opt("scenario", path.join(root, "tests", "game", "capture.json")), "utf8"));
  const outDir = opt("out", "media");
  const m = await capture({ page: pageFile, scenario, outDir });
  console.log("Wrote " + m.shots.length + " screenshot(s) and " + m.frames + " GIF frame(s) to " + outDir);
}

module.exports = { validateScenario, capture };

if (require.main === module) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
