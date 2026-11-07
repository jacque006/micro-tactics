// Runs in the outer page. It is the only code that touches real storage: the game runs in a
// sandboxed frame with an opaque origin and asks for saves over postMessage (see preamble.js).
"use strict";
(function () {
  var frame = document.getElementById("game-frame");
  var prefix = "mt:" + frame.getAttribute("data-namespace") + ":";
  var KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
  var MAX_KEYS = 64;
  var MAX_VALUE = 65536;   // characters per value
  var MAX_TOTAL = 262144;  // characters across all of this game's values

  // localStorage throws when this page is itself sandboxed or storage is disabled.
  // Saves then last only as long as the page.
  var store = null;
  try {
    store = window.localStorage;
    store.setItem(prefix + "probe", "1");
    store.removeItem(prefix + "probe");
  } catch (e) {
    store = null;
  }
  var memory = Object.create(null);

  function readAll() {
    var out = Object.create(null);
    if (!store) {
      for (var k in memory) out[k] = memory[k];
      return out;
    }
    for (var i = 0; i < store.length; i++) {
      var full = store.key(i);
      if (full.indexOf(prefix) !== 0) continue;
      var key = full.slice(prefix.length);
      if (KEY_RE.test(key)) out[key] = store.getItem(full);
    }
    return out;
  }

  function fits(data) {
    var keys = Object.keys(data);
    var total = 0;
    for (var i = 0; i < keys.length; i++) total += keys[i].length + data[keys[i]].length;
    return keys.length <= MAX_KEYS && total <= MAX_TOTAL;
  }

  function write(key, value) {
    var data = readAll();
    if (value === null) delete data[key];
    else data[key] = value;
    if (!fits(data)) return;   // over the quota: drop the write
    if (!store) {
      if (value === null) delete memory[key];
      else memory[key] = value;
      return;
    }
    try {
      if (value === null) store.removeItem(prefix + key);
      else store.setItem(prefix + key, value);
    } catch (e) {
      // Browser quota exceeded; the game keeps its in-memory copy.
    }
  }

  window.addEventListener("message", function (ev) {
    // Only the frame this page created may talk to the bridge.
    if (ev.source !== frame.contentWindow) return;
    var m = ev.data;
    if (!m || typeof m !== "object") return;
    var validKey = typeof m.key === "string" && KEY_RE.test(m.key);
    if (m.mt === "ready") {
      var snapshot = readAll();
      var plain = {};
      for (var k in snapshot) plain[k] = snapshot[k];
      frame.contentWindow.postMessage({ mt: "snapshot", data: plain, persistent: store !== null }, "*");
    } else if (m.mt === "set" && validKey && typeof m.value === "string" && m.value.length <= MAX_VALUE) {
      write(m.key, m.value);
    } else if (m.mt === "remove" && validKey) {
      write(m.key, null);
    }
  });
})();
