// Logging proxy for the test browsers (see playwright.config.js). It records the first line of
// every connection and refuses it, so nothing reaches the internet and the security suite can
// see what was attempted. A bare connection with no request (Chrome opens these for
// navigations it is about to block) is logged as "(connection with no request)".
const fs = require("fs");
const net = require("net");
const path = require("path");

const LOG = path.join(__dirname, "..", "..", "build", "proxy.log");
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, "");

net
  .createServer((socket) => {
    let buffer = "";
    let logged = false;
    const log = (line) => {
      if (logged) return;
      logged = true;
      fs.appendFileSync(LOG, line + "\n");
    };
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      const end = buffer.indexOf("\r\n");
      if (end >= 0) {
        log(buffer.slice(0, end));
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      } else if (buffer.length > 8192) {
        log(buffer.slice(0, 200));
        socket.destroy();
      }
    });
    socket.on("close", () => log("(connection with no request)"));
    socket.on("error", () => {});
  })
  .listen(8899, "127.0.0.1", () => console.log("logging proxy on 127.0.0.1:8899"));
