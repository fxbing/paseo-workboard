import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 45_000,
  globalTimeout: 240_000,
  expect: { timeout: 10_000 },
  outputDir: path.resolve(
    process.env.WORKBOARD_HOST_ARTIFACTS ?? "test-results",
    "workboard-ui-results",
  ),
  reporter: "list",
  use: {
    baseURL: process.env.WORKBOARD_BASE_URL,
    browserName: "chromium",
    headless: true,
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
