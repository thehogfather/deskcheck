// Acceptance tests for feature #13 — Standalone dogfooding mode.
//
// Pin the structural constraints from the DoD:
//   1. demo entry imports mountSidePanel (reuse, don't copy)
//   2. demo code does not import chrome.* APIs at runtime
//   3. Makefile exposes a "demo" target

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");

describe("feature #13 — standalone dogfooding mode", () => {
  it("demo/standalone-entry.ts imports mountSidePanel from src/sidepanel/sidepanel", () => {
    const entry = resolve(repoRoot, "demo", "standalone-entry.ts");
    expect(existsSync(entry)).toBe(true);
    const content = readFileSync(entry, "utf8");
    expect(content).toMatch(
      /import\s+\{[^}]*mountSidePanel[^}]*\}\s+from\s+["']\.\.\/src\/sidepanel\/sidepanel["']/,
    );
  });

  it("demo/standalone-entry.ts does not reference chrome.* APIs", () => {
    const entry = resolve(repoRoot, "demo", "standalone-entry.ts");
    const content = readFileSync(entry, "utf8");
    // Allow the string "chrome" in comments, but not chrome.runtime / chrome.storage etc.
    const lines = content.split("\n");
    const offending = lines.filter((line) => {
      const trimmed = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      return /\bchrome\.\w+/.test(trimmed);
    });
    expect(offending).toEqual([]);
  });

  it("demo/standalone.html exists and references standalone-entry.ts", () => {
    const html = resolve(repoRoot, "demo", "standalone.html");
    expect(existsSync(html)).toBe(true);
    const content = readFileSync(html, "utf8");
    expect(content).toMatch(/standalone-entry\.ts/);
  });

  it("demo/standalone-entry.ts imports the real sidepanel.css", () => {
    const entry = resolve(repoRoot, "demo", "standalone-entry.ts");
    const content = readFileSync(entry, "utf8");
    expect(content).toMatch(/import\s+["']\.\.\/src\/sidepanel\/sidepanel\.css["']/);
  });

  it("Makefile has a demo target", () => {
    const makefile = resolve(repoRoot, "Makefile");
    const content = readFileSync(makefile, "utf8");
    expect(content).toMatch(/^demo:/m);
  });
});
