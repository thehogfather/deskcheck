#!/usr/bin/env node
// Feature #14 phase-1 CLI — local handoff receiver.
//
// Usage:
//   deskcheck listen --out DIR [--port N]
//   deskcheck --help
//
// Binds 127.0.0.1 (loopback only), generates a per-run bearer token, and
// accepts `POST /upload` from the DeskCheck extension with the zip as the
// request body. Writes each zip atomically to DIR/<session-id>.zip via a
// temp file + rename. Single-use per session-id (replay returns 409).
//
// Zero runtime dependencies — stdlib only (node:http, node:fs/promises,
// node:fs, node:crypto, node:path).

import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink, stat } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve, join, sep } from "node:path";

const MAX_BODY_BYTES = 200 * 1024 * 1024; // 200 MB
const SESSION_ID_REGEX = /^[A-Za-z0-9._-]{1,128}$/;
const LOOPBACK_HOST = "127.0.0.1";

const USAGE = `deskcheck — DeskCheck CLI handoff receiver (phase 1)

Usage:
  deskcheck listen --out DIR [--port N]
  deskcheck --help

Options:
  --out DIR    Directory to write received session zips to. Will be created
               if it does not already exist.
  --port N     Port to bind on 127.0.0.1. Defaults to a kernel-assigned port.
  --help       Show this message and exit.

Security:
  - Binds 127.0.0.1 only. Non-loopback interfaces cannot reach it.
  - Per-run bearer token. Each POST must present it via Authorization.
  - Single-use per session id. Replays return 409.
  - Atomic writes (tmp + rename). A crash mid-upload leaves no half-written file.
`;

/**
 * Parse process.argv into a command + flags. Returns null on unknown
 * shapes; the caller prints usage and exits.
 */
export function parseArgv(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { command: "usage" };
  if (args[0] === "--help" || args[0] === "-h") return { command: "help" };
  if (args[0] !== "listen") return { command: "unknown", raw: args };

  const flags = { out: null, port: 0 };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" && i + 1 < args.length) {
      flags.out = args[++i];
    } else if (a === "--port" && i + 1 < args.length) {
      const n = Number.parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 0 || n > 65535) {
        return { command: "unknown", raw: args };
      }
      flags.port = n;
    } else if (a === "--help" || a === "-h") {
      return { command: "help" };
    } else {
      return { command: "unknown", raw: args };
    }
  }
  if (!flags.out) return { command: "unknown", raw: args };
  return { command: "listen", out: flags.out, port: flags.port };
}

/**
 * Compare two strings in constant time. Uses Node's crypto.timingSafeEqual
 * on Buffers of equal length; returns false without leaking length via an
 * early exit when the lengths differ.
 */
