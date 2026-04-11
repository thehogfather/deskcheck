import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readdir, stat } from "node:fs/promises";

// Feature-14 phase-1 matrix row S18 — defence in depth.
//
// Content scripts run in untrusted page origins. They MUST NOT be able
// to write the handoff-store key — a malicious page could otherwise
// attach its own listener URL mid-session and exfiltrate the next
// export. This test proves the import graph structurally prevents it
// by asserting that no file under src/content/ references the
// handoff-store module at all.
//
// If future feature work needs content-side handoff awareness, change
// the architecture (e.g., route through the service worker) rather
// than lifting this guard.

const CONTENT_DIR = resolve(__dirname, "..", "src", "content");
const FORBIDDEN_IMPORTS = [
  "handoff-store",
  "handoff-post",
  // "handoff" (the pure helpers module) is not imported by content
  // either in phase 1. If a future feature needs isValidLoopbackUrl
  // on the content side, remove the entry below after review.
  "lib/handoff\"",
  "lib/handoff'",
];

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (info.isFile() && (full.endsWith(".ts") || full.endsWith(".tsx"))) {
      out.push(full);
    }
  }
  return out;
}

describe("S18 — content script does not import handoff-store", () => {
  it("no file under src/content/ references handoff-store or handoff-post", async () => {
    const files = await walkFiles(CONTENT_DIR);
    expect(files.length).toBeGreaterThan(0); // sanity — src/content/ is not empty

    const violations: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      const contents = await readFile(file, "utf8");
      for (const needle of FORBIDDEN_IMPORTS) {
        if (contents.includes(needle)) {
          violations.push({ file, match: needle });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
