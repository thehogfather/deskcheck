// Acceptance tests for feature #14 phase 2 — `deskcheck record` CLI subcommand.
//
// Spawns the CLI as a Node subprocess with DESKCHECK_FAKE_CHROME=1 to
// bypass findChrome/spawn. POSTs fixture zips and cancel sentinels.
//
// Matrix rows:
//   D1  — record starts listener, launches Chrome, blocks until session
//   D2  — on success prints JSON summary {session_id, path, events, screenshots, duration_s}
//   D3  — on timeout exits non-zero with structured error
//   D4  — on cancellation exits non-zero with structured error
//   A3  — forged-marker: unarmed session-id returns 403
//   A5  — listener still binds 127.0.0.1 only
//   A10 — Chrome crash mid-record -> CLI exits non-zero
//   A11 — cancel sentinel reuses Phase 1 auth checks

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { zipSync, strToU8 } from "fflate";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECORD_CLI_PATH = resolve(__dirname, "deskcheck-record.mjs");

/**
 * Spawn `deskcheck record <url>` with DESKCHECK_FAKE_CHROME=1 so the
 * Chrome launch is a no-op. Returns a handle with the listener port/token
 * parsed from stderr, plus a stop() fn.
 */
async function spawnRecord(url, { timeout = 10, outDir, extraEnv = {} } = {}) {
  const child = spawn(
    "node",
    [RECORD_CLI_PATH, url, "--timeout", String(timeout), "--out", outDir],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DESKCHECK_FAKE_CHROME: "1", ...extraEnv },
    }
  );
  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { stdoutBuf += c; });
  child.stderr.on("data", (c) => { stderrBuf += c; });

  // Wait for listener ready line from stderr
  const ready = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`no ready line in 5s\nstderr:\n${stderrBuf}`)), 5000);
    const check = () => {
      const match = stderrBuf.match(/listener http:\/\/127\.0\.0\.1:(\d+) ready/);
      if (match) {
        clearTimeout(timer);
        const port = Number(match[1]);
        // Parse token and session-id from stderr
        const tokenMatch = stderrBuf.match(/token: ([a-f0-9]{64})/);
        const sidMatch = stderrBuf.match(/session: ([\w.-]+)/);
        res({ port, token: tokenMatch?.[1], sessionId: sidMatch?.[1] });
      }
    };
    child.stderr.on("data", check);
    child.on("exit", () => { clearTimeout(timer); rej(new Error("exited early")); });
  });

  return {
    child,
    ready,
    getStdout: () => stdoutBuf,
    getStderr: () => stderrBuf,
    stop: () => new Promise((res) => {
      child.on("exit", res);
      child.kill("SIGTERM");
    }),
  };
}

/** POST a fixture zip to the listener. */
async function postZip(port, token, sessionId, zipBytes) {
  const res = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "Authorization": `Bearer ${token}`,
      "X-DeskCheck-Session-Id": sessionId,
      "Content-Length": String(zipBytes.length),
    },
    body: zipBytes,
  });
  return res;
}

/** POST a cancel sentinel to the listener. */
async function postCancel(port, token, sessionId) {
  const res = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-deskcheck-cancel",
      "Authorization": `Bearer ${token}`,
      "X-DeskCheck-Session-Id": sessionId,
    },
    body: "",
  });
  return res;
}

function makeFixtureZip(sessionId) {
  const sessionJson = JSON.stringify({
    schema_version: "1.2.0",
    session: {
      id: sessionId,
      start_time: "2026-01-01T00:00:00Z",
      end_time: "2026-01-01T00:02:23Z",
      duration_ms: 143000,
      initial_url: "https://example.com",
    },
    events: new Array(42).fill({ type: "interaction" }),
    screenshots: ["s1.png", "s2.png"],
  });
  return zipSync({
    "session.json": strToU8(sessionJson),
    "screenshots/s1.png": strToU8("fakepng1"),
    "screenshots/s2.png": strToU8("fakepng2"),
  });
}