function safeEqualStrings(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Still do a constant-time compare against a same-length buffer to
    // avoid leaking the length of the expected token.
    const filler = Buffer.alloc(ba.length);
    try { timingSafeEqual(ba, filler); } catch { /* no-op */ }
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/**
 * Resolve a session id into a safe destination path under outDir. Throws
 * if the resulting path escapes outDir (defence in depth on top of the
 * regex).
 */
function safeJoin(outDir, sessionId) {
  const resolved = resolve(join(outDir, `${sessionId}.zip`));
  const root = resolve(outDir);
  if (!resolved.startsWith(root + sep) && resolved !== root) {
    throw new Error("path traversal");
  }
  return resolved;
}

/**
 * Start the listener server. Exported so tests can spawn it via child
 * process; the entry at the bottom of this file wires it to process.argv.
 */
export async function startListener({ outDir, port }) {
  await mkdir(outDir, { recursive: true });

  const token = randomBytes(32).toString("hex");
  const usedSessions = new Set();

  const server = createServer((req, res) => {
    handleRequest(req, res, { outDir, token, usedSessions }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[deskcheck] unexpected handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : 0;

  return { server, token, boundPort, outDir };
}

async function handleRequest(req, res, ctx) {
  if (req.method !== "POST") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (req.url !== "/upload") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }

  // 1. Authorization: Bearer <token>
  const authHeader = req.headers["authorization"];
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  const presentedToken = authHeader.slice("Bearer ".length);
  if (!safeEqualStrings(presentedToken, ctx.token)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  // 2. Content-Type must be application/zip
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.startsWith("application/zip")) {
    res.writeHead(415, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unsupported_media_type" }));
    return;
  }

  // 3. Content-Length must be present and within budget
  const contentLength = Number.parseInt(req.headers["content-length"] ?? "", 10);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing_content_length" }));
    return;
  }
  if (contentLength > MAX_BODY_BYTES) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "payload_too_large" }));
    return;
  }

  // 4. X-DeskCheck-Session-Id header validation
  const sessionId = req.headers["x-deskcheck-session-id"];
  if (typeof sessionId !== "string" || !SESSION_ID_REGEX.test(sessionId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad_session_id" }));
    return;
  }

  // 5. Replay defence: single-use per session id
  if (ctx.usedSessions.has(sessionId)) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "duplicate_session" }));
    return;
  }

  // 6. Safe destination path (defence in depth on top of regex)
  let destPath;
  try {
    destPath = safeJoin(ctx.outDir, sessionId);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad_session_id" }));
    return;
  }

  // 7. Check destination does not already exist (if someone used `--out`
  //    against an existing dir with prior sessions, a replay from an
  //    earlier CLI run would hit the usedSessions miss but stat-hit the
  //    file on disk). Prefer 409 over overwriting.
  try {
    await stat(destPath);
    // If we reach here the file exists; 409.
    ctx.usedSessions.add(sessionId);
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "duplicate_session" }));
    return;
  } catch {
    // ENOENT — good, proceed.
  }

  // 8. Stream body to tmp file, then rename atomically.
  const tmpName = `.tmp-${sessionId}-${randomBytes(6).toString("hex")}.zip`;
  const tmpPath = join(ctx.outDir, tmpName);
  let bytesWritten = 0;
  let failed = false;

  try {
    await new Promise((resolveWrite, rejectWrite) => {
      const ws = createWriteStream(tmpPath);
      req.on("data", (chunk) => {
        bytesWritten += chunk.length;
        if (bytesWritten > contentLength) {
          failed = true;
          req.destroy(new Error("body exceeds content-length"));
          ws.destroy(new Error("body exceeds content-length"));
          return;
        }
        ws.write(chunk);
      });
      req.on("end", () => {
        ws.end();
      });
      req.on("error", (err) => {
        failed = true;
        ws.destroy(err);
        rejectWrite(err);
      });
      ws.on("finish", () => resolveWrite());
      ws.on("error", (err) => {
        failed = true;
        rejectWrite(err);
      });
    });
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "write_failed" }));
    }
    return;
  }

  if (failed || bytesWritten !== contentLength) {
    await unlink(tmpPath).catch(() => {});
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "body_length_mismatch" }));
    }
    return;
  }

  try {
    await rename(tmpPath, destPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "rename_failed" }));
    }
    return;
  }

  ctx.usedSessions.add(sessionId);
  res.writeHead(201, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: destPath }));
}

/**
 * Print the ready-line to stdout in the format the side panel's paste
 * affordance parses. Exported for testability — the default entry writes
 * to process.stdout.
 */
export function formatReadyLine({ boundPort, outDir, token }) {
  const url = `http://${LOOPBACK_HOST}:${boundPort}`;
  return [
    "deskcheck listener ready",
    `  url:   ${url}`,
    `  out:   ${resolve(outDir)}`,
    `  token: ${token}`,
    "",
    "Copy-paste into DeskCheck side panel → Attach CLI listener:",
    `  ${url} ${token}`,
    "",
  ].join("\n");
}

// ── Entry point ───────────────────────────────────────────────────────────

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("deskcheck.mjs");

if (invokedDirectly) {
  const parsed = parseArgv(process.argv);
  if (parsed.command === "help") {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (parsed.command !== "listen") {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  try {
    const { server, token, boundPort, outDir } = await startListener({
      outDir: parsed.out,
      port: parsed.port,
    });
    process.stdout.write(formatReadyLine({ boundPort, outDir, token }));
    const shutdown = () => {
      server.close(() => process.exit(0));
      // Force-exit if close() hangs on in-flight connections.
      setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    process.stderr.write(`deskcheck: failed to start listener: ${err instanceof Error ? err.message : err}\n`);
    process.exit(1);
  }
}
