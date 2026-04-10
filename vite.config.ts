/// <reference types="vitest" />
import { defineConfig } from "vite";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  plugins: [
    webExtension({
      manifest: "manifest.json",
      // src/sidepanel/index.html is not referenced directly in the
      // manifest (default_path points at the stub default.html so
      // per-tab setOptions can use a distinct path and avoid Chrome's
      // "different panel instance" trap), so we list it as an extra
      // input here to make sure vite still bundles it.
      additionalInputs: ["src/sidepanel/index.html"],
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: "node",
    exclude: ["e2e/**", "node_modules/**", ".claude/**"],
  },
});
