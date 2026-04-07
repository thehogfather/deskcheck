// Acceptance test for feature #8 — Test Level Matrix row #16.
//
// PRIVACY INVARIANT: the side panel UI must never call privileged
// Chrome APIs directly. All capture must go through the service worker
// (which already enforces the canCaptureRecordedTab gate from feature #2).
//
// This grep-style test pins the rule so a future edit cannot bypass the
// service-worker chokepoint by calling chrome.tabs.captureVisibleTab,
// chrome.debugger, or chrome.scripting from the side panel surface.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const repoRoot = resolve(__dirname, "..");
const sidepanelDir = resolve(repoRoot, "src", "sidepanel");

const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "chrome.tabs.captureVisibleTab", re: /chrome\.tabs\.captureVisibleTab/ },
  { name: "chrome.debugger", re: /chrome\.debugger\b/ },
  { name: "chrome.scripting", re: /chrome\.scripting\b/ },
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx") || entry.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

describe("src/sidepanel/** forbidden API check (matrix #16)", () => {
  it("src/sidepanel directory exists", () => {
    expect(existsSync(sidepanelDir)).toBe(true);
  });

  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`does not reference ${pattern.name}`, () => {
      const files = walk(sidepanelDir);
      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        if (pattern.re.test(content)) {
          offenders.push(relative(repoRoot, file));
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
