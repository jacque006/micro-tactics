#!/usr/bin/env node
// Lints the game's script against tools/api-allowlist.json.
//
//   node tools/lint_game.mjs path/to/script.js
//   node tools/lint_game.mjs -            (read the script from stdin; tools/build.py does this)
//
// This is a tripwire, not a wall. The sandboxed frame and the CSP decide what the game can do;
// this check makes a diff that reaches for anything else fail loudly, so a reviewer sees it.
// Rules:
//   1. Every global the script uses is in "globals". Names the script declares are fine.
//   2. No property in "bannedProperties" is read, written or used as an object key.
//   3. document.X only for X in "document"; createElement only with a literal in "createElement".
//   4. No bracket access on a global (document[x]), no import(), import.meta or `with`.
//   5. No URL literals (http:, https:, ws:, file:, //host); data: URIs only of "dataUriTypes".

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
      for (let s = this; s; s = s.parent) if (s.names.has(name)) return true;
      return false;
    }
  }

  function boundNames(pattern, out = []) {
    if (!pattern) return out;
    switch (pattern.type) {
      case "Identifier": out.push(pattern.name); break;
      case "ObjectPattern":
        for (const p of pattern.properties) boundNames(p.type === "RestElement" ? p.argument : p.value, out);
        break;
      case "ArrayPattern": for (const el of pattern.elements) boundNames(el, out); break;
      case "RestElement": boundNames(pattern.argument, out); break;
      case "AssignmentPattern": boundNames(pattern.left, out); break;
    }
    return out;
  }

  // `var` and function declarations belong to the nearest function, wherever they appear.
  function hoist(node, fnScope) {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      for (const d of node.declarations) boundNames(d.id).forEach((n) => fnScope.names.add(n));
    }
    if (node.type === "FunctionDeclaration") {
      fnScope.names.add(node.id.name);
      return;
    }
    if (/Function|Class/.test(node.type)) return;
    for (const child of children(node)) hoist(child, fnScope);
  }

  // let, const, class and functions declared directly in a block belong to that block.
  function declareLexical(statements, scope) {
    for (const s of statements) {
      if (s.type === "VariableDeclaration" && s.kind !== "var") {
        for (const d of s.declarations) boundNames(d.id).forEach((n) => scope.names.add(n));
      } else if ((s.type === "ClassDeclaration" || s.type === "FunctionDeclaration") && s.id) {
        scope.names.add(s.id.name);
      }
    }
  }

  function children(node) {
    const out = [];
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((x) => x && typeof x.type === "string" && out.push(x));
      else if (v && typeof v.type === "string") out.push(v);
    }
    return out;
  }

  // ---------- Checks ----------
  function propertyName(member) {
    if (!member.computed && member.property.type === "Identifier") return member.property.name;
    if (member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
    return null;
  }

  function isFreeGlobal(node, scope, name) {
    return node.type === "Identifier" && (!name || node.name === name) && !scope.has(node.name);
  }

  function checkString(node, text) {
    if (URL_RE.test(text) || PROTOCOL_RELATIVE_RE.test(text)) report(node, `URL in a string: ${JSON.stringify(text.slice(0, 60))}`);
    const data = /^\s*data:([^;,]*)/i.exec(text);
    if (data && !DATA_TYPES.has(data[1].toLowerCase())) report(node, `data: URI of type "${data[1]}" is not allowed`);
  }

  // Patterns appear in declarations (names being bound) and in assignments (existing names
  // being written). Defaults and computed keys are expressions either way.
  function visitPattern(pattern, scope, assigning) {
    if (!pattern) return;
    switch (pattern.type) {
      case "AssignmentPattern": visitPattern(pattern.left, scope, assigning); visit(pattern.right, scope); break;
      case "ObjectPattern":
        for (const p of pattern.properties) {
          if (p.type === "RestElement") visitPattern(p.argument, scope, assigning);
          else {
            if (p.computed) visit(p.key, scope);
            else if (p.key.type === "Identifier" && BANNED.has(p.key.name)) report(p.key, `banned property "${p.key.name}"`);
            visitPattern(p.value, scope, assigning);
          }
        }
        break;
      case "ArrayPattern": pattern.elements.forEach((el) => visitPattern(el, scope, assigning)); break;
      case "RestElement": visitPattern(pattern.argument, scope, assigning); break;
      case "Identifier": if (assigning) visit(pattern, scope); break;
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
    if (fn.type !== "ArrowFunctionExpression") fnScope.names.add("arguments");
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
    if (cls.superClass) visit(cls.superClass, inner);
    for (const member of cls.body.body) {
      if (member.type === "StaticBlock") {
        const s = new Scope(inner, true);
        member.body.forEach((st) => hoist(st, s));
        declareLexical(member.body, s);
        member.body.forEach((st) => visit(st, s));
        continue;
      }
      if (member.computed) visit(member.key, inner);
      else if (member.key.type === "Identifier" && BANNED.has(member.key.name) && member.kind !== "constructor") {
        report(member.key, `banned property "${member.key.name}"`);
      }
      if (member.value) {
        if (member.type === "PropertyDefinition") visit(member.value, new Scope(inner, true));
        else visitFunction(member.value, inner);
      }
    }
  }

  function visit(node, scope) {
    if (!node) return;
    switch (node.type) {
      case "Identifier":
        if (!scope.has(node.name) && !GLOBALS.has(node.name)) report(node, `global "${node.name}" is not in tools/api-allowlist.json`);
        return;
      case "Literal":
        if (typeof node.value === "string") checkString(node, node.value);
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
        if (node.computed) visit(node.property, scope);
        const name = propertyName(node);
        if (name !== null && BANNED.has(name)) report(node.property, `banned property "${name}"`);
        if (node.computed && name === null && isFreeGlobal(node.object, scope)) {
          report(node, `bracket access on global "${node.object.name}"`);
        }
        if (isFreeGlobal(node.object, scope, "document") && name !== null && !DOCUMENT.has(name)) {
          report(node.property, `document.${name} is not in tools/api-allowlist.json`);
        }
        return;
      }
      case "Property":
        if (node.computed) visit(node.key, scope);
        else {
          const key = node.key.type === "Identifier" ? node.key.name : node.key.value;
          if (typeof key === "string" && BANNED.has(key)) report(node.key, `banned property "${key}"`);
        }
        if (node.kind === "get" || node.kind === "set" || node.method) visitFunction(node.value, scope);
        else visit(node.value, scope);
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
        if (node.type === "ForStatement" || (head && head.type === "VariableDeclaration")) visit(head, s);
        else visitPattern(head, s, true);
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
        for (const child of children(node)) visit(child, scope);
    }
  }

  const top = new Scope(null, true);
  hoist(ast, top);
  declareLexical(ast.body, top);
  ast.body.forEach((s) => visit(s, top));
  return errors;
}

// ---------- CLI ----------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node tools/lint_game.mjs <script.js | ->");
    process.exit(2);
  }
  const source = fs.readFileSync(arg === "-" ? 0 : arg, "utf8");
  const errors = lint(source);
  if (errors.length) {
    console.error(`game lint: ${errors.length} problem(s)`);
    for (const e of errors) console.error("  " + e);
    process.exit(1);
  }
  console.log("game lint: OK");
}
