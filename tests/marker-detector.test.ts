// Acceptance tests for feature #14 phase 2 — content script marker detector.
//
// Pins that the marker-detector content script (at document_start):
//   - D5 — detects `#_deskcheck=ID:TOKEN:PORT:v1` and sends MARKER_DETECTED
//   - D6 — strips the marker via history.replaceState
//   - D7 — passes the marker to the service worker
//
// Tests inject deps directly — no jsdom needed.

import { describe, it, expect, vi } from "vitest";
import { detectMarker } from "../src/content/marker-detector";

function makeDeps(href: string) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const replaceState = vi.fn();
  return { deps: { href, replaceState, sendMessage }, sendMessage, replaceState };
}

describe("marker-detector content script", () => {
  it("D5: detects marker and sends MARKER_DETECTED message", () => {
    const sid = "detect-test";
    const token = "d".repeat(64);
    const { deps, sendMessage } = makeDeps(
      `https://example.com/#_deskcheck=${sid}:${token}:8080:v1`
    );

    const detected = detectMarker(deps);

    expect(detected).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "MARKER_DETECTED",
        marker: expect.objectContaining({
          sessionId: sid,
          token,
          port: 8080,
        }),
      })
    );
  });

  it("D6: strips marker from visible URL via replaceState", () => {
    const sid = "strip-test";
    const token = "e".repeat(64);
    const { deps, replaceState } = makeDeps(
      `https://example.com/#_deskcheck=${sid}:${token}:9999:v1`
    );

    detectMarker(deps);

    expect(replaceState).toHaveBeenCalled();
    const cleanUrl = replaceState.mock.calls[0][2];
    expect(cleanUrl).not.toContain("_deskcheck=");
    expect(cleanUrl).not.toContain(token);
    expect(cleanUrl).toBe("https://example.com/");
  });

  it("D7: passes marker fields to service worker", () => {
    const sid = "fields-test";
    const token = "f".repeat(64);
    const { deps, sendMessage } = makeDeps(
      `https://example.com/#_deskcheck=${sid}:${token}:12345:v1`
    );

    detectMarker(deps);

    const sentMsg = sendMessage.mock.calls[0][0] as any;
    expect(sentMsg.type).toBe("MARKER_DETECTED");
    expect(sentMsg.marker.sessionId).toBe(sid);
    expect(sentMsg.marker.token).toBe(token);
    expect(sentMsg.marker.port).toBe(12345);
  });

  it("no-ops when no marker in hash", () => {
    const { deps, sendMessage, replaceState } = makeDeps(
      "https://example.com/#/login"
    );

    const detected = detectMarker(deps);

    expect(detected).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("preserves hash-router route when stripping marker", () => {
    const sid = "router-test";
    const token = "a".repeat(64);
    const { deps, replaceState } = makeDeps(
      `https://app.example.com/#/login&_deskcheck=${sid}:${token}:8080:v1`
    );

    detectMarker(deps);

    const cleanUrl = replaceState.mock.calls[0][2];
    expect(cleanUrl).toBe("https://app.example.com/#/login");
  });
});
