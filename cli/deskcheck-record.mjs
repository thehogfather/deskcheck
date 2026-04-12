#!/usr/bin/env node
// Feature #14 phase 2 CLI — `deskcheck record <url>`.
//
// Starts a listener, launches Chrome with a marker in the hash fragment,
// and blocks until the session zip arrives or the timeout fires.
//
// Usage:
//   deskcheck record <url> [--timeout S] [--profile existing|isolated]
//                          [--json] [--port N] [--out DIR]
//
// Zero runtime deps beyond cli/deskcheck.mjs (the Phase 1 listener).

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import { startListener } from "./deskcheck.mjs";
import { findChrome, findExtensionCapableChrome, buildChromeArgs, launchChrome, waitForDebuggingPort, openPanelTab, ChromeNotFoundError } from "./chrome-launcher.mjs";

const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;

// ── Arg parsing ──

function parseRecordArgs(argv) {
  const args = argv.slice(2);
  if (args[0] === "record") args.shift();

  const flags = {
    url: null,
    timeout: 600,
    profile: "existing",
    json: false,
    port: 0,
    out: "./sessions",
  };

  let i = 0;
  // First positional = url
  if (i < args.length && !args[i].startsWith("--")) {
    flags.url = args[i++];
  }

  while (i < args.length) {
    const a = args[i];
    if (a === "--timeout" && i + 1 < args.length) {
      flags.timeout = Number.parseInt(args[++i], 10);
    } else if (a === "--profile" && i + 1 < args.length) {
      flags.profile = args[++i];
      if (flags.profile !== "existing" && flags.profile !== "isolated") {
        return null;
      }
    } else if (a === "--json") {
      flags.json = true;
    } else if (a === "--port" && i + 1 < args.length) {
      flags.port = Number.parseInt(args[++i], 10);
    } else if (a === "--out" && i + 1 < args.length) {
      flags.out = args[++i];
    } else {
      return null;
    }
    i++;
  }

  if (!flags.url) return null;
  return flags;
}

// ── Main ──

