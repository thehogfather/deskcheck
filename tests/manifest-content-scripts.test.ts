// Acceptance test for feature #14 phase 2 — manifest content_scripts entries.
//
// Pins that manifest.json has exactly two content_scripts entries:
//   1. The existing recorder at document_idle
//   2. The new marker-detector at document_start

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("manifest.json content_scripts", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "../manifest.json"), "utf-8")
  );

  it("has exactly two content_scripts entries", () => {
    expect(manifest.content_scripts).toHaveLength(2);
  });

  it("first entry is the recorder at document_idle", () => {
    const recorder = manifest.content_scripts.find(
      (cs: any) => cs.js?.some((j: string) => j.includes("content/index"))
    );
    expect(recorder).toBeDefined();
    expect(recorder.run_at).toBe("document_idle");
  });

  it("second entry is the marker-detector at document_start", () => {
    const detector = manifest.content_scripts.find(
      (cs: any) => cs.js?.some((j: string) => j.includes("marker-detector"))
    );
    expect(detector).toBeDefined();
    expect(detector.run_at).toBe("document_start");
    expect(detector.all_frames).toBe(false);
  });
});
