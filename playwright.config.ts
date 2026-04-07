import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  workers: 1, // Extensions require serial execution (one persistent context)
  use: {
    headless: false, // Extensions need headed mode for full UI testing
  },
});
