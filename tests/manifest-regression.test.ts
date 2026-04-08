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
  it("does NOT declare side_panel.default_path", () => {
    // Per GoogleChrome/chrome-extensions-samples#987, having a
    // global default_path causes Chrome to create a global panel
    // that overrides per-tab setOptions and ignores the documented
    // tab-switch hide/show behaviour. The panel is configured
    // exclusively via per-tab setOptions in service-worker.ts, and
    // the sidepanel HTML is bundled via vite-plugin-web-extension's
    // additionalInputs option.
    expect(manifest.side_panel).toBeUndefined();
  });

  it("lists the sidepanel HTML as a web-accessible resource", () => {
    // Without default_path the sidepanel HTML needs to be in
    // web_accessible_resources so the extension can navigate to it
    // (used by the e2e debug spec to synthesize a user gesture for
    // sidePanel.open).
    const war = manifest.web_accessible_resources;
    expect(war).toBeDefined();
    const resources = (war as { resources: string[] }[]).flatMap(
      (r) => r.resources,
    );
    expect(resources).toContain("src/sidepanel/index.html");
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
