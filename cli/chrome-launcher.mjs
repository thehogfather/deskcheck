// Feature #14 phase 2 — Chrome launcher for macOS.
//
// Finds and spawns Chrome with the right flags. Exported for testability
// (tests inject fake existsSync/spawn).
//
// Stable Google Chrome blocks --load-extension and --disable-extensions-except.
// For --profile isolated we pre-install the extension into the profile's
// Extensions directory so Chrome picks it up on launch with developer mode on.

import { existsSync as realExistsSync } from "node:fs";
import { spawn as realSpawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class ChromeNotFoundError extends Error {
  constructor(candidates) {
    super(
      `Chrome not found. Searched:\n${candidates.map((c) => `  ${c}`).join("\n")}\nSet CHROME_BIN to the path of your Chrome binary.`,
    );
    this.name = "ChromeNotFoundError";
  }
}

const DEFAULT_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
];

export function findChrome({ env = process.env, existsSync = realExistsSync } = {}) {
  const envBin = env.CHROME_BIN;
  if (envBin && existsSync(envBin)) return envBin;

  for (const c of DEFAULT_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  throw new ChromeNotFoundError(envBin ? [envBin, ...DEFAULT_CANDIDATES] : DEFAULT_CANDIDATES);
}

export function buildChromeArgs({ url, profile = "existing", userDataDir, debuggingPort }) {
  if (profile === "existing") {
    return [url];
  }
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
  ];
  if (debuggingPort != null) {
    args.push(`--remote-debugging-port=${debuggingPort}`);
  }
  args.push(url);
  return args;
}

/**
 * Wait for Chrome to write DevToolsActivePort and return the debugging port.
 */
export async function waitForDebuggingPort(userDataDir, timeoutMs = 10000) {
  const filePath = join(userDataDir, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(filePath, "utf8");
      const port = parseInt(content.split("\n")[0], 10);
      if (port > 0) return port;
    } catch {
      // not yet written
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error("Chrome did not write DevToolsActivePort within timeout");
}

/**
 * Navigate an existing Chrome tab to a new URL via CDP over HTTP.
 */
export async function cdpNavigate(debugPort, url) {
  const targetsRes = await fetch(`http://127.0.0.1:${debugPort}/json`);
  const targets = await targetsRes.json();
  const page = targets.find(t => t.type === "page");
  if (!page) throw new Error("No page target found");

  const activateRes = await fetch(
    `http://127.0.0.1:${debugPort}/json/activate/${page.id}`,
    { method: "POST" },
  );
  if (!activateRes.ok) throw new Error("Failed to activate tab");

  // Navigate via HTTP endpoint
  const navRes = await fetch(
    `http://127.0.0.1:${debugPort}/json/navigate?url=${encodeURIComponent(url)}`,
  );
  // Some Chrome versions don't support /json/navigate, fall back to new tab
  if (!navRes.ok) {
    await fetch(
      `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    );
  }
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