async function runRecord(flags) {
  const sessionId = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const armedSessions = new Set([sessionId]);

  let listener;
  try {
    listener = await setupRecordListener({
      outDir: flags.out,
      port: flags.port,
      token,
      sessionId,
      armedSessions,
    });
  } catch (err) {
    writeResult(flags, {
      error: "listener_bind_failed",
      message: err instanceof Error ? err.message : String(err),
      exit_code: 6,
    });
    process.exit(6);
  }

  const { server, settled, boundPort } = listener;
  const effectiveToken = token;

  if (!flags.json) {
    process.stderr.write(`deskcheck: listener http://127.0.0.1:${boundPort} ready\n`);
    process.stderr.write(`deskcheck: session: ${sessionId}\n`);
    process.stderr.write(`deskcheck: token: ${effectiveToken}\n`);
  }

  // Build marker URL
  const markerFragment = `_deskcheck=${sessionId}:${effectiveToken}:${boundPort}:v1`;
  let targetUrl;
  try {
    const parsed = new URL(flags.url);
    if (parsed.hash) {
      targetUrl = `${flags.url}&${markerFragment}`;
    } else {
      targetUrl = `${flags.url}#${markerFragment}`;
    }
  } catch {
    targetUrl = `${flags.url}#${markerFragment}`;
  }

  // Launch Chrome
  let chromeBin;
  let userDataDir = null;
  let distPath = null;

  if (flags.profile === "isolated") {
    distPath = resolve("dist");
    if (!existsSync(distPath)) {
      writeResult(flags, {
        error: "dist_not_found",
        message: "Run `make build` first — dist/ directory not found.",
        exit_code: 1,
      });
      process.exit(1);
    }
    userDataDir = await mkdtemp(join(tmpdir(), "deskcheck-isolated-"));
    // Stable Chrome blocks --load-extension; use Chrome for Testing / Chromium instead
    try {
      chromeBin = await findExtensionCapableChrome();
    } catch (err) {
      if (err instanceof ChromeNotFoundError) {
        writeResult(flags, {
          error: "chrome_not_found",
          message: "No extension-capable Chrome found. Install Playwright (`npx playwright install chromium`) or set CHROME_BIN to Chrome for Testing / Chromium / Chrome Canary.",
          exit_code: 3,
        });
        process.exit(3);
      }
      throw err;
    }
  } else {
    try {
      chromeBin = findChrome();
    } catch (err) {
      if (err instanceof ChromeNotFoundError) {
        writeResult(flags, {
          error: "chrome_not_found",
          message: err.message,
          exit_code: 3,
        });
        process.exit(3);
      }
      throw err;
    }
  }

  const chromeArgs = buildChromeArgs({
    url: targetUrl,
    profile: flags.profile,
    userDataDir,
    distPath,
  });

  // Skip Chrome launch if DESKCHECK_FAKE_CHROME is set (for testing)
  let chromeChild = null;
  if (!process.env.DESKCHECK_FAKE_CHROME) {
    chromeChild = launchChrome({ chromeBin, args: chromeArgs });

    if (!flags.json) {
      process.stderr.write(`deskcheck: launched ${flags.profile === "isolated" ? "Chrome for Testing" : "Chrome"} PID ${chromeChild.pid} against ${flags.url}\n`);
    }

    // For isolated profiles: open the DeskCheck panel as a tab via CDP
    // so the user sees it immediately without clicking the toolbar icon.
    if (flags.profile === "isolated" && userDataDir) {
      try {
        const cdpPort = await waitForDebuggingPort(userDataDir);
        if (cdpPort) {
          // Wait for the extension to load and process the marker
          await new Promise(r => setTimeout(r, 2000));
          await openPanelTab(cdpPort);
          if (!flags.json) {
            process.stderr.write(`deskcheck: opened DeskCheck panel — click Start to begin recording\n`);
          }
        }
      } catch {
        // Non-fatal — user can still click the toolbar icon
      }
    }

    if (!flags.json) {
      if (flags.profile !== "isolated") {
        process.stderr.write(`deskcheck:   click the DeskCheck toolbar action when the page loads\n`);
      }
      process.stderr.write(`deskcheck:   reproduce the bug, then click Stop in the panel\n`);
    }
  } else {
    // Fake Chrome for testing: if DESKCHECK_FAKE_CHROME_EXIT is set,
    // simulate Chrome crashing after a brief delay.
    const exitCode = process.env.DESKCHECK_FAKE_CHROME_EXIT;
    if (exitCode) {
      setTimeout(() => {
        handleChromeExit(Number(exitCode), flags, listener);
      }, 100);
    }
  }

  // Chrome crash watchdog
  if (chromeChild) {
    chromeChild.on("exit", (code) => {
      handleChromeExit(code, flags, listener);
    });
  }

  // Wait for session or timeout
  const startTime = Date.now();
  const result = await Promise.race([
    settled,
    timeout(flags.timeout * 1000).then(() => ({ kind: "timeout" })),
  ]);

  // Cleanup
  server.close();
  if (chromeChild && flags.profile === "isolated") {
    try { chromeChild.kill(); } catch { /* already exited */ }
  }
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  if (result.kind === "ok") {
    // Read session.json from the zip to populate the summary
    let summary = {
      session_id: sessionId,
      path: result.path,
      events: 0,
      screenshots: 0,
      duration_s: 0,
    };
    try {
      const zipPath = result.path;
      // Parse the zip to extract session.json for summary fields
      summary = await extractSummaryFromZip(zipPath, sessionId);
    } catch {
      // Fall back to minimal summary
    }
    writeResult(flags, summary);
    process.exit(0);
  } else if (result.kind === "cancelled") {
    writeResult(flags, {
      error: "cancelled",
      message: "session cancelled by user (Discard clicked)",
      exit_code: 5,
    });
    process.exit(5);
  } else if (result.kind === "timeout") {
    writeResult(flags, {
      error: "timeout",
      message: `no session received within ${flags.timeout}s`,
      exit_code: 4,
    });
    process.exit(4);
  } else if (result.kind === "chrome_exited") {
    writeResult(flags, {
      error: "chrome_exited",
      message: `Chrome exited with code ${result.code}`,
      exit_code: 3,
    });
    process.exit(3);
  }
}

function handleChromeExit(code, flags, handler) {
  if (!handler.isSettled) {
    handler.resolve({ kind: "chrome_exited", code });
  }
}

function writeResult(flags, obj) {
  if (flags.json || !process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } else {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }
}

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractSummaryFromZip(zipPath, sessionId) {
  // Minimal zip parsing: read the file and use fflate if available,
  // or just return basic summary
  try {
    const zipBuf = await readFile(zipPath);
    // Simple approach: find session.json in the zip
    // Use dynamic import of fflate for decompression
    const { unzipSync } = await import("fflate");
    const files = unzipSync(new Uint8Array(zipBuf));
    const sessionJsonBytes = files["session.json"];
    if (sessionJsonBytes) {
      const decoder = new TextDecoder();
      const sessionData = JSON.parse(decoder.decode(sessionJsonBytes));
      const session = sessionData.session || sessionData;
      return {
        session_id: session.id || sessionId,
        path: zipPath,
        events: Array.isArray(sessionData.events) ? sessionData.events.length : 0,
        screenshots: Array.isArray(sessionData.screenshots) ? sessionData.screenshots.length : 0,
        duration_s: session.duration_ms ? Math.round(session.duration_ms / 1000) : 0,
      };
    }
  } catch {
    // fflate not available or parse error
  }
  return {
    session_id: sessionId,
    path: zipPath,
    events: 0,
    screenshots: 0,
    duration_s: 0,
  };
}