describe("deskcheck record", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "deskcheck-record-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("D1/D2: starts listener, waits for zip, exits 0 with JSON summary", async () => {
    const handle = await spawnRecord("https://example.com", { outDir: tmpDir, timeout: 30 });
    const { port, token, sessionId } = handle.ready;

    const zipBytes = makeFixtureZip(sessionId);
    const res = await postZip(port, token, sessionId, zipBytes);
    expect(res.status).toBe(201);

    // Wait for the CLI to exit
    const exitCode = await new Promise((resolve) => {
      handle.child.on("exit", resolve);
    });
    expect(exitCode).toBe(0);

    // Verify JSON summary on stdout
    const stdout = handle.getStdout().trim();
    const summary = JSON.parse(stdout);
    expect(summary.session_id).toBe(sessionId);
    expect(summary.path).toContain(sessionId);
    expect(typeof summary.events).toBe("number");
    expect(typeof summary.screenshots).toBe("number");
    expect(typeof summary.duration_s).toBe("number");
  });

  it("D3: exits non-zero on timeout", async () => {
    const handle = await spawnRecord("https://example.com", { outDir: tmpDir, timeout: 1 });

    const exitCode = await new Promise((resolve) => {
      handle.child.on("exit", resolve);
    });
    expect(exitCode).toBe(4);

    const stdout = handle.getStdout().trim();
    const errJson = JSON.parse(stdout);
    expect(errJson.error).toBe("timeout");
  });

  it("D4: exits non-zero on cancellation", async () => {
    const handle = await spawnRecord("https://example.com", { outDir: tmpDir, timeout: 30 });
    const { port, token, sessionId } = handle.ready;

    const res = await postCancel(port, token, sessionId);
    expect(res.status).toBe(200);

    const exitCode = await new Promise((resolve) => {
      handle.child.on("exit", resolve);
    });
    expect(exitCode).toBe(5);

    const stdout = handle.getStdout().trim();
    const errJson = JSON.parse(stdout);
    expect(errJson.error).toBe("cancelled");
  });

  it("A3: rejects unarmed session-id with 403", async () => {
    const handle = await spawnRecord("https://example.com", { outDir: tmpDir, timeout: 30 });
    const { port, token } = handle.ready;

    const zipBytes = makeFixtureZip("forged-session-id");
    const res = await postZip(port, token, "forged-session-id", zipBytes);
    expect(res.status).toBe(403);

    await handle.stop();
  });

  it("A5: listener binds 127.0.0.1 only", async () => {
    const handle = await spawnRecord("https://example.com", { outDir: tmpDir, timeout: 30 });
    const { port } = handle.ready;

    // Attempt connection from non-loopback — should be refused
    const nonLoopbackConnect = () =>
      new Promise((resolve, reject) => {
        const sock = connect({ host: "0.0.0.0", port }, () => {
          sock.destroy();
          reject(new Error("connection should have been refused"));
        });
        sock.on("error", (err) => resolve(err));
      });

    const err = await nonLoopbackConnect();
    expect(err).toBeDefined();

    await handle.stop();
  });

  it("A10: Chrome crash -> CLI exits non-zero with chrome_exited error", async () => {
    // Use DESKCHECK_FAKE_CHROME_EXIT=7 to simulate Chrome crashing
    const handle = await spawnRecord("https://example.com", {
      outDir: tmpDir,
      timeout: 30,
      extraEnv: { DESKCHECK_FAKE_CHROME_EXIT: "7" },
    });

    const exitCode = await new Promise((resolve) => {
      handle.child.on("exit", resolve);
    });
    expect(exitCode).not.toBe(0);

    const stdout = handle.getStdout().trim();
    const errJson = JSON.parse(stdout);
    expect(errJson.error).toBe("chrome_exited");
  });

  it("A11: cancel sentinel without auth -> 401", async () => {
    const handle = await spawnRecord("https://example.com", { outDir: tmpDir, timeout: 30 });
    const { port, sessionId } = handle.ready;

    const res = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-deskcheck-cancel",
        "X-DeskCheck-Session-Id": sessionId,
      },
      body: "",
    });
    expect(res.status).toBe(401);

    await handle.stop();
  });
});
