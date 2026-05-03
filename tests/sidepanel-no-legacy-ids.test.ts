// Feature-17 acceptance — DoD-8.
//
// Static safety net for the test-id rename. After this feature ships,
// the literals `stop-btn`, `discard-btn`, and `reset-btn` must be absent
// from the production source under src/, the test suite under tests/,
// and the e2e suite under e2e/, modulo a small allow-list of historical
// references (the roadmap, this plan, the architecture changelog).
//
// This test scans the repo with no build dependency and is the
// fast-feedback regression net for the rename migration.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(__dirname, "..");

const SCAN_DIRS = ["src", "tests", "e2e", "cli"];

const FORBIDDEN_LITERALS = ["stop-btn", "discard-btn", "reset-btn"];

// Files where these literals are expected (historical references in
// docs / plans / changelog). Paths relative to the repo root.
const ALLOW_LIST = new Set<string>([
  "tests/sidepanel-no-legacy-ids.test.ts",
]);

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      // Skip node_modules, dist, .git, and similar.
      if (
        entry === "node_modules" ||
        entry === "dist" ||
        entry === ".git" ||
        entry === "test-output" ||
        entry === "__fixtures__"
      ) {
        continue;
      }
      out.push(...walk(full));
    } else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".mjs") ||
      entry.endsWith(".js") ||
      entry.endsWith(".tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("feature-17 DoD-8 — no legacy lifecycle test ids in source/tests/e2e/cli", () => {
  it("zero references to stop-btn / discard-btn / reset-btn outside the allow-list", () => {
    const files: string[] = [];
    for (const d of SCAN_DIRS) {
      try {
        files.push(...walk(join(REPO_ROOT, d)));
      } catch {
        // Directory may not exist in this checkout; skip.
      }
    }

    const offenders: { file: string; literal: string; line: string }[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      if (ALLOW_LIST.has(rel)) continue;
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const lit of FORBIDDEN_LITERALS) {
          if (line.includes(lit)) {
            offenders.push({ file: rel, literal: lit, line: line.trim() });
          }
        }
      }
    }

    expect(
      offenders,
      `Legacy lifecycle test ids must be removed:\n${offenders
        .map((o) => `  ${o.file}: ${o.literal}\n    ${o.line}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});
