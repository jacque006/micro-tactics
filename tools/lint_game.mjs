#!/usr/bin/env node
// Two checks on JavaScript, both run by tools/build.py on the game's script:
//
//   node tools/lint_game.mjs path/to/script.js     game script: API allowlist + style
//   node tools/lint_game.mjs -                     the same, reading stdin (tools/build.py)
//   node tools/lint_game.mjs --style FILE...       style only (tests run this on every JS file)
//
// 1. API allowlist (lint). A tripwire, not a wall: the sandboxed frame and the CSP decide what
//    the game can do; this makes a diff that reaches for anything else fail loudly in review.
//    a. Every global the script uses is in tools/api-allowlist.json "globals". Names the script
//       declares are fine.
//    b. No property in "bannedProperties" is read, written or used as an object key.
//    c. document.X only for X in "document"; createElement only with a literal in "createElement".
//    d. No bracket access on a global (document[x]), no import(), import.meta or `with`.
//    e. No URL literals (http:, https:, ws:, file:, //host); data: URIs only of "dataUriTypes".
//
// 2. Style (lintStyle). Correctness, not security: check 1 reads the parsed syntax tree, so
//    layout can't hide anything from it. These catch code that a browser parses differently
//    from how a person reads it (see https://eslint.style/rules/semi and
//    https://eslint.org/docs/latest/rules/no-unexpected-multiline):
//    a. curly      if / else / for / while / do bodies are always { blocks }.
//    b. semi       every statement ends in an explicit ";"; nothing relies on automatic
//                  semicolon insertion (ASI).
//    c. multiline  a line can't start with "(", "[" or "`" that continues the line above.
//    d. strict     the script starts with "use strict" (the game and the shell scripts).

import fs from "node:fs";
import * as acorn from "acorn";

const allow = JSON.parse(fs.readFileSync(new URL("./api-allowlist.json", import.meta.url), "utf8"));
const GLOBALS = new Set(allow.globals);
const DOCUMENT = new Set(allow.document);
const CREATABLE = new Set(allow.createElement);
const BANNED = new Set(allow.bannedProperties);
const DATA_TYPES = new Set(allow.dataUriTypes);
const URL_RE = /\b(?:https?|wss?|ftp|file|blob|javascript):/i;
const PROTOCOL_RELATIVE_RE = /^\s*\/\/[^\s/]/;

function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") {
      continue;
    }
    const v = node[key];
    if (Array.isArray(v)) {
      v.forEach((x) => {
        if (x && typeof x.type === "string") {
          out.push(x);
        }
      });
    } else if (v && typeof v.type === "string") {
      out.push(v);
    }
  }
  return out;
}

