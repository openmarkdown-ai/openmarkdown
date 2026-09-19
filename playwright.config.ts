import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: "http://localhost:5200",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/server.mjs",
    // Product-specific readiness URL: another app on this port must not pass for this one.
    url: "http://localhost:5200/manifest.webmanifest",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
