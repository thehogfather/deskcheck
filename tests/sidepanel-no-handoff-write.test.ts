import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { readdir, stat } from "node:fs/promises";

// Feature-14 phase-1 matrix row S19 — defence in depth.
//
// The side panel is the only place in the codebase that calls
// setHandoffConfig / clearHandoffConfig — specifically from the
// "Attach CLI listener" paste row in sidepanel.ts. Any future code
// that needs the same capability must go through that one entry
// point (or extend the affordance), so the attack surface for
// "who can forge a handoff config" stays auditable in a single
// place.
//
// This test pins two invariants:
//   1. The only file under src/sidepanel/ that imports handoff-store
//      is sidepanel.ts (the glue layer).
//   2. No file under src/sidepanel/ contains `config.token` as a
//      DOM write — the token must NEVER be rendered back to the user,
//      so we cannot provide an attacker with an easy exfiltration
//      vector via DevTools DOM inspection.

const SIDEPANEL_DIR = resolve(__dirname, "..", "src", "sidepanel");

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

describe("S19 — side panel handoff-store usage is tightly scoped", () => {
  it("only sidepanel.ts imports handoff-store under src/sidepanel/", async () => {
    const files = await walkFiles(SIDEPANEL_DIR);
    const importers: string[] = [];
    for (const file of files) {
      // Skip test files — tests may reference the store for asserting.
      if (file.endsWith(".test.ts")) continue;
      const contents = await readFile(file, "utf8");
      if (/handoff-store/.test(contents)) {
        importers.push(file.replace(SIDEPANEL_DIR + "/", ""));
      }
    }
    expect(importers).toEqual(["sidepanel.ts"]);
  });

  it("no side panel file renders `config.token` or `handoff.token` to the DOM", async () => {
    const files = await walkFiles(SIDEPANEL_DIR);
    const violations: Array<{ file: string; match: string }> = [];
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const contents = await readFile(file, "utf8");
      // Forbidden substrings — any of these would mean a token value
      // is interpolated into the DOM.
      const needles = [
        "config.token",
        "handoff.token",
        "token: ${",
        "token:${",
      ];
      for (const needle of needles) {
        if (contents.includes(needle)) {
          violations.push({ file, match: needle });
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
