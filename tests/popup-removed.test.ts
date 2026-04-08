// Acceptance test for feature #8 — Test Level Matrix row #3.
//
// Filesystem-level pin: src/popup/ must not exist after the migration,
// and no source file under src/ may import from src/popup. Prevents a
// future edit from quietly re-introducing popup code.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const repoRoot = resolve(__dirname, "..");
const srcRoot = resolve(repoRoot, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walk(full));
    } else if (
      entry.endsWith(".ts") ||
      entry.endsWith(".tsx") ||
      entry.endsWith(".js") ||
      entry.endsWith(".html") ||
      entry.endsWith(".css")
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("popup directory removal (matrix #3)", () => {
  it("src/popup directory does not exist", () => {
    const popupDir = resolve(srcRoot, "popup");
    expect(existsSync(popupDir)).toBe(false);
  });

  it("no source file imports from src/popup", () => {
    const files = walk(srcRoot);
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      // Match: import ... from "../popup/..." or "./popup/..."
      // and require("./popup/...")
      if (
        /from\s+["']\.{1,2}(\/[^"']*)?\/popup(\/|["'])/.test(content) ||
        /require\(\s*["']\.{1,2}(\/[^"']*)?\/popup(\/|["'])/.test(content)
      ) {
        offenders.push(relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