async function setupRecordListener({ outDir, port, token, sessionId, armedSessions, flags }) {
  const { createServer } = await import("node:http");
  const { createWriteStream } = await import("node:fs");
  const { mkdir, rename, unlink, stat } = await import("node:fs/promises");
  const { randomBytes: rb, timingSafeEqual } = await import("node:crypto");
  const { resolve: resolvePath, join: joinPath, sep } = await import("node:path");

  await mkdir(outDir, { recursive: true });

  const usedSessions = new Set();
  const MAX_BODY = 200 * 1024 * 1024;
  const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
  const LOOPBACK = "127.0.0.1";

  let resolveSettled;
  let isSettled = false;
  const settled = new Promise((r) => { resolveSettled = r; });

  function onSettled(result) {
    if (isSettled) return;
    isSettled = true;
    resolveSettled(result);
  }

  function safeEq(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) {
      const filler = Buffer.alloc(ba.length);
      try { timingSafeEqual(ba, filler); } catch { /* no-op */ }
      return false;
    }
    return timingSafeEqual(ba, bb);
  }

  function safeJoin(dir, sid) {
    const resolved = resolvePath(joinPath(dir, `${sid}.zip`));
    const root = resolvePath(dir);
    if (!resolved.startsWith(root + sep) && resolved !== root) {
      throw new Error("path traversal");
    }
    return resolved;
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/upload") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const authHeader = req.headers["authorization"];
      if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (!safeEq(authHeader.slice("Bearer ".length), token)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      const sid = req.headers["x-deskcheck-session-id"];
      if (typeof sid !== "string" || !SID_RE.test(sid)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_session_id" }));
        return;
      }

      if (!armedSessions.has(sid)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unarmed_session" }));
        return;
      }

      if (usedSessions.has(sid)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "duplicate_session" }));
        return;
      }

      const ct = req.headers["content-type"];

      // Cancel sentinel
      if (typeof ct === "string" && ct.startsWith("application/x-deskcheck-cancel")) {
        usedSessions.add(sid);
        onSettled({ kind: "cancelled", sessionId: sid });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, cancelled: true }));
        return;
      }

      if (typeof ct !== "string" || !ct.startsWith("application/zip")) {
        res.writeHead(415, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_media_type" }));
        return;
      }

      const cl = Number.parseInt(req.headers["content-length"] ?? "", 10);
      if (!Number.isFinite(cl) || cl < 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing_content_length" }));
        return;
      }
      if (cl > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "payload_too_large" }));
        return;
      }

      let destPath;
      try { destPath = safeJoin(outDir, sid); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad_session_id" }));
        return;
      }

      try { await stat(destPath); usedSessions.add(sid);
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "duplicate_session" }));
        return;
      } catch { /* ENOENT */ }

      const tmpName = `.tmp-${sid}-${rb(6).toString("hex")}.zip`;
      const tmpPath = joinPath(outDir, tmpName);
      let written = 0;
      let failed = false;

      try {
        await new Promise((rw, rej) => {
          const ws = createWriteStream(tmpPath);
          req.on("data", (chunk) => {
            written += chunk.length;
            if (written > cl) { failed = true; req.destroy(); ws.destroy(); return; }
            ws.write(chunk);
          });
          req.on("end", () => ws.end());
          req.on("error", (e) => { failed = true; ws.destroy(e); rej(e); });
          ws.on("finish", () => rw());
          ws.on("error", (e) => { failed = true; rej(e); });
        });
      } catch {
        await unlink(tmpPath).catch(() => {});
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "write_failed" }));
        }
        return;
      }

      if (failed || written !== cl) {
        await unlink(tmpPath).catch(() => {});
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "body_length_mismatch" }));
        }
        return;
      }

      try { await rename(tmpPath, destPath); } catch {
        await unlink(tmpPath).catch(() => {});
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rename_failed" }));
        }
        return;
      }

      usedSessions.add(sid);
      onSettled({ kind: "ok", sessionId: sid, path: destPath });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: destPath }));
    } catch (err) {
      console.error("[deskcheck] handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
  });

  await new Promise((rl, rj) => {
    server.once("error", rj);
    server.listen(port, LOOPBACK, () => { server.off("error", rj); rl(); });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    server,
    settled,
    isSettled,
    resolve: resolveSettled,
    boundPort,
  };
}

// ── Heartbeat ──
function startHeartbeat(flags, startTime) {
  if (flags.json) return null;
  return setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const remaining = flags.timeout - elapsed;
    process.stderr.write(`deskcheck:   waiting... (${elapsed}s elapsed, ${remaining}s remaining)\n`);
  }, 12000);
}

// ── Entry point ──

const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith("deskcheck-record.mjs") ||
  (process.argv[1].endsWith("deskcheck.mjs") && process.argv[2] === "record")
);

if (invokedDirectly) {
  const flags = parseRecordArgs(process.argv);
  if (!flags) {
    process.stderr.write(
      "Usage: deskcheck record <url> [--timeout S] [--profile existing|isolated] [--json] [--port N] [--out DIR]\n",
    );
    process.exit(2);
  }
  runRecord(flags).catch((err) => {
    process.stderr.write(`deskcheck: fatal: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  });
}

export { parseRecordArgs, runRecord };
