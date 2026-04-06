/// <reference types="vitest" />
import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
    exclude: ["e2e/**", "node_modules/**"],
  },
});
