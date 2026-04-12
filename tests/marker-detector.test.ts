// @vitest-environment jsdom
//
// Acceptance tests for feature #14 phase 2 — content script marker detector.
//
// Pins that the marker-detector content script (at document_start):
//   - D5 — detects `#_deskcheck=ID:TOKEN:PORT:v1` and sends MARKER_DETECTED
//   - D6 — strips the marker via history.replaceState
//   - D7 — passes the marker to the service worker
//
// Uses jsdom with a stubbed chrome global.

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("marker-detector content script", () => {
  let sendMessageMock: ReturnType<typeof vi.fn>;
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendMessageMock = vi.fn().mockResolvedValue(undefined);
    (globalThis as any).chrome = {
      runtime: { sendMessage: sendMessageMock },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
    replaceStateSpy = vi.spyOn(history, "replaceState");
    vi.resetModules();
  });

  function setLocationHash(href: string) {
    // jsdom location can be set via Object.defineProperty
    Object.defineProperty(window, "location", {
      value: new URL(href),
      writable: true,
      configurable: true,
    });
  }

  it("D5: detects marker and sends MARKER_DETECTED message", async () => {
    const sid = "detect-test";
    const token = "d".repeat(64);
    setLocationHash(`https://example.com/#_deskcheck=${sid}:${token}:8080:v1`);

    await import("../src/content/marker-detector");

    expect(sendMessageMock).toHaveBeenCalledWith(
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

  it("D6: strips marker from visible URL via replaceState", async () => {
    const sid = "strip-test";
    const token = "e".repeat(64);
    setLocationHash(`https://example.com/#_deskcheck=${sid}:${token}:9999:v1`);

    await import("../src/content/marker-detector");

    expect(replaceStateSpy).toHaveBeenCalled();
    const [, , cleanUrl] = replaceStateSpy.mock.calls[0];
    expect(String(cleanUrl)).not.toContain("_deskcheck=");
    expect(String(cleanUrl)).not.toContain(token);
  });

  it("D7: passes marker fields to service worker", async () => {
    const sid = "fields-test";
    const token = "f".repeat(64);
    setLocationHash(`https://example.com/#_deskcheck=${sid}:${token}:12345:v1`);

    await import("../src/content/marker-detector");

    const sentMsg = sendMessageMock.mock.calls[0][0];
    expect(sentMsg.type).toBe("MARKER_DETECTED");
    expect(sentMsg.marker.sessionId).toBe(sid);
    expect(sentMsg.marker.token).toBe(token);
    expect(sentMsg.marker.port).toBe(12345);
  });

  it("no-ops when no marker in hash", async () => {
    setLocationHash("https://example.com/#/login");

    await import("../src/content/marker-detector");

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("preserves hash-router route when stripping marker", async () => {
    const sid = "router-test";
    const token = "a".repeat(64);
    setLocationHash(
      `https://app.example.com/#/login&_deskcheck=${sid}:${token}:8080:v1`
    );

    await import("../src/content/marker-detector");

    const [, , cleanUrl] = replaceStateSpy.mock.calls[0];
    expect(String(cleanUrl)).toBe("https://app.example.com/#/login");
  });
});
