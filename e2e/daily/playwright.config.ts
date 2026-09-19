import { defineConfig } from "@playwright/test";

// Specs under e2e/daily run in the main suite against the built app on :5200.
// While a feature is being built, run them against your own dev server instead:
//   OM_URL=http://localhost:5224 npx playwright test -c e2e/daily/playwright.config.ts e2e/daily/editor.spec.ts
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.OM_URL ?? "http://localhost:5200",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
