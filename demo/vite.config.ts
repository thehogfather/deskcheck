import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: __dirname,
  server: {
    open: "/standalone.html",
    fs: {
      // Allow Vite to serve files from the project root (parent of demo/)
      // so that imports like "../src/sidepanel/sidepanel.css" resolve.
      allow: [resolve(__dirname, "..")],
    },
  },
});
