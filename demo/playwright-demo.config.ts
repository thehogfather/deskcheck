import { defineConfig } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: path.resolve(__dirname),
  testMatch: "capture-demo.ts",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    headless: true,
    video: {
      mode: "on",
      size: { width: 1280, height: 720 },
    },
  },
  outputDir: path.resolve(__dirname, "test-output"),
});
