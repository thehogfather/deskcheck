// Acceptance tests for feature #14 phase 2 — marker grammar parser.
//
// Pins the `parseMarker` and `stripMarker` functions from
// src/lib/handoff-marker.ts. Table-driven adversarial corpus covers:
//   - D5 — content script detects `#_deskcheck=ID:TOKEN:PORT:v1`
//   - D6 — content script strips the marker from the visible URL
//   - A6 — adversarial grammar rejection corpus
//   - A7 — marker survives existing hash routers (strip-and-preserve)
//
// Zero chrome imports — this is a pure module.

import { describe, it, expect } from "vitest";
import {
  parseMarker,
  stripMarker,
  buildMarkerFragment,
} from "../src/lib/handoff-marker";

// ── Grammar: ID:TOKEN:PORT:v1 ──

describe("parseMarker", () => {
  it("parses a well-formed marker from a hash", () => {
    const sid = "test-session-abc";
    const token = "a".repeat(64);
    const port = "54329";
    const hash = `#_deskcheck=${sid}:${token}:${port}:v1`;
    const result = parseMarker(hash);
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(sid);
    expect(result!.token).toBe(token);
    expect(result!.port).toBe(54329);
  });

  // A6 — adversarial grammar rejection
  const REJECTED_HASHES = [
    ["empty string", ""],
    ["no hash", "_deskcheck=a:b:c:v1"],
    ["wrong version", "#_deskcheck=sid:" + "a".repeat(64) + ":8080:v2"],
    ["missing version", "#_deskcheck=sid:" + "a".repeat(64) + ":8080"],
    ["missing port", "#_deskcheck=sid:" + "a".repeat(64) + ":v1"],
    ["port zero", "#_deskcheck=sid:" + "a".repeat(64) + ":0:v1"],
    ["port 99999", "#_deskcheck=sid:" + "a".repeat(64) + ":99999:v1"],
    ["port negative", "#_deskcheck=sid:" + "a".repeat(64) + ":-1:v1"],
    ["oversized sid (129 chars)", "#_deskcheck=" + "x".repeat(129) + ":" + "a".repeat(64) + ":8080:v1"],
    ["empty sid", "#_deskcheck=:" + "a".repeat(64) + ":8080:v1"],
    ["non-hex token (63 hex + G)", "#_deskcheck=sid:" + "a".repeat(63) + "G:8080:v1"],
    ["short token (32 chars)", "#_deskcheck=sid:" + "a".repeat(32) + ":8080:v1"],
    ["embedded null byte in sid", "#_deskcheck=si\x00d:" + "a".repeat(64) + ":8080:v1"],
    ["sid with path traversal", "#_deskcheck=../etc:" + "a".repeat(64) + ":8080:v1"],
    ["just _deskcheck= prefix", "#_deskcheck="],
    ["no _deskcheck prefix", "#something-else"],
    ["port not a number", "#_deskcheck=sid:" + "a".repeat(64) + ":abc:v1"],
  ] as const;

  for (const [label, hash] of REJECTED_HASHES) {
    it(`rejects: ${label}`, () => {
      expect(parseMarker(hash)).toBeNull();
    });
  }
});

describe("stripMarker", () => {
  const SID = "test-session";
  const TOKEN = "b".repeat(64);
  const MARKER_SUFFIX = `_deskcheck=${SID}:${TOKEN}:8080:v1`;

  // A7 — hash router preservation
  it("strips pure marker -> no hash", () => {
    const href = `https://example.com/#${MARKER_SUFFIX}`;
    const result = stripMarker(href);
    expect(result).not.toBeNull();
    expect(result!.cleanHref).toBe("https://example.com/");
    expect(result!.marker.sessionId).toBe(SID);
  });

  it("strips marker appended to hash route via &", () => {
    const href = `https://app.example.com/#/login&${MARKER_SUFFIX}`;
    const result = stripMarker(href);
    expect(result).not.toBeNull();
    expect(result!.cleanHref).toBe("https://app.example.com/#/login");
  });

  it("preserves complex hash route", () => {
    const href = `https://app.example.com/#/dashboard/settings?tab=profile&${MARKER_SUFFIX}`;
    const result = stripMarker(href);
    expect(result).not.toBeNull();
    expect(result!.cleanHref).toBe(
      "https://app.example.com/#/dashboard/settings?tab=profile"
    );
  });

  it("returns null when no marker present", () => {
    expect(stripMarker("https://example.com/")).toBeNull();
    expect(stripMarker("https://example.com/#/login")).toBeNull();
  });

  it("returns null for malformed marker in hash", () => {
    expect(stripMarker("https://example.com/#_deskcheck=bad")).toBeNull();
  });
});

describe("buildMarkerFragment", () => {
  it("produces a fragment that parseMarker round-trips", () => {
    const sid = "round-trip-test";
    const token = "c".repeat(64);
    const port = 12345;
    const fragment = buildMarkerFragment(sid, token, port);
    const parsed = parseMarker(fragment);
    expect(parsed).not.toBeNull();
    expect(parsed!.sessionId).toBe(sid);
    expect(parsed!.token).toBe(token);
    expect(parsed!.port).toBe(port);
  });
});
