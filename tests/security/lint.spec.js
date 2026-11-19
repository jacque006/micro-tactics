// Owner only. The game lint (tools/lint_game.mjs) is a tripwire: these are the ways around it
// we know of, and code it must keep accepting. Its style rules (braces, explicit semicolons,
// no line continuing the one above, "use strict") apply to every JavaScript file in the repo.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

test.skip(({ browserName }) => browserName !== "chromium", "lint checks need no browser; run them once");

let lint, lintStyle, scriptOf;
test.beforeAll(async () => {
  ({ lint, lintStyle, scriptOf } = await import(path.join(ROOT, "tools", "lint_game.mjs")));
});

const mustFail = {
  "a network call": 'fetch("/x")',
  "the window object": "window.x = 1",
  "globalThis": "globalThis.x",
  "self": "self.x",
  "top-level navigation": 'top.location = "/x"',
  "location": 'location.href = "/x"',
  "assigning location through a pattern": "[location] = ['/x']",
  "a for-of over location": "for (location of []) {}",
  "cookies": "document.cookie",
  "bracket access on document": 'document["coo" + "kie"]',
  "a document method outside the list": 'document.write("x")',
  "creating an iframe": 'document.createElement("iframe")',
  "creating an element from a variable": "const t = 'iframe'; document.createElement(t)",
  "innerHTML": "const el = {}; el.innerHTML = '<b>'",
  "innerHTML as an object key": "Object.assign({}, { innerHTML: '<b>' })",
  "constructor via destructuring": "const { constructor: C } = {}",
  "the Function constructor by property": "const f = (() => 1).constructor",
  "eval": 'eval("1")',
  "Function": 'Function("return 1")',
  "dynamic import": 'import("x")',
  "with": "with ({}) {}",
  "a URL string": 'const u = "https://x.example/"',
  "a protocol-relative URL": 'const u = "//x.example/a"',
  "a URL in a template": "const u = `wss://x.example/${1}`",
  "an HTML data URI": 'const u = "data:text/html,<b>"',
  "reaching the window from an event": 'addEventListener("click", (e) => e.view.fetch)',
  "reaching the window from an element": 'document.body.ownerDocument.defaultView',
  "WebRTC": "new RTCPeerConnection()",
  "storage": "localStorage.x",
  "postMessage": 'const p = {}; p.postMessage("x", "*")',
  "a global shadowed only elsewhere": "function f(fetch) { return fetch; } fetch('/x')"
};

const mustPass = {
  "the current game": null,
  "a DOMRect's top edge": "const r = document.body.getBoundingClientRect(); r.top + r.left",
  "an object with a top field": "const box = { top: 1, parent: null }; box.top",
  "a canvas element": 'const c = document.createElement("canvas"); c.getContext("2d")',
  "a PNG data URI": 'const img = new Image(); img.src = "data:image/png;base64,AAAA"',
  "a local that shares a global's name": "function f(fetch) { return fetch(1); }",
  "class constructors": "class A { constructor() { this.x = 1; } }",
  "the save bridge": 'Save.ready.then(() => Save.set("best", JSON.stringify({ turn: 3 })))',
  "loops and patterns": "for (let i = 0; i < 3; i++) {} for (const [a, b] of [[1, 2]]) {} let x; ({ x } = { x: 1 });"
};

for (const [name, code] of Object.entries(mustFail)) {
  test(`the lint rejects ${name}`, () => {
    expect(lint(code), code).not.toEqual([]);
  });
}

for (const [name, code] of Object.entries(mustPass)) {
  test(`the lint accepts ${name}`, () => {
    const source = code !== null ? code : /<script>([\s\S]*?)<\/script>/.exec(fs.readFileSync(path.join(ROOT, "game.html"), "utf8"))[1];
    expect(lint(source)).toEqual([]);
  });
}

const styleMustFail = {
  "an if without braces": "if (a) b();",
  "an else without braces": "if (a) { b(); } else c();",
  "a for loop without braces": "for (;;) x();",
  "a while loop without braces": "while (a) b();",
  "a do-while without braces": "do x(); while (a);",
  "a missing semicolon": "let a = 1\nlet b = 2;",
  "a return split from its value": "function f() { return\n1; }",
  "a line starting with ( that continues the line above": "const a = b\n(c || d).e();",
  "a line starting with [ that continues the line above": "const a = b\n[1, 2].forEach(f);",
  "a template that continues the line above": "const t = tag\n`x`;"
};

const styleMustPass = {
  "braced branches and else-if chains": "if (a) { b(); } else if (c) { d(); } else { e(); }",
  "a method chain across lines": "a\n  .b()\n  .c();",
  "call arguments across lines": "f(\n  x\n);",
  "a new statement after a semicolon": "const a = b; // fine\n(c || d).e();"
};

for (const [name, code] of Object.entries(styleMustFail)) {
  test(`the style rules reject ${name}`, () => {
    expect(lintStyle(code), code).not.toEqual([]);
  });
}

for (const [name, code] of Object.entries(styleMustPass)) {
  test(`the style rules accept ${name}`, () => {
    expect(lintStyle(code)).toEqual([]);
  });
}

test("a script without \"use strict\" fails where strict mode is required", () => {
  expect(lintStyle("var a = 1;", { requireStrict: true })).not.toEqual([]);
  expect(lintStyle("\"use strict\";\nvar a = 1;", { requireStrict: true })).toEqual([]);
});

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return jsFiles(full);
    }
    // HTML counts when it has a real inline script; shell/shell.html's is only the {{SHELL_JS}}
    // slot, filled from shell/shell.js, which is checked as a file of its own.
    const isPage = entry.name.endsWith(".html") && /<script>(?!\{\{)/.test(fs.readFileSync(full, "utf8"));
    return /\.(js|mjs)$/.test(entry.name) || isPage ? [full] : [];
  });
}

test("every JavaScript file in the repo follows the style rules", () => {
  const files = ["game.html", "playwright.config.js", ...["shell", "tools", "tests"].flatMap((d) => jsFiles(path.join(ROOT, d)))]
    .map((f) => path.resolve(ROOT, f));
  expect(files.length).toBeGreaterThan(10);
  const problems = files.flatMap((f) =>
    lintStyle(scriptOf(f), { sourceType: f.endsWith(".mjs") ? "module" : "script" }).map((e) => `${path.relative(ROOT, f)}:${e}`)
  );
  expect(problems).toEqual([]);
});

test("the game and the shell's scripts run in strict mode", () => {
  for (const f of ["game.html", "shell/shell.js", "shell/preamble.js"]) {
    expect(lintStyle(scriptOf(path.join(ROOT, f)), { requireStrict: true }), f).toEqual([]);
  }
});
