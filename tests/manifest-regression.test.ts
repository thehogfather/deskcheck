// Acceptance tests for feature #8 — Test Level Matrix rows #1, #3.
//
// Pins the manifest shape so a future edit cannot silently re-introduce
// the popup or drop the side panel registration. Build-level test: only
// reads files, no Chrome runtime needed.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(__dirname, "..", "manifest.json");
const packagePath = resolve(__dirname, "..", "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const pkg = JSON.parse(readFileSync(packagePath, "utf8"));

describe("manifest.json side panel registration (matrix #1)", () => {
  it("declares side_panel.default_path pointing at src/sidepanel/index.html", () => {
    expect(manifest.side_panel).toBeDefined();
    expect(manifest.side_panel.default_path).toBe("src/sidepanel/index.html");
  });

  it("includes the sidePanel permission", () => {
    expect(manifest.permissions).toContain("sidePanel");
  });

  it("retains the existing core permissions", () => {
    for (const p of ["debugger", "storage", "tabs", "scripting"]) {
      expect(manifest.permissions).toContain(p);
    }
  });
});

describe("manifest.json popup removal (matrix #3)", () => {
  it("does not declare action.default_popup", () => {
    if (manifest.action) {
      expect(manifest.action.default_popup).toBeUndefined();
    }
  });
});

describe("manifest.json + package.json version match", () => {
  it("manifest version equals package.json version", () => {
    expect(manifest.version).toBe(pkg.version);
  });
});
