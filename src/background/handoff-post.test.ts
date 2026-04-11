import { describe, it, expect, vi } from "vitest";
import { performHandoff, type FetchLike } from "./handoff-post";
import type { HandoffConfig } from "../lib/handoff";

// Unit tests for performHandoff. Pins matrix rows S5 (fetch throw →
// transport_error), S6 (401 → rejected), S7 (201 → ok), S8 (redirect →
// transport_error), S9 (timeout via AbortController).

const CONFIG: HandoffConfig = {
  listener_url: "http://127.0.0.1:54329",
  token: "0123456789abcdef0123456789abcdef",
  created_at: "2026-04-11T22:00:00.000Z",
};

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]); // "PK\x03\x04\x00"
const SESSION_ID = "sess-unit-test";

describe("performHandoff (S5–S9)", () => {
  it("S7 — returns ok on 201 response", async () => {
    const fetchImpl: FetchLike = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const result = await performHandoff(CONFIG, ZIP, SESSION_ID, fetchImpl);
    expect(result).toEqual({ kind: "ok" });

    // Pin the request shape exactly.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://127.0.0.1:54329/upload");
    expect((init as RequestInit).method).toBe("POST");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("Content-Type")).toBe("application/zip");
    expect(headers.get("Authorization")).toBe(`Bearer ${CONFIG.token}`);
    expect(headers.get("X-DeskCheck-Session-Id")).toBe(SESSION_ID);
    expect((init as RequestInit).redirect).toBe("error");
    // Body is the raw zip bytes (implementations may pass through as
    // BufferSource — we just assert it's defined).
    expect((init as RequestInit).body).toBeDefined();
  });

  it("S7 — returns ok on 200 response (any 2xx)", async () => {
    const fetchImpl: FetchLike = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 200 }));
    const result = await performHandoff(CONFIG, ZIP, SESSION_ID, fetchImpl);
    expect(result).toEqual({ kind: "ok" });
  });

  it("S6 — returns rejected on 401 response", async () => {
    const fetchImpl: FetchLike = vi
      .fn()
      .mockResolvedValue(new Response("{\"error\":\"unauthorized\"}", { status: 401 }));
    const result = await performHandoff(CONFIG, ZIP, SESSION_ID, fetchImpl);
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.status).toBe(401);
    }
  });

  it("S6 — returns rejected on 413 (body too large)", async () => {
    const fetchImpl: FetchLike = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 413 }));
    const result = await performHandoff(CONFIG, ZIP, SESSION_ID, fetchImpl);
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.status).toBe(413);
    }
  });

  it("S5 — returns transport_error when fetch throws (ECONNREFUSED)", async () => {
    const fetchImpl: FetchLike = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await performHandoff(CONFIG, ZIP, SESSION_ID, fetchImpl);
    expect(result.kind).toBe("transport_error");
    if (result.kind === "transport_error") {
      expect(result.reason).toContain("ECONNREFUSED");
    }
  });

  it("S8 — returns transport_error when fetch throws on redirect (redirect: error)", async () => {
    // A cross-origin redirect with `redirect: "error"` causes fetch to
    // reject. We simulate that by throwing a TypeError with a redirect
    // message — which is exactly what the Fetch spec says happens.
    const fetchImpl: FetchLike = vi
      .fn()
      .mockRejectedValue(new TypeError("redirect mode is set to error"));
    const result = await performHandoff(CONFIG, ZIP, SESSION_ID, fetchImpl);
    expect(result.kind).toBe("transport_error");
    if (result.kind === "transport_error") {
      expect(result.reason).toMatch(/redirect/);
    }
  });

  it("S9 — aborts via AbortController when the listener is unresponsive", async () => {
    vi.useFakeTimers();
    try {
      // Never-resolving fetchImpl — simulates a stuck listener.
      const fetchImpl: FetchLike = vi.fn().mockImplementation(
        (_url, init) =>
          new Promise((_, reject) => {
            // Hook into the signal so when the controller aborts, we reject.
            (init as RequestInit).signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );
      const resultPromise = performHandoff(CONFIG, ZIP, SESSION_ID, fetchImpl);
      // Advance past the 30s timeout.
      await vi.advanceTimersByTimeAsync(30_000 + 100);
      const result = await resultPromise;
      expect(result.kind).toBe("transport_error");
      if (result.kind === "transport_error") {
        expect(result.reason).toMatch(/abort/i);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
