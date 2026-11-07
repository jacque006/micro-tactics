// Two suites:
//   tests/game      gameplay checks. The agent may add and change these.
//   tests/security  sandbox, CSP, build and lint checks. Owner only.
//
// Before the tests, tests/prepare.py builds the game and the sandbox canary into build/.
// Every browser sends all traffic except the local test servers to a logging proxy that refuses
// it (tests/security/proxy.js), so no test can reach the internet and the security suite can
// see what was attempted.
//
// Locally you can point Chromium at an installed Chrome: PW_CHROMIUM_EXECUTABLE=/path/to/chrome
const { defineConfig } = require("@playwright/test");

const chromiumPath = process.env.PW_CHROMIUM_EXECUTABLE;

module.exports = defineConfig({
  testDir: "./tests",
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:8000",
    proxy: { server: "http://127.0.0.1:8899", bypass: "127.0.0.1,localhost" }
  },
  webServer: [
    {
      command: "node tests/security/proxy.js",
      port: 8899,
      reuseExistingServer: false
    },
    {
      command: "python3 tests/prepare.py && python3 -m http.server 8000 --bind 127.0.0.1 --directory build",
      url: "http://127.0.0.1:8000/index.html",
      reuseExistingServer: false,
      timeout: 120000
    },
    {
      // A second origin, for pages that embed the game from "another site".
      command: "python3 -m http.server 8001 --bind 127.0.0.1 --directory build",
      url: "http://127.0.0.1:8001/host/plain.html",
      reuseExistingServer: false,
      timeout: 120000
    }
  ],
  projects: [
    { name: "chromium", use: { browserName: "chromium", launchOptions: chromiumPath ? { executablePath: chromiumPath } : {} } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } }
  ]
});
