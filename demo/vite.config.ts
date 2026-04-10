import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  server: {
    open: "/standalone.html",
  },
});
