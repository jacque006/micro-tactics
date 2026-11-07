// Owner only. Checks the built page itself: the CSP, the script hashes, the sandbox flags, and
// that tools/build.py refuses game.html files that step outside the allowed shape.
const { test, expect } = require("@playwright/test");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const BUILT = path.join(ROOT, "build", "index.html");
const GAME = fs.readFileSync(path.join(ROOT, "game.html"), "utf8");

// The full policy. Changing it means changing tools/build.py and this test together.
const EXPECTED_POLICY = [
  "default-src 'none'",
  "script-src HASH HASH HASH",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
  "webrtc 'block'"
].join("; ");

test.skip(({ browserName }) => browserName !== "chromium", "build checks need no browser; run them once");

function unescapeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function scripts(htmlText) {
  return [...htmlText.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

function hash(text) {
  return "'sha256-" + crypto.createHash("sha256").update(text, "utf8").digest("base64") + "'";
}

function runBuild(gameText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-build-"));
  const game = path.join(dir, "game.html");
  fs.writeFileSync(game, gameText);
  return spawnSync("python3", [path.join(ROOT, "tools", "build.py"), "--game", game, "--out", path.join(dir, "out.html")], { encoding: "utf8" });
}

test("the CSP is the first thing in <head> and is exactly the expected policy", () => {
  const page = fs.readFileSync(BUILT, "utf8");
  const head = /<head>\s*([\s\S]*?)<\/head>/.exec(page)[1];
  const first = /^<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(head);
  expect(first, "CSP meta must come first").not.toBeNull();
  expect(first[1].replace(/'sha256-[A-Za-z0-9+/=]+'/g, "HASH")).toBe(EXPECTED_POLICY);
  expect(page.match(/http-equiv/g)).toHaveLength(1);
});

test("exactly the shell, the preamble and the game script are allowed to run", () => {
  const page = fs.readFileSync(BUILT, "utf8");
  const csp = /content="([^"]*)"/.exec(page)[1];
  const allowed = csp.match(/'sha256-[A-Za-z0-9+/=]+'/g);
  const srcdoc = unescapeAttr(/srcdoc="([^"]*)"/.exec(page)[1]);
  const outer = scripts(page.replace(/srcdoc="[^"]*"/, ""));
  const inner = scripts(srcdoc);
  expect(outer).toHaveLength(1);
  expect(inner).toHaveLength(2);
  expect(allowed.sort()).toEqual([...outer, ...inner].map(hash).sort());
  expect(inner[0]).toContain("var Save =");   // the preamble runs before the game
});

test("the game frame is sandboxed with scripts only", () => {
  const page = fs.readFileSync(BUILT, "utf8");
  const frames = page.match(/<iframe [^>]*>/g);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatch(/ sandbox="allow-scripts" /);
  expect(frames[0]).not.toMatch(/ allow=| src=/);
});

test("builds are reproducible", () => {
  const a = runBuild(GAME);
  const b = runBuild(GAME);
  expect(a.status, a.stderr).toBe(0);
  const out = (r) => fs.readFileSync(/built (\S+)/.exec(r.stdout)[1], "utf8");
  expect(out(a)).toBe(out(b));
});

const rejected = {
  "an extra script": (g) => g.replace("</body>", "<script>1</script></body>"),
  "an external script": (g) => g.replace("</body>", '<script src="x.js"></script></body>'),
  "a link tag": (g) => g.replace("</head>", '<link rel="preconnect" href="https://x.example"></head>'),
  "a base tag": (g) => g.replace("</head>", '<base href="https://x.example/"></head>'),
  "a meta refresh": (g) => g.replace("</head>", '<meta http-equiv="refresh" content="0;url=https://x.example"></head>'),
  "an inline handler": (g) => g.replace('<canvas id="game"', '<canvas onclick="1" id="game"'),
  "an iframe": (g) => g.replace("</body>", '<iframe src="https://x.example"></iframe></body>'),
  "a CSS import": (g) => g.replace("</style>", "@import url(x.css);</style>"),
  "a CSS remote url": (g) => g.replace("</style>", "body { background: url(https://x.example/a.png) }</style>"),
  "a network call": (g) => g.replace('"use strict";', '"use strict"; fetch("/x");'),
  "a URL in a string": (g) => g.replace('"use strict";', '"use strict"; const u = "https://x.example";')
};

for (const [name, mutate] of Object.entries(rejected)) {
  test(`the build refuses game.html with ${name}`, () => {
    const changed = mutate(GAME);
    expect(changed, "the mutation applied").not.toBe(GAME);
    const result = runBuild(changed);
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toMatch(/build failed/);
  });
}
