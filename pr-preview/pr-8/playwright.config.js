module.exports = {
  testDir: "./tests",
  use: {
    baseURL: "http://127.0.0.1:8000"
  },
  webServer: {
    command: "python3 -m http.server 8000",
    url: "http://127.0.0.1:8000/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  }
};