export function lint(source) {
  const errors = [];
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true });
  } catch (e) {
    return [`syntax error: ${e.message}`];
  }
  const report = (node, message) => errors.push(`${node.loc.start.line}:${node.loc.start.column + 1} ${message}`);

  // ---------- Scopes ----------
  class Scope {
    constructor(parent, isFunction) {
      this.parent = parent;
      this.isFunction = isFunction;
      this.names = new Set();
    }
    has(name) {
      for (let s = this; s; s = s.parent) { if (s.names.has(name)) { return true; } }
      return false;
    }
  }

  function boundNames(pattern, out = []) {
    if (!pattern) { return out; }
    switch (pattern.type) {
      case "Identifier": out.push(pattern.name); break;
      case "ObjectPattern":
        for (const p of pattern.properties) { boundNames(p.type === "RestElement" ? p.argument : p.value, out); }
        break;
      case "ArrayPattern": for (const el of pattern.elements) { boundNames(el, out); } break;
      case "RestElement": boundNames(pattern.argument, out); break;
      case "AssignmentPattern": boundNames(pattern.left, out); break;
    }
    return out;
  }

  // `var` and function declarations belong to the nearest function, wherever they appear.
  function hoist(node, fnScope) {
    if (!node || typeof node.type !== "string") { return; }
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const d of node.declarations) { boundNames(d.id).forEach((n) => fnScope.names.add(n)); }
    }
    if (node.type === "FunctionDeclaration") {
      fnScope.names.add(node.id.name);
      return;
    }
    if (/Function|Class/.test(node.type)) { return; }
    for (const child of children(node)) { hoist(child, fnScope); }
  }

  // let, const, class and functions declared directly in a block belong to that block.
  function declareLexical(statements, scope) {
    for (const s of statements) {
      if (s.type === "VariableDeclaration" && s.kind !== "var") {
        for (const d of s.declarations) { boundNames(d.id).forEach((n) => scope.names.add(n)); }
      } else if ((s.type === "ClassDeclaration" || s.type === "FunctionDeclaration") && s.id) {
        scope.names.add(s.id.name);
      }
    }
  }

  const children = childNodes;

  // ---------- Checks ----------
  function propertyName(member) {
    if (!member.computed && member.property.type === "Identifier") { return member.property.name; }
    if (member.property.type === "Literal" && typeof member.property.value === "string") { return member.property.value; }
    return null;
  }

  function isFreeGlobal(node, scope, name) {
    return node.type === "Identifier" && (!name || node.name === name) && !scope.has(node.name);
  }

  function checkString(node, text) {
    if (URL_RE.test(text) || PROTOCOL_RELATIVE_RE.test(text)) { report(node, `URL in a string: ${JSON.stringify(text.slice(0, 60))}`); }
    const data = /^\s*data:([^;,]*)/i.exec(text);
    if (data && !DATA_TYPES.has(data[1].toLowerCase())) { report(node, `data: URI of type "${data[1]}" is not allowed`); }
  }

  // Patterns appear in declarations (names being bound) and in assignments (existing names
  // being written). Defaults and computed keys are expressions either way.
  function visitPattern(pattern, scope, assigning) {
    if (!pattern) { return; }
    switch (pattern.type) {
      case "AssignmentPattern": visitPattern(pattern.left, scope, assigning); visit(pattern.right, scope); break;
      case "ObjectPattern":
        for (const p of pattern.properties) {
          if (p.type === "RestElement") { visitPattern(p.argument, scope, assigning); }
          else {
            if (p.computed) { visit(p.key, scope); }
            else if (p.key.type === "Identifier" && BANNED.has(p.key.name)) { report(p.key, `banned property "${p.key.name}"`); }
            visitPattern(p.value, scope, assigning);
          }
        }
        break;
      case "ArrayPattern": pattern.elements.forEach((el) => visitPattern(el, scope, assigning)); break;
      case "RestElement": visitPattern(pattern.argument, scope, assigning); break;
      case "Identifier": if (assigning) { visit(pattern, scope); } break;
      default: visit(pattern, scope);   // member expressions used as assignment targets
    }
  }

  function visitFunction(fn, scope) {
    let outer = scope;
    if (fn.type === "FunctionExpression" && fn.id) {
      outer = new Scope(scope, false);
      outer.names.add(fn.id.name);
    }
    const fnScope = new Scope(outer, true);
    if (fn.type !== "ArrowFunctionExpression") { fnScope.names.add("arguments"); }
    fn.params.forEach((p) => boundNames(p).forEach((n) => fnScope.names.add(n)));
    fn.params.forEach((p) => visitPattern(p, fnScope, false));
    if (fn.body.type === "BlockStatement") {
      hoist(fn.body, fnScope);
      declareLexical(fn.body.body, fnScope);
      fn.body.body.forEach((s) => visit(s, fnScope));
    } else {
      visit(fn.body, fnScope);
    }
  }

  function visitClass(cls, scope) {
    let inner = scope;
    if (cls.id) {
      inner = new Scope(scope, false);
      inner.names.add(cls.id.name);
    }
    if (cls.superClass) { visit(cls.superClass, inner); }
    for (const member of cls.body.body) {
      if (member.type === "StaticBlock") {
        const s = new Scope(inner, true);
        member.body.forEach((st) => hoist(st, s));
        declareLexical(member.body, s);
        member.body.forEach((st) => visit(st, s));
        continue;
      }
      if (member.computed) { visit(member.key, inner); }
      else if (member.key.type === "Identifier" && BANNED.has(member.key.name) && member.kind !== "constructor") {
        report(member.key, `banned property "${member.key.name}"`);
      }
      if (member.value) {
        if (member.type === "PropertyDefinition") { visit(member.value, new Scope(inner, true)); }
        else { visitFunction(member.value, inner); }
      }
    }
  }

  function visit(node, scope) {
    if (!node) { return; }
    switch (node.type) {
      case "Identifier":
        if (!scope.has(node.name) && !GLOBALS.has(node.name)) { report(node, `global "${node.name}" is not in tools/api-allowlist.json`); }
        return;
      case "Literal":
        if (typeof node.value === "string") { checkString(node, node.value); }
        return;
      case "TemplateElement":
        checkString(node, node.value.cooked || node.value.raw);
        return;
      case "ImportExpression":
        report(node, "import() is not allowed");
        return;
      case "MetaProperty":
        report(node, `${node.meta.name}.${node.property.name} is not allowed`);
        return;
      case "WithStatement":
        report(node, "`with` is not allowed");
        return;
      case "MemberExpression": {
        visit(node.object, scope);
        if (node.computed) { visit(node.property, scope); }
        const name = propertyName(node);
        if (name !== null && BANNED.has(name)) { report(node.property, `banned property "${name}"`); }
        if (node.computed && name === null && isFreeGlobal(node.object, scope)) {
          report(node, `bracket access on global "${node.object.name}"`);
        }
        if (isFreeGlobal(node.object, scope, "document") && name !== null && !DOCUMENT.has(name)) {
          report(node.property, `document.${name} is not in tools/api-allowlist.json`);
        }
        return;
      }
      case "Property":
        if (node.computed) { visit(node.key, scope); }
        else {
          const key = node.key.type === "Identifier" ? node.key.name : node.key.value;
          if (typeof key === "string" && BANNED.has(key)) { report(node.key, `banned property "${key}"`); }
        }
        if (node.kind === "get" || node.kind === "set" || node.method) { visitFunction(node.value, scope); }
        else { visit(node.value, scope); }
        return;
      case "CallExpression":
      case "NewExpression": {
        visit(node.callee, scope);
        node.arguments.forEach((a) => visit(a, scope));
        const callee = node.callee;
        if (callee.type === "MemberExpression" && propertyName(callee) === "createElement") {
          const arg = node.arguments[0];
          if (!arg || arg.type !== "Literal" || !CREATABLE.has(String(arg.value).toLowerCase())) {
            report(node, `createElement only for: ${[...CREATABLE].join(", ")}`);
          }
        }
        return;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        visitFunction(node, scope);
        return;
      case "ClassDeclaration":
      case "ClassExpression":
        visitClass(node, scope);
        return;
      case "VariableDeclaration":
        for (const d of node.declarations) {
          visitPattern(d.id, scope, false);
          visit(d.init, scope);
        }
        return;
      case "BlockStatement":
      case "StaticBlock": {
        const s = new Scope(scope, false);
        declareLexical(node.body, s);
        node.body.forEach((st) => visit(st, s));
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const s = new Scope(scope, false);
        const head = node.type === "ForStatement" ? node.init : node.left;
        if (head && head.type === "VariableDeclaration" && head.kind !== "var") {
          head.declarations.forEach((d) => boundNames(d.id).forEach((n) => s.names.add(n)));
        }
        if (node.type === "ForStatement" || (head && head.type === "VariableDeclaration")) { visit(head, s); }
        else { visitPattern(head, s, true); }
        visit(node.test, s);
        visit(node.update, s);
        visit(node.right, s);
        visit(node.body, s);
        return;
      }
      case "SwitchStatement": {
        visit(node.discriminant, scope);
        const s = new Scope(scope, false);
        node.cases.forEach((c) => declareLexical(c.consequent, s));
        node.cases.forEach((c) => { visit(c.test, s); c.consequent.forEach((st) => visit(st, s)); });
        return;
      }
      case "CatchClause": {
        const s = new Scope(scope, false);
        boundNames(node.param).forEach((n) => s.names.add(n));
        visitPattern(node.param, s, false);
        visit(node.body, s);
        return;
      }
      case "AssignmentExpression":
        visitPattern(node.left, scope, true);
        visit(node.right, scope);
        return;
      case "LabeledStatement":
        visit(node.body, scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      default:
        for (const child of children(node)) { visit(child, scope); }
    }
  }

  const top = new Scope(null, true);
  hoist(ast, top);
  declareLexical(ast.body, top);
  ast.body.forEach((s) => visit(s, top));
  return errors;
}

// ---------- Style ----------
export function lintStyle(source, { requireStrict = false, sourceType = "script" } = {}) {
  const errors = [];
  const at = (index) => {
    const pos = acorn.getLineInfo(source, index);
    return `${pos.line}:${pos.column + 1}`;
  };
  let ast;
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType,
      locations: true,
      onInsertedSemicolon: (pos) => errors.push(`${at(pos)} missing semicolon (relies on automatic insertion)`)
    });
  } catch (e) {
    return [`syntax error: ${e.message}`];
  }

  // From `index`, skip whitespace, comments and the closing parens of a parenthesized
  // expression. Returns the next character and whether a line break came before it.
  function next(index) {
    let i = index;
    let newline = false;
    while (i < source.length) {
      const c = source[i];
      if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") {
        newline = true;
        i++;
      } else if (/\s/.test(c)) {
        i++;
      } else if (source.startsWith("//", i)) {
        const end = source.indexOf("\n", i);
        i = end < 0 ? source.length : end;
      } else if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        const stop = end < 0 ? source.length : end + 2;
        if (/[\n\r\u2028\u2029]/.test(source.slice(i, stop))) {
          newline = true;
        }
        i = stop;
      } else if (c === ")") {
        newline = false;
        i++;
      } else {
        return { char: c, index: i, newline };
      }
    }
    return { char: "", index: i, newline };
  }

  function continuesLine(afterIndex, opener, what) {
    const n = next(afterIndex);
    if (n.char === opener && n.newline) {
      errors.push(`${at(n.index)} line starts with "${opener}", which continues ${what} on the line above; end that line with ";" or join the lines`);
    }
  }

  function needsBlock(body, what) {
    if (body && body.type !== "BlockStatement") {
      errors.push(`${at(body.start)} ${what} body needs { braces }`);
    }
  }

  (function walk(node) {
    switch (node.type) {
      case "IfStatement":
        needsBlock(node.consequent, "if");
        if (node.alternate && node.alternate.type !== "IfStatement") {
          needsBlock(node.alternate, "else");
        }
        break;
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement":
        needsBlock(node.body, "loop");
        break;
      case "CallExpression":
        if (!node.optional) {
          continuesLine(node.callee.end, "(", "an expression");
        }
        break;
      case "MemberExpression":
        if (node.computed && !node.optional) {
          continuesLine(node.object.end, "[", "an expression");
        }
        break;
      case "TaggedTemplateExpression":
        continuesLine(node.tag.end, "`", "an expression");
        break;
    }
    childNodes(node).forEach(walk);
  })(ast);

  if (requireStrict) {
    const first = ast.body[0];
    if (!first || first.directive !== "use strict") {
      errors.push('1:1 the script must start with "use strict";');
    }
  }
  return errors;
}

// Returns the JavaScript in a file: the whole file, or the <script> of an HTML file.
export function scriptOf(path) {
  const text = fs.readFileSync(path, "utf8");
  if (!path.endsWith(".html")) {
    return text;
  }
  const match = /<script>([\s\S]*?)<\/script>/.exec(text);
  return match ? match[1] : "";
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: node tools/lint_game.mjs <script.js | -> | --style FILE...");
    process.exit(2);
  }
  let failed = false;
  const show = (label, errors) => {
    if (errors.length) {
      failed = true;
      console.error(`${label}: ${errors.length} problem(s)`);
      for (const e of errors) {
        console.error("  " + e);
      }
    }
  };
  if (args[0] === "--style") {
    for (const file of args.slice(1)) {
      show(`style ${file}`, lintStyle(scriptOf(file), { sourceType: file.endsWith(".mjs") ? "module" : "script" }));
    }
  } else {
    const source = args[0] === "-" ? fs.readFileSync(0, "utf8") : scriptOf(args[0]);
    show("game lint", lint(source));
    show("game style", lintStyle(source, { requireStrict: true }));
  }
  if (failed) {
    process.exit(1);
  }
  console.log("lint: OK");
}
