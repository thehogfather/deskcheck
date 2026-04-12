// Feature #14 phase 2 — Chrome launcher for macOS.
//
// Stable Google Chrome blocks --load-extension. For --profile isolated
// we use Playwright's bundled Chrome for Testing (which supports it),
// falling back to system Chromium or Chrome Canary.

import { existsSync as realExistsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { spawn as realSpawn } from "node:child_process";
import { join } from "node:path";

export class ChromeNotFoundError extends Error {
  constructor(candidates) {
    super(
      `Chrome not found. Searched:\n${candidates.map((c) => `  ${c}`).join("\n")}\nSet CHROME_BIN to the path of your Chrome binary.`,
    );
    this.name = "ChromeNotFoundError";
  }
}

const SYSTEM_CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

// Browsers that support --load-extension (not blocked like stable Chrome)
const EXTENSION_CAPABLE_CANDIDATES = [
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

const PLAYWRIGHT_CACHE = join(
  process.env.HOME || "",
  "Library/Caches/ms-playwright",
);

/**
 * Find the latest Playwright Chrome for Testing binary.
 * Playwright stores browsers at ~/Library/Caches/ms-playwright/chromium-<rev>/
 */
async function findPlaywrightChrome(existsSync = realExistsSync) {
  if (!existsSync(PLAYWRIGHT_CACHE)) return null;
  let entries;
  try {
    entries = await readdir(PLAYWRIGHT_CACHE);
  } catch {
    return null;
  }
  const chromiumDirs = entries
    .filter((e) => e.startsWith("chromium-"))
    .sort((a, b) => {
      const revA = parseInt(a.split("-")[1], 10);
      const revB = parseInt(b.split("-")[1], 10);
      return revB - revA;
    });

  for (const dir of chromiumDirs) {
    // Chrome for Testing layout (newer Playwright)
    const cftBin = join(
      PLAYWRIGHT_CACHE, dir,
      "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    if (existsSync(cftBin)) return cftBin;
    // Older Playwright Chromium layout
    const chromiumBin = join(
      PLAYWRIGHT_CACHE, dir,
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    );
    if (existsSync(chromiumBin)) return chromiumBin;
  }
  return null;
}

/**
 * Find Chrome for --profile existing (any Chrome works).
 */
export function findChrome({ env = process.env, existsSync = realExistsSync } = {}) {
  const envBin = env.CHROME_BIN;
  if (envBin && existsSync(envBin)) return envBin;

  for (const c of SYSTEM_CHROME_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  throw new ChromeNotFoundError(envBin ? [envBin, ...SYSTEM_CHROME_CANDIDATES] : SYSTEM_CHROME_CANDIDATES);
}

/**
 * Find a Chrome binary that supports --load-extension (for --profile isolated).
 * Stable Chrome blocks the flag; Chrome for Testing, Chromium, and Canary don't.
 */
export async function findExtensionCapableChrome({ env = process.env, existsSync = realExistsSync } = {}) {
  const envBin = env.CHROME_BIN;
  if (envBin && existsSync(envBin)) return envBin;

  // Playwright's Chrome for Testing is the most reliable option
  const pwChrome = await findPlaywrightChrome(existsSync);
  if (pwChrome) return pwChrome;

  for (const c of EXTENSION_CAPABLE_CANDIDATES) {
    if (existsSync(c)) return c;
  }

  const all = [...EXTENSION_CAPABLE_CANDIDATES];
  throw new ChromeNotFoundError(all);
}

export function buildChromeArgs({ url, profile = "existing", userDataDir, distPath }) {
  if (profile === "existing") {
    return [url];
  }
  return [
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${distPath}`,
    `--load-extension=${distPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    url,
  ];
}

export function launchChrome({
  chromeBin,
  args,
  spawn = realSpawn,
}) {
  const child = spawn(chromeBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  return child;
}
