// Acceptance tests for feature #14 phase 2 — Chrome launcher.
//
// Pins findChrome probe order, spawn flag list for --profile isolated,
// and crash watchdog.
//   D12 — --profile isolated spins dedicated user-data-dir
//   D13 — macOS-native Chrome launch path

import { describe, it, expect, vi } from "vitest";
import {
  findChrome,
  buildChromeArgs,
  ChromeNotFoundError,
} from "./chrome-launcher.mjs";

describe("findChrome", () => {
  it("returns CHROME_BIN if set and exists", () => {
    const found = findChrome({
      env: { CHROME_BIN: "/custom/chrome" },
      existsSync: (p) => p === "/custom/chrome",
    });
    expect(found).toBe("/custom/chrome");
  });

  it("finds Chrome at default macOS path", () => {
    const defaultPath =
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const found = findChrome({
      env: {},
      existsSync: (p) => p === defaultPath,
    });
    expect(found).toBe(defaultPath);
  });

  it("throws ChromeNotFoundError when no binary found", () => {
    expect(() =>
      findChrome({ env: {}, existsSync: () => false })
    ).toThrow(ChromeNotFoundError);
  });
});

describe("buildChromeArgs", () => {
  it("--profile existing: just the URL", () => {
    const args = buildChromeArgs({
      url: "https://example.com",
      profile: "existing",
    });
    expect(args).toEqual(["https://example.com"]);
  });

  it("--profile isolated: includes user-data-dir, password-store, no --load-extension", () => {
    const args = buildChromeArgs({
      url: "chrome://extensions",
      profile: "isolated",
      userDataDir: "/tmp/deskcheck-xyz",
      debuggingPort: 0,
    });
    expect(args).toContain("--user-data-dir=/tmp/deskcheck-xyz");
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
    expect(args).toContain("--password-store=basic");
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("chrome://extensions");
    // Stable Chrome blocks --load-extension; user loads manually then we navigate via CDP
    expect(args.some(a => a.includes("--load-extension"))).toBe(false);
  });
});
