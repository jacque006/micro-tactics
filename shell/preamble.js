// Runs inside the sandboxed game frame, before the game's own script. It is part of the
// sandbox, not the game, so only the owner changes it.
"use strict";

// 1. Remove the network APIs that CSP cannot block. WebRTC ignores connect-src, and no
//    browser enforces CSP's webrtc directive yet. Game code cannot get fresh copies from a new
//    iframe: this frame has an opaque origin, so any child frame is cross-origin to it.
(function () {
  var names = Object.getOwnPropertyNames(window);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!/^(webkit|moz)?RTC/.test(name) && name !== "WebTransport") continue;
    try {
      delete window[name];
    } catch (e) {
      // Not deletable in this browser: overwrite it instead.
    }
    if (typeof window[name] !== "undefined") {
      Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false });
    }
  }
})();

// 2. Remove the clipboard. A tap is a user gesture, and some browsers (WebKit for the async API,
//    Chrome for execCommand) let a sandboxed frame write the clipboard on one. A game could then
//    plant a command for the player to paste. Copy and cut handlers are cut off for the same reason.
(function () {
  var names = Object.getOwnPropertyNames(window);
  for (var i = 0; i < names.length; i++) {
    if (/^Clipboard/.test(names[i])) {
      try { delete window[names[i]]; } catch (e) {}
    }
  }
  try { delete Navigator.prototype.clipboard; } catch (e) {}
  if (typeof navigator.clipboard !== "undefined") {
    Object.defineProperty(navigator, "clipboard", { value: undefined, writable: false, configurable: false });
  }
  Object.defineProperty(Document.prototype, "execCommand", {
    value: function () { return false; }, writable: false, configurable: false
  });
  function block(ev) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  window.addEventListener("copy", block, true);
  window.addEventListener("cut", block, true);
})();

// 3. Save: the game's only persistent storage, backed by the page around this frame.
//    Keys: letters, digits, "_", "." or "-", at most 64 characters. Values: strings
//    (use JSON.stringify), at most 64 KB each and 256 KB in total. Read after `await Save.ready`.
//    Save.persistent is false where the browser gives the page no storage, so progress is
//    lost on reload.
var Save = (function () {
  var data = Object.create(null);
  var persistent = false;
  var inShell = window.parent !== window;

  var ready = new Promise(function (resolve) {
    if (!inShell) {
      resolve();
      return;
    }
    window.addEventListener("message", function onMessage(ev) {
      if (ev.source !== window.parent || !ev.data || ev.data.mt !== "snapshot") return;
      window.removeEventListener("message", onMessage);
      var incoming = ev.data.data || {};
      for (var key in incoming) {
        // Writes made before the snapshot arrived win.
        if (typeof incoming[key] === "string" && !(key in data)) data[key] = incoming[key];
      }
      persistent = ev.data.persistent === true;
      resolve();
    });
    window.parent.postMessage({ mt: "ready" }, "*");
  });

  function send(message) {
    if (inShell) window.parent.postMessage(message, "*");
  }

  return Object.freeze({
    ready: ready,
    get persistent() { return persistent; },
    get: function (key) { return key in data ? data[key] : null; },
    set: function (key, value) {
      key = String(key);
      value = String(value);
      data[key] = value;
      send({ mt: "set", key: key, value: value });
    },
    remove: function (key) {
      key = String(key);
      delete data[key];
      send({ mt: "remove", key: key });
    },
    keys: function () { return Object.keys(data); }
  });
})();
