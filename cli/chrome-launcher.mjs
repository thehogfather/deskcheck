// Feature #14 phase 2 — Chrome launcher for macOS.
//
// Finds and spawns Chrome with the right flags. Exported for testability
// (tests inject fake existsSync/spawn).

import { existsSync as realExistsSync } from "node:fs";
import { spawn as realSpawn } from "node:child_process";

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

export function buildChromeArgs({ url, profile = "existing", userDataDir, distPath }) {
  if (profile === "existing") {
    return [url];
  }
  // --profile isolated
  return [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${distPath}`,
    `--disable-extensions-except=${distPath}`,
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
